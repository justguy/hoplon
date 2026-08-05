/**
 * tests/transport/http.session.test.ts — packaged HTTP session surface proof.
 *
 * Exercises `POST /session/*` on createHoplonHttpServer through
 * fastify.inject() so the full t-062 contract holds over HTTP:
 *
 *   - PASS branch: start → preflight → createSnapshot → markEdited → audit →
 *     close advances state and lands the session at `audited_pass` before
 *     eviction.
 *   - BLOCK branch: a BLOCK audit transitions to `audited_block`, revert
 *     restores the contracted files, extractRollbackTemplate emits skeletons
 *     and advances to `rollback_extracted`.
 *   - Error envelopes: SessionTransportError → 400/404 with stable shape
 *     `{ error: { class, kind, message, correlationId } }`.
 *   - Engine routes (e.g. /health) still respond on the same server, proving
 *     the session surface is additive rather than replacing engine-RPC.
 *
 * Uses a mock engine so the test is hermetic and focused on the transport
 * contract. Real-engine behavior is proved in tests/session/integration and
 * the selfhost proofs.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import type { FastifyInstance } from 'fastify';
import {
  MANIFEST,
  PASS_AUDIT,
  BLOCK_AUDIT,
  BLOCK_PREFLIGHT,
  ROLLBACK_TEMPLATE,
  SNAPSHOT_REF_ID,
  makeMockEngine,
} from '../session/helpers.js';

interface BuildServerOptions {
  auditResult?: AuditResult;
  fs?: HoplonFsAdapter;
  engineOverrides?: Partial<HoplonEngine>;
}

async function buildServer(
  opts: BuildServerOptions = {},
): Promise<{
  server: FastifyInstance;
  registry: SessionRegistry;
  dispose: () => Promise<void>;
}> {
  const engine = makeMockEngine({
    auditDiff: async () => opts.auditResult ?? PASS_AUDIT,
    health: async () => ({
      engineId: 'mock-engine',
      status: 'ok',
      version: '0.0.0-test',
      startedAt: '2026-04-19T00:00:00Z',
      capabilities: [],
    }),
    ...opts.engineOverrides,
  });
  const registry = createSessionRegistry({
    engine,
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
  });
  const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
  return {
    server,
    registry,
    dispose: async () => {
      await server.close();
      registry.dispose();
    },
  };
}

async function post<T = unknown>(
  server: FastifyInstance,
  url: string,
  payload: unknown,
): Promise<{ statusCode: number; body: T }> {
  const response = await server.inject({ method: 'POST', url, payload });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as T };
}

describe('HTTP session transport surface (t-062)', () => {
  it('PASS branch round-trips through /session/* via fastify.inject', async () => {
    const { server, registry, dispose } = await buildServer({ auditResult: PASS_AUDIT });
    try {
      const start = await post<{ session: { sessionId: string }; state: string }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      expect(start.statusCode).toBe(200);
      const sessionId = start.body.session.sessionId;
      expect(start.body.state).toBe('created');

      const preflight = await post<{ state: string }>(server, '/session/preflight', {
        sessionId,
      });
      expect(preflight.statusCode).toBe(200);
      expect(preflight.body.state).toBe('preflighted_pass');

      const snapshot = await post<{
        state: string;
        data: { snapshotRef: { id: string } };
      }>(server, '/session/createSnapshot', { sessionId });
      expect(snapshot.body.state).toBe('snapshotted');
      expect(snapshot.body.data.snapshotRef.id).toMatch(/^sha256:/);

      const marked = await post<{
        state: string;
        data: { overlayRefresh: { status: string; inputSource: string } };
      }>(server, '/session/markEdited', {
        sessionId,
        files: ['src/foo.ts'],
      });
      expect(marked.body.state).toBe('edited');
      expect(marked.body.data.overlayRefresh.status).toBe('UNAVAILABLE');
      expect(marked.body.data.overlayRefresh.inputSource).toBe('failure_mask');

      const audit = await post<{
        state: string;
        data: { result: { status: string } };
      }>(server, '/session/audit', { sessionId });
      expect(audit.body.state).toBe('audited_pass');
      expect(audit.body.data.result.status).toBe('PASS');

      const list = await server.inject({ method: 'GET', url: '/session/list' });
      expect(list.statusCode).toBe(200);
      const listed = JSON.parse(list.body) as {
        sessions: Array<{ sessionId: string }>;
      };
      expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);

      const closed = await post<{ state: string; data: { closed: boolean } }>(
        server,
        '/session/close',
        { sessionId },
      );
      expect(closed.body.state).toBe('closed');
      expect(closed.body.data.closed).toBe(true);
      expect(registry.get(sessionId)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('BLOCK branch: /session/audit → BLOCK, revert + extractRollbackTemplate advance', async () => {
    const { server, dispose } = await buildServer({ auditResult: BLOCK_AUDIT });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;

      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });
      await post(server, '/session/markEdited', { sessionId, files: ['src/foo.ts'] });

      const audit = await post<{ state: string; data: { result: { status: string } } }>(
        server,
        '/session/audit',
        { sessionId },
      );
      expect(audit.body.state).toBe('audited_block');
      expect(audit.body.data.result.status).toBe('BLOCK');

      const revert = await post<{
        state: string;
        data: { result: { reverted: string[] } };
      }>(server, '/session/revert', { sessionId });
      expect(revert.body.state).toBe('reverted');
      expect(revert.body.data.result.reverted).toEqual(['src/foo.ts']);

      const template = await post<{
        state: string;
        data: { template: { files: Array<{ path: string }> } };
      }>(server, '/session/extractRollbackTemplate', { sessionId });
      expect(template.body.state).toBe('rollback_extracted');
      expect(template.body.data.template.files[0]?.path).toBe('src/foo.ts');
    } finally {
      await dispose();
    }
  });

  it('session_not_found → 404 with SessionTransportError envelope', async () => {
    const { server, dispose } = await buildServer();
    try {
      const res = await post<{ error: { class: string; kind: string; correlationId: string } }>(
        server,
        '/session/preflight',
        { sessionId: 'ghost-session' },
      );
      expect(res.statusCode).toBe(404);
      expect(res.body.error.class).toBe('SessionTransportError');
      expect(res.body.error.kind).toBe('session_not_found');
      expect(res.body.error.correlationId).toBe('ghost-session');
    } finally {
      await dispose();
    }
  });

  it('invalid body → 400 with SessionTransportError envelope', async () => {
    const { server, dispose } = await buildServer();
    try {
      const res = await post<{ error: { class: string; kind: string } }>(
        server,
        '/session/preflight',
        { sessionId: '' },
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error.class).toBe('SessionTransportError');
      expect(res.body.error.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });

  it('duplicate explicit sessionId on /session/start → 400 invalid_request', async () => {
    const { server, dispose } = await buildServer();
    try {
      const payload = { manifest: MANIFEST, sessionId: 'hoplon-session-fixed' };
      const first = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        payload,
      );
      expect(first.statusCode).toBe(200);

      const duplicate = await post<{
        error: { class: string; kind: string; correlationId: string };
      }>(server, '/session/start', {
        manifest: { ...MANIFEST, runId: 'run-session-duplicate' },
        sessionId: 'hoplon-session-fixed',
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.body.error.class).toBe('SessionTransportError');
      expect(duplicate.body.error.kind).toBe('invalid_request');
      expect(duplicate.body.error.correlationId).toBe('hoplon-session-fixed');
    } finally {
      await dispose();
    }
  });

  it('POST /session/start rejects an invalid priorRepairContext', async () => {
    const { server, dispose } = await buildServer();
    try {
      const res = await post<{
        error: { class: string; kind: string; message: string };
      }>(server, '/session/start', {
        manifest: MANIFEST,
        priorRepairContext: {
          repairContextSchemaVersion: 1,
          correlationId: MANIFEST.correlationId,
          projectId: MANIFEST.projectId,
          runId: MANIFEST.runId,
          failedAttempt: {
            sessionId: 'hoplon-session-prev',
            attemptNumber: 1,
            snapshotRef: SNAPSHOT_REF_ID,
            failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
            executionId: null,
            attemptId: null,
            auditRef: null,
          },
          auditResult: PASS_AUDIT,
          rollbackTemplate: ROLLBACK_TEMPLATE,
          priorSessionHistory: [
            { op: 'created', fromState: 'created', toState: 'created', timestampMs: 1 },
          ],
          nextAttempt: {
            attemptNumber: 7,
            baselineSnapshotRef: 'sha256:wrong',
          },
          generatedAt: '2026-04-20T12:00:00.000Z',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.class).toBe('SessionTransportError');
      expect(res.body.error.kind).toBe('invalid_request');
      expect(res.body.error.message).toContain('priorRepairContext');
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits writes through the adapter and advances to edited (t-063)', async () => {
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const content = 'export const http_applied = true;\n';
      const applied = await post<{
        state: string;
        data: { changedFiles: string[]; bytesWritten: number };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content }],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/foo.ts']);
      expect(applied.body.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(content);
    } finally {
      await dispose();
    }
  });

  it('POST /session/createSnapshot preserves invalid_state_transition as SessionError', async () => {
    const { server, dispose } = await buildServer();
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;

      const res = await post<{
        error: {
          class: string;
          kind: string;
          message: string;
          correlationId: string;
          details: { recoveryClass: string; from: string; attempted: string; allowedStates: string[] };
        };
      }>(
        server,
        '/session/createSnapshot',
        { sessionId },
      );
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('invalid_state_transition');
      expect(res.body.error.correlationId).toBe(sessionId);
      expect(res.body.error.details).toEqual({
        recoveryClass: 'inspect_state',
        from: 'created',
        attempted: 'createSnapshot',
        detail: 'legal states: preflighted_pass',
        allowedStates: ['preflighted_pass'],
      });
    } finally {
      await dispose();
    }
  });

  it('POST /session/createSnapshot preserves preflight_not_passed as SessionError', async () => {
    const { server, dispose } = await buildServer({
      engineOverrides: { preflight: async () => BLOCK_PREFLIGHT },
    });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      const preflight = await post<{ state: string }>(server, '/session/preflight', { sessionId });
      expect(preflight.statusCode).toBe(200);
      expect(preflight.body.state).toBe('preflighted_block');

      const res = await post<{
        error: { class: string; kind: string; message: string; correlationId: string };
      }>(server, '/session/createSnapshot', { sessionId });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('preflight_not_passed');
      expect(res.body.error.correlationId).toBe(sessionId);
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits preserves missing_prerequisite as SessionError when no fs adapter was injected', async () => {
    const { server, dispose } = await buildServer();
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const res = await post<{
        error: {
          class: string;
          kind: string;
          message: string;
          correlationId: string;
          details: { recoveryClass: string; prerequisite: string; from: string; attempted: string };
        };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content: 'x' }],
      });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('missing_prerequisite');
      expect(res.body.error.message).toContain('fs adapter not injected');
      expect(res.body.error.correlationId).toBe(sessionId);
      expect(res.body.error.details).toEqual({
        recoveryClass: 'check_prerequisites',
        from: 'snapshotted',
        attempted: 'applyEdits',
        detail: 'fs adapter not injected at session construction',
        prerequisite: 'fs',
      });
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits accepts patch + full_file variants and reports per-kind counts (t-071)', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'const a = 1;\nconst b = 2;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const applied = await post<{
        state: string;
        data: {
          changedFiles: string[];
          bytesWritten: number;
          changeKindCounts: { full_file: number; patch: number; structural: number };
        };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'patch',
            file: 'src/foo.ts',
            hunks: [{ search: 'const a = 1;', replace: 'const a = 10;' }],
          },
          { file: 'src/bar.ts', content: 'export const b = 2;\n' },
        ],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/bar.ts', 'src/foo.ts']);
      expect(applied.body.data.changeKindCounts).toEqual({
        full_file: 1,
        patch: 1,
        structural: 0,
      });
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
        'const a = 10;\nconst b = 2;\n',
      );
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits rejects a patch with a missing anchor (t-071)', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'const a = 1;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const res = await post<{
        error: {
          class: string;
          kind: string;
          message: string;
          correlationId: string;
          details: {
            recoveryClass: string;
            from: string;
            attempted: string;
            file: string;
            changeKind: string;
            failedChangeIndex: number;
            failedHunkIndex: number;
          };
        };
      }>(
        server,
        '/session/applyEdits',
        {
          sessionId,
          proposedChanges: [
            {
              kind: 'patch',
              file: 'src/foo.ts',
              hunks: [{ search: 'no-such-line', replace: 'x' }],
            },
          ],
        },
      );
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('patch_not_applicable');
      expect(res.body.error.message).toContain('search anchor not found');
      expect(res.body.error.correlationId).toBe(sessionId);
      expect(res.body.error.details).toEqual({
        recoveryClass: 'refresh_and_recompute',
        from: 'snapshotted',
        attempted: 'applyEdits',
        detail: 'patch hunk 0 for "src/foo.ts": search anchor not found',
        file: 'src/foo.ts',
        changeKind: 'patch',
        failedChangeIndex: 0,
        failedHunkIndex: 0,
      });
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
    } finally {
      await dispose();
    }
  });

  it('POST /session/stageContent + /session/applyEdits round-trips a staged body (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const body = 'export const staged = "ok";\n' + 'x'.repeat(8192);
      const bodyBytes = new TextEncoder().encode(body);
      const sha = createHash('sha256').update(bodyBytes).digest('hex');
      const mid = Math.floor(bodyBytes.byteLength / 2);
      const chunk0 = Buffer.from(bodyBytes.slice(0, mid)).toString('base64');
      const chunk1 = Buffer.from(bodyBytes.slice(mid)).toString('base64');

      const stage0 = await post<{
        state: string;
        data: { stagingKey: string; complete: boolean; chunks: number };
      }>(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'staged-1',
        seq: 0,
        chunk: chunk0,
        isFinal: false,
      });
      expect(stage0.statusCode).toBe(200);
      expect(stage0.body.data.complete).toBe(false);
      expect(stage0.body.data.chunks).toBe(1);

      const stage1 = await post<{
        state: string;
        data: { stagingKey: string; complete: boolean; sha256: string };
      }>(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'staged-1',
        seq: 1,
        chunk: chunk1,
        isFinal: true,
        expectedTotalSha256: sha,
        expectedTotalByteLength: bodyBytes.byteLength,
      });
      expect(stage1.statusCode).toBe(200);
      expect(stage1.body.data.complete).toBe(true);
      expect(stage1.body.data.sha256).toBe(sha);

      const applied = await post<{
        state: string;
        data: {
          changedFiles: string[];
          bytesWritten: number;
          changeKindCounts: { full_file: number; patch: number; structural: number };
        };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/staged.ts',
            stagedContent: {
              stagingKey: 'staged-1',
              expectedSha256: sha,
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/staged.ts']);
      expect(applied.body.data.bytesWritten).toBe(bodyBytes.byteLength);
      expect(applied.body.data.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });
      expect(new TextDecoder().decode(await fs.read('src/staged.ts'))).toBe(body);
    } finally {
      await dispose();
    }
  });

  it('POST /session/stageContent + /session/dryRun hydrates stagedContent without consuming it (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    let capturedProposedChanges: unknown = null;
    const { server, dispose } = await buildServer({
      auditResult: PASS_AUDIT,
      fs,
      engineOverrides: {
        dryRun: async (req) => {
          capturedProposedChanges = req.proposedChanges;
          return PASS_AUDIT;
        },
      },
    });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const body = 'export const staged_dry_run = "ok";\n';
      const bodyBytes = new TextEncoder().encode(body);
      const sha = createHash('sha256').update(bodyBytes).digest('hex');
      await post(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'staged-dry-run',
        seq: 0,
        chunk: Buffer.from(bodyBytes).toString('base64'),
        isFinal: true,
        expectedTotalSha256: sha,
        expectedTotalByteLength: bodyBytes.byteLength,
      });

      const dryRun = await post<{
        state: string;
        data: { result: { status: string } };
      }>(server, '/session/dryRun', {
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/staged-dry-run.ts',
            stagedContent: {
              stagingKey: 'staged-dry-run',
              expectedSha256: sha,
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });
      expect(dryRun.statusCode).toBe(200);
      expect(dryRun.body.state).toBe('snapshotted');
      expect(dryRun.body.data.result.status).toBe('PASS');
      expect(capturedProposedChanges).toEqual([
        {
          kind: 'full_file',
          file: 'src/staged-dry-run.ts',
          content: body,
        },
      ]);

      const applied = await post<{
        state: string;
        data: { changedFiles: string[] };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/staged-dry-run.ts',
            stagedContent: {
              stagingKey: 'staged-dry-run',
              expectedSha256: sha,
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(new TextDecoder().decode(await fs.read('src/staged-dry-run.ts'))).toBe(body);
    } finally {
      await dispose();
    }
  });

  it('POST /session/stageContent with seq mismatch → SessionError(stage_integrity_mismatch) (t-076)', async () => {
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;

      const res = await post<{
        error: {
          class: string;
          kind: string;
          message: string;
          correlationId: string;
          details: { recoveryClass: string; prerequisite: string };
        };
      }>(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'k',
        seq: 3,
        chunk: Buffer.from('x').toString('base64'),
        isFinal: false,
      });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('stage_integrity_mismatch');
      expect(res.body.error.details.recoveryClass).toBe('refresh_and_recompute');
      expect(res.body.error.details.prerequisite).toBe('seq');
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits with mismatched stagedContent sha → SessionError(stage_integrity_mismatch) (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const body = 'export const ok = true;\n';
      const bodyBytes = new TextEncoder().encode(body);
      const sha = createHash('sha256').update(bodyBytes).digest('hex');

      await post(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'k',
        seq: 0,
        chunk: Buffer.from(bodyBytes).toString('base64'),
        isFinal: true,
        expectedTotalSha256: sha,
        expectedTotalByteLength: bodyBytes.byteLength,
      });

      const res = await post<{
        error: { class: string; kind: string; details: { prerequisite: string } };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/x.ts',
            stagedContent: {
              stagingKey: 'k',
              // Wrong sha: caller claims a different content identity than
              // what the staging store actually finalized.
              expectedSha256: 'b'.repeat(64),
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });
      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('stage_integrity_mismatch');
      expect(res.body.error.details.prerequisite).toBe('stagedContent.integrity');
      // No file should have been written.
      const stat = await fs.stat('src/x.ts');
      expect(stat.exists).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('engine-RPC routes still serve alongside /session/*', async () => {
    const { server, dispose } = await buildServer();
    try {
      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await dispose();
    }
  });

  it('POST /session/applyEdits accepts a nested symbolPath structural selector (t-066)', async () => {
    // The widened `StructuralTargetSchema` flows through the shared
    // `SessionApplyEditsRequestSchema` on the HTTP surface, so a nested
    // selector validates and reaches the session. Resolution itself is
    // deferred to the injected `codeIntelligence`; a mock adapter that
    // exposes the nested symbol path proves the transport layer does not
    // reject the widened body.
    const fs = createMemFsAdapter();
    const classHeader = 'class MyClass {\n';
    const methodOld = '  doThing() { return 1; }\n';
    const classFooter = '}\n';
    const baseline = classHeader + methodOld + classFooter;
    await fs.write('src/mc.ts', new TextEncoder().encode(baseline));
    const methodStart = Buffer.byteLength(classHeader, 'utf8');
    const methodEnd = methodStart + Buffer.byteLength(methodOld, 'utf8');
    const codeIntelligence = {
      async parse(_file: string, content: Uint8Array) {
        const text = new TextDecoder().decode(content);
        return {
          rootNode: {
            kind: 'program',
            byteRange: [0, content.byteLength] as [number, number],
            text,
            namedChildren: [
              {
                kind: 'class_declaration',
                byteRange: [0, content.byteLength] as [number, number],
                text: 'MyClass',
                namedChildren: [
                  {
                    kind: 'type_identifier',
                    byteRange: [0, 0] as [number, number],
                    text: 'MyClass',
                    namedChildren: [],
                    children: [],
                  },
                  {
                    kind: 'method_definition',
                    byteRange: [methodStart, methodEnd] as [number, number],
                    text: 'doThing',
                    namedChildren: [
                      {
                        kind: 'property_identifier',
                        byteRange: [methodStart, methodStart] as [number, number],
                        text: 'doThing',
                        namedChildren: [],
                        children: [],
                      },
                    ],
                    children: [],
                  },
                ],
                children: [],
              },
            ],
            children: [],
          },
        } as unknown as import('../../src/hoplon/adapters/codeIntelligence.js').SyntaxTree;
      },
      getTopLevelSymbols(_tree: unknown) {
        return [
          { name: 'MyClass', kind: 'class_declaration', byteRange: [0, Buffer.byteLength(baseline, 'utf8')] as [number, number] },
        ];
      },
    };

    const engine = makeMockEngine({
      auditDiff: async () => PASS_AUDIT,
      health: async () => ({
        engineId: 'mock-engine',
        status: 'ok',
        version: '0.0.0-test',
        startedAt: '2026-04-19T00:00:00Z',
        capabilities: [],
      }),
    });
    const registry = createSessionRegistry({ engine, fs, codeIntelligence });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });

      const applied = await post<{
        state: string;
        data: {
          changedFiles: string[];
          changeKindCounts: { full_file: number; patch: number; structural: number };
        };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'structural',
            file: 'src/mc.ts',
            target: { symbolPath: ['MyClass', 'doThing'] },
            content: '  doThing() { return 99; }\n',
          },
        ],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changeKindCounts).toEqual({
        full_file: 0,
        patch: 0,
        structural: 1,
      });
      expect(new TextDecoder().decode(await fs.read('src/mc.ts'))).toBe(
        classHeader + '  doThing() { return 99; }\n' + classFooter,
      );
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('POST /session/targetFirstScopedEdit previews a manifest draft and edit slice', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('one\ntwo\nthree\n'));
    const { server, dispose } = await buildServer({ fs });
    try {
      const preview = await post<{
        state: string;
        session: { sessionId: string; projectId: string; runId: string };
        data: {
          result: {
            status: string;
            manifestDraft: {
              requiresConfirmation: boolean;
              manifest: { entries: Array<{ path: string; scope: unknown }> };
            };
            editSlice?: { path: string; content: string; startLine: number; endLine: number };
            proofPlan: { phases: string[] };
          };
        };
      }>(server, '/session/targetFirstScopedEdit', {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'symbol', file: 'src/foo.ts', symbol: 'foo' },
        editSlice: { startLine: 2, endLine: 2 },
        apply: false,
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.body.state).toBe('closed');
      expect(preview.body.session.sessionId).toBe('preview');
      expect(preview.body.session.projectId).toBe('proj-session');
      expect(preview.body.data.result.status).toBe('preview');
      expect(preview.body.data.result.manifestDraft.requiresConfirmation).toBe(true);
      expect(preview.body.data.result.manifestDraft.manifest.entries).toEqual([
        { path: 'src/foo.ts', scope: { kind: 'symbols', symbols: ['foo'] } },
      ]);
      expect(preview.body.data.result.editSlice).toMatchObject({
        path: 'src/foo.ts',
        startLine: 2,
        endLine: 2,
        content: 'two\n',
      });
      expect(preview.body.data.result.proofPlan.phases).toContain(
        'await_manifest_confirmation',
      );
    } finally {
      await dispose();
    }
  });

  it('POST /session/targetFirstScopedEdit apply requires acceptedManifest', async () => {
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({ fs });
    try {
      const res = await post<{
        error: { class: string; kind: string; message: string };
      }>(server, '/session/targetFirstScopedEdit', {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'file', path: 'src/foo.ts' },
        apply: true,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.class).toBe('SessionTransportError');
      expect(res.body.error.kind).toBe('invalid_request');
      expect(res.body.error.message).toContain('acceptedManifest');
    } finally {
      await dispose();
    }
  });

  it('POST /session/targetFirstScopedEdit apply delegates to quickEdit without leaving a live session', async () => {
    const fs = createMemFsAdapter();
    const { server, registry, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const applied = await post<{
        state: string;
        data: {
          result: {
            status: string;
            quickEditResult?: { outcome?: string; finalState?: string; changedFiles?: string[] };
          };
        };
      }>(server, '/session/targetFirstScopedEdit', {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'file', path: 'src/foo.ts' },
        apply: true,
        acceptedManifest: MANIFEST,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
      });

      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('closed');
      expect(applied.body.data.result.status).toBe('applied');
      expect(applied.body.data.result.quickEditResult?.outcome).toBe('pass');
      expect(applied.body.data.result.quickEditResult?.finalState).toBe('closed');
      expect(applied.body.data.result.quickEditResult?.changedFiles).toEqual(['src/foo.ts']);
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
        'export const x = 1;\n',
      );
      expect(registry.size()).toBe(0);
    } finally {
      await dispose();
    }
  });

  it('POST /session/getCloseoutProofBundle returns proof shape without advancing state', async () => {
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({ auditResult: PASS_AUDIT, fs });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', { sessionId });
      await post(server, '/session/createSnapshot', { sessionId });
      await post(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const ok = 1;\n' }],
      });
      await post(server, '/session/audit', { sessionId });

      const bundle = await post<{
        state: string;
        data: {
          closeoutProofBundle: {
            closeoutProofBundleSchemaVersion: number;
            sessionId: string;
            state: string;
            proofVerbosity: string;
            changedFiles: string[];
            historyLength: number;
            proofRefs: { snapshotRef: string | null; auditRef: string | null };
            results: { preflightStatus: string | null; auditStatus: string | null };
          };
        };
      }>(server, '/session/getCloseoutProofBundle', {
        sessionId,
        proofVerbosity: 'compact',
      });

      expect(bundle.statusCode).toBe(200);
      expect(bundle.body.state).toBe('audited_pass');
      expect(bundle.body.data.closeoutProofBundle).toMatchObject({
        closeoutProofBundleSchemaVersion: 1,
        sessionId,
        state: 'audited_pass',
        proofVerbosity: 'compact',
        changedFiles: ['src/foo.ts'],
        results: { preflightStatus: 'PASS', auditStatus: 'PASS' },
      });
      expect(bundle.body.data.closeoutProofBundle.historyLength).toBeGreaterThan(0);
      expect(bundle.body.data.closeoutProofBundle.proofRefs.snapshotRef).toMatch(/^sha256:/);
    } finally {
      await dispose();
    }
  });

  it('POST /session/getCloseoutProofBundle rejects missing and unknown session handles', async () => {
    const { server, dispose } = await buildServer();
    try {
      const missing = await post<{
        error: { class: string; kind: string; guidance?: string };
      }>(server, '/session/getCloseoutProofBundle', {});
      expect(missing.statusCode).toBe(400);
      expect(missing.body.error.class).toBe('SessionTransportError');
      expect(missing.body.error.kind).toBe('invalid_request');
      expect(missing.body.error.guidance).toContain('sessionId');

      const unknown = await post<{
        error: { class: string; kind: string; correlationId: string };
      }>(server, '/session/getCloseoutProofBundle', { sessionId: 'ghost-session' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body.error.class).toBe('SessionTransportError');
      expect(unknown.body.error.kind).toBe('session_not_found');
      expect(unknown.body.error.correlationId).toBe('ghost-session');
    } finally {
      await dispose();
    }
  });
});
