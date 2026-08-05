/**
 * tests/transport/http.quickEdit.test.ts — packaged HTTP surface proof for
 * the t-079 single-shot supervised quick-edit wrapper.
 *
 * Exercises `POST /session/quickEdit` through `fastify.inject()` so the full
 * t-079 contract holds over the shipped HTTP transport:
 *
 *   - PASS path: one round-trip preflights, snapshots, applies, audits, and
 *     closes. The response envelope carries the same session + snapshot
 *     artifacts that the in-process wrapper exposes so review/audit
 *     evidence stays reachable.
 *   - BLOCK audit: revert + extractRollbackTemplate run on the server side
 *     by default; the response envelope names `phase: 'audit'` and carries
 *     revertResult + rollbackTemplate verbatim.
 *   - Failure: adapter-side write failure surfaces `outcome: 'failed'` /
 *     `phase: 'applyEdits'` with a SessionError-class error payload.
 *
 * These proofs intentionally round-trip through the real HTTP server so the
 * wrapper's transport envelope shape is part of the shipped contract, not
 * just an in-process detail.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { FastifyInstance } from 'fastify';
import type { TraceStore } from '../../src/hoplon/adapters/traceStore.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import {
  BLOCK_AUDIT,
  MANIFEST,
  PASS_AUDIT,
  makeMockEngine,
} from '../session/helpers.js';
import type { QuickEditResultData } from '../../src/hoplon/session/transportContracts.js';

interface BuildServerOptions {
  auditResult?: AuditResult;
  fs?: HoplonFsAdapter;
  engineOverrides?: Partial<HoplonEngine>;
  traceStore?: TraceStore;
  engineVersion?: string;
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
      startedAt: '2026-04-22T00:00:00Z',
      capabilities: [],
    }),
    ...opts.engineOverrides,
  });
  const registry = createSessionRegistry({
    engine,
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
    ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
    ...(opts.engineVersion !== undefined
      ? { engineVersion: opts.engineVersion }
      : {}),
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

async function postQuickEdit(
  server: FastifyInstance,
  payload: unknown,
): Promise<{ statusCode: number; body: QuickEditResultData }> {
  const response = await server.inject({
    method: 'POST',
    url: '/session/quickEdit',
    payload,
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as QuickEditResultData,
  };
}

describe('POST /session/quickEdit (t-079)', () => {
  it('PASS path: one round-trip runs preflight → snapshot → applyEdits → audit → close on the server', async () => {
    const fs = createMemFsAdapter();
    const { server, registry, dispose } = await buildServer({
      auditResult: PASS_AUDIT,
      fs,
    });
    try {
      const { statusCode, body } = await postQuickEdit(server, {
        manifest: MANIFEST,
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const ok = 1;\n' },
        ],
      });

      expect(statusCode).toBe(200);
      expect(body.outcome).toBe('pass');
      if (body.outcome !== 'pass') throw new Error('unreachable');

      // Session + snapshot artifacts survive the round-trip — the HTTP
      // caller can still reach review / audit evidence without a follow-up
      // session_inspect call (the wrapper closed the session server-side).
      expect(body.sessionId).toMatch(/.+/);
      expect(body.snapshotRef?.id).toMatch(/^sha256:/);
      expect(body.auditResult.status).toBe('PASS');
      expect(body.changedFiles).toEqual(['src/foo.ts']);
      expect(body.applyEdits?.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });
      expect(body.finalState).toBe('closed');

      // History proves the server-side wrapper drove the full loop.
      const ops = body.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'applyEdits',
        'audit',
        'close',
      ]);

      // The supervised write path actually landed bytes on the server's
      // injected fs adapter.
      const written = new TextDecoder().decode(await fs.read('src/foo.ts'));
      expect(written).toBe('export const ok = 1;\n');

      // No leaked live session — the wrapper closes the session server-side.
      expect(registry.list().map((s) => s.sessionId)).not.toContain(body.sessionId);
    } finally {
      await dispose();
    }
  });

  it('BLOCK audit: server runs revert + extractRollbackTemplate, envelope names the failing phase', async () => {
    const fs = createMemFsAdapter();
    const { server, dispose } = await buildServer({
      auditResult: BLOCK_AUDIT,
      fs,
    });
    try {
      const { statusCode, body } = await postQuickEdit(server, {
        manifest: MANIFEST,
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const bad = 1;\n' },
        ],
      });

      expect(statusCode).toBe(200);
      expect(body.outcome).toBe('block');
      if (body.outcome !== 'block') throw new Error('unreachable');
      expect(body.phase).toBe('audit');
      if (body.phase !== 'audit') throw new Error('unreachable');
      expect(body.auditResult.status).toBe('BLOCK');
      expect(body.revertResult?.reverted).toContain('src/foo.ts');
      expect(body.rollbackTemplate?.files.length).toBeGreaterThan(0);
      expect(body.finalState).toBe('closed');
    } finally {
      await dispose();
    }
  });

  it('Adapter failure during applyEdits: envelope reports outcome=failed, phase=applyEdits', async () => {
    const memfs = createMemFsAdapter();
    const failing: HoplonFsAdapter = {
      read: memfs.read.bind(memfs),
      list: memfs.list.bind(memfs),
      stat: memfs.stat.bind(memfs),
      mkdir: memfs.mkdir.bind(memfs),
      remove: memfs.remove.bind(memfs),
      write: async () => {
        throw new AdapterError(
          { kind: 'fs_write_failed', engineId: 'mock', correlationId: 'corr' },
          'simulated server-side write failure',
        );
      },
    };
    const { server, dispose } = await buildServer({ fs: failing });
    try {
      const { statusCode, body } = await postQuickEdit(server, {
        manifest: MANIFEST,
        proposedChanges: [{ file: 'src/foo.ts', content: 'x' }],
      });
      // The wrapper absorbs the phase failure; the HTTP layer reports 200
      // because the session surface itself answered (the *edit* failed,
      // not the transport).
      expect(statusCode).toBe(200);
      expect(body.outcome).toBe('failed');
      if (body.outcome !== 'failed') throw new Error('unreachable');
      expect(body.phase).toBe('applyEdits');
      expect(body.error.class).toBeTruthy();
      expect(body.error.message).toMatch(/simulated server-side write failure/);
      expect(body.finalState).toBe('closed');
    } finally {
      await dispose();
    }
  });

  it('preserves traceStore-backed observability on the packaged quickEdit path', async () => {
    const fs = createMemFsAdapter();
    const traceStore = createInMemoryTraceStore();
    const { server, dispose } = await buildServer({
      auditResult: PASS_AUDIT,
      fs,
      traceStore,
      engineVersion: '9.9.9-http-quick-edit',
    });
    try {
      const { statusCode, body } = await postQuickEdit(server, {
        manifest: MANIFEST,
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const traced = 1;\n' },
        ],
      });

      expect(statusCode).toBe(200);
      expect(body.outcome).toBe('pass');
      if (body.outcome !== 'pass') throw new Error('unreachable');

      const executionId = deriveExecutionId(body.sessionId);
      const exec = await traceStore.getExecution(executionId);
      expect(exec?.currentStatus).toBe('PASS');

      const bundles = await traceStore.listProofBundles(executionId);
      expect(bundles).toHaveLength(1);
      expect(bundles[0]?.engineVersion).toBe('9.9.9-http-quick-edit');
    } finally {
      await dispose();
    }
  });
});
