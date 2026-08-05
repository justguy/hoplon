/**
 * t-100 strict-agent adversarial HTTP corpus.
 *
 * Exercises packaged agent-facing HTTP surfaces, not helper-only units.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createSessionRegistry, type SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import {
  BLOCK_AUDIT,
  MANIFEST,
  makeMockEngine,
  SNAPSHOT_RESULT,
} from '../session/helpers.js';

const TOKEN = 'strict-write-token-t100';
const ENGAGEMENT = { token: TOKEN, folder: 'src', principalId: 'agent-a' };
const CHANGE = { file: 'src/foo.ts', content: 'export const value = 2;\n' };

function putWriteToken(store: EngagementStore): void {
  store.put(TOKEN, {
    projectId: MANIFEST.projectId,
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-28T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: 'strict-write-token-t100-nonce',
  });
}

async function buildStrictHttp(opts: {
  readonly fs?: HoplonFsAdapter;
  readonly auditResult?: typeof BLOCK_AUDIT;
  readonly launcherRoot?: string;
} = {}): Promise<{
  readonly server: FastifyInstance;
  readonly registry: SessionRegistry;
  readonly engagementStore: EngagementStore;
  readonly createSnapshot: ReturnType<typeof vi.fn>;
  readonly dispose: () => Promise<void>;
}> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const createSnapshot = vi.fn(async () => SNAPSHOT_RESULT);
  const engine = makeMockEngine({
    createSnapshot,
    ...(opts.auditResult !== undefined
      ? { auditDiff: async () => opts.auditResult }
      : {}),
  });
  const registry = createSessionRegistry({
    engine,
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
  });
  const server = await createHoplonHttpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-t100' }),
    ...(opts.launcherRoot !== undefined ? { launcherRoot: opts.launcherRoot } : {}),
  });
  return {
    server,
    registry,
    engagementStore,
    createSnapshot,
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

function withEngagement(sessionId: string): { sessionId: string; engagement: typeof ENGAGEMENT } {
  return { sessionId, engagement: ENGAGEMENT };
}

describe('t-100 strict-agent HTTP adversarial corpus', () => {
  it('hides raw engine, markEdited, quickEdit, and project-registry bypass routes', async () => {
    const { server, createSnapshot, dispose } = await buildStrictHttp({
      launcherRoot: '/tmp/hoplon-t100-strict-http-routes',
    });
    try {
      const raw = await post(server, '/createSnapshot', { manifest: MANIFEST });
      expect(raw.statusCode).toBe(404);
      expect(createSnapshot).not.toHaveBeenCalled();

      for (const url of ['/session/markEdited', '/session/quickEdit']) {
        const res = await post<{ error: { class: string; details: { agentFallbackAllowed: boolean } } }>(
          server,
          url,
          { editMode: 'applyEdits', proposedChanges: [CHANGE] },
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.error.class).toBe('StrictAgentFallbackError');
        expect(res.body.error.details.agentFallbackAllowed).toBe(false);
      }

      for (const route of [
        ['GET', '/projects'],
        ['POST', '/projects/register'],
        ['POST', '/projects/unregister'],
        ['POST', '/projects/select'],
        ['POST', '/projects/clear-active'],
      ] as const) {
        const res = await server.inject({ method: route[0], url: route[1], payload: {} });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.class).toBe('StrictAgentFallbackError');
      }
    } finally {
      await dispose();
    }
  });

  it('runs strict write, review, BLOCK repair, and repair-context packaging without markEdited', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const value = 1;\n'));
    const { server, engagementStore, dispose } = await buildStrictHttp({
      fs,
      auditResult: BLOCK_AUDIT,
    });
    putWriteToken(engagementStore);
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST, engagement: ENGAGEMENT },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', withEngagement(sessionId));
      await post(server, '/session/createSnapshot', withEngagement(sessionId));
      await post(server, '/session/dryRun', { ...withEngagement(sessionId), proposedChanges: [CHANGE] });
      await post(server, '/session/applyEdits', { ...withEngagement(sessionId), proposedChanges: [CHANGE] });

      const review = await post<{ data: { review: { changedFiles: string[]; changeKindCounts: unknown; notes: string[] } } }>(
        server,
        '/session/review',
        withEngagement(sessionId),
      );
      expect(review.body.data.review.changedFiles).toEqual(['src/foo.ts']);
      expect(review.body.data.review.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });
      expect(review.body.data.review.notes).not.toContain('markEdited_before_bytes_unavailable');

      const audit = await post<{ state: string }>(server, '/session/audit', withEngagement(sessionId));
      expect(audit.body.state).toBe('audited_block');
      await post(server, '/session/revert', withEngagement(sessionId));
      await post(server, '/session/extractRollbackTemplate', withEngagement(sessionId));
      const repair = await post<{ data: { repairContext: { auditResult: { status: string }; priorSessionHistory: Array<{ op: string }> } } }>(
        server,
        '/session/getRepairContext',
        withEngagement(sessionId),
      );
      expect(repair.body.data.repairContext.auditResult.status).toBe('BLOCK');
      expect(repair.body.data.repairContext.priorSessionHistory.map((h) => h.op)).toContain('applyEdits');
      expect(repair.body.data.repairContext.priorSessionHistory.map((h) => h.op)).not.toContain('markEdited');
    } finally {
      await dispose();
    }
  });

  it('returns typed stale_write recovery when an external writer changes the target before strict applyEdits flush', async () => {
    const inner = createMemFsAdapter();
    await inner.write('src/foo.ts', new TextEncoder().encode('export const value = 1;\n'));
    let statCalls = 0;
    const fs: HoplonFsAdapter = {
      read: (path) => inner.read(path),
      list: (path) => inner.list(path),
      mkdir: (path, opts) => inner.mkdir(path, opts),
      remove: (path) => inner.remove(path),
      write: (path, bytes) => inner.write(path, bytes),
      async stat(path) {
        statCalls += path === 'src/foo.ts' ? 1 : 0;
        if (path === 'src/foo.ts' && statCalls === 2) {
          await inner.write('src/foo.ts', new TextEncoder().encode('// external writer\n'));
        }
        return inner.stat(path);
      },
    };
    const { server, engagementStore, dispose } = await buildStrictHttp({ fs });
    putWriteToken(engagementStore);
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST, engagement: ENGAGEMENT },
      );
      const sessionId = start.body.session.sessionId;
      await post(server, '/session/preflight', withEngagement(sessionId));
      await post(server, '/session/createSnapshot', withEngagement(sessionId));
      const res = await post<{ error: { class: string; kind: string; details: { recoveryClass: string; driftKind: string } } }>(
        server,
        '/session/applyEdits',
        { ...withEngagement(sessionId), proposedChanges: [CHANGE] },
      );
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatchObject({
        class: 'SessionError',
        kind: 'stale_write',
        details: { recoveryClass: 'refresh_and_recompute', driftKind: 'bytes_diverged' },
      });
      const inspect = await post<{ state: string; snapshot: { history: Array<{ op: string }> } }>(
        server,
        '/session/inspect',
        withEngagement(sessionId),
      );
      expect(inspect.body.state).toBe('snapshotted');
      expect(inspect.body.snapshot.history.map((h) => h.op)).not.toContain('applyEdits');
    } finally {
      await dispose();
    }
  });
});
