/**
 * tests/transport/http/projectsPolicyAuditQueryRoute.test.ts — t-089
 * proof for `GET /projects/policy/audit`.
 *
 * Mounts the live `createHoplonHttpServer` with a launcher root, a
 * registered project, an injected sqlite snapshot store seeded with a
 * mix of granted / denied / reauth_required / revoked rows, and a
 * minimal mock engine. Asserts every t-089 DoD bullet over the real
 * packaged route: filter dimensions, ordering, content-safety,
 * principal discriminator semantics, and bound enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../../src/hoplon/transport/http/server.js';
import { openLauncherProjects } from '../../../src/hoplon/launcher/projects.js';
import {
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
} from '../../../src/hoplon/launcher/handshake.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../../src/hoplon/contracts/auditLog.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMinimalMockEngine(): HoplonEngine {
  return {
    health: async () => ({
      engineId: 'mock-engine',
      status: 'ok',
      version: '0.0.0-test',
      startedAt: '2026-04-23T00:00:00Z',
      capabilities: [],
      adapters: {},
    }),
  } as unknown as HoplonEngine;
}

const PROJECT_ID = 'p-http';
const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [{ folder: 'src', access: 'read_write' }],
};

function row(
  createdAtIso: string,
  overrides: Partial<AuditLogRecord> = {},
): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId: PROJECT_ID,
    runId: 'r',
    engineId: 'http-test',
    correlationId: 'corr-' + randomUUID(),
    operation: 'POLICY_HANDSHAKE',
    result: 'GRANTED',
    violationCount: 0,
    violationKinds: [],
    durationMs: 1,
    createdAt: createdAtIso,
    policyEvent: {
      reasonCode: 'handshake_granted',
      requestedAction: 'handshake',
      folder: 'src',
      principalId: 'alice',
      resolvedAccess: 'read_write',
      engagementId: 'server-private-nonce-XYZ',
      detail: null,
    },
    ...overrides,
  };
}

async function buildServer(opts: {
  launcherRoot: string;
  store?: SnapshotStore;
}): Promise<{
  server: FastifyInstance;
  store: SnapshotStore;
  dispose: () => Promise<void>;
}> {
  const { launcherRoot } = opts;
  fs.mkdirSync(launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t089-http-fs-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const engagementStore = createInMemoryEngagementStore();
  const store = opts.store ?? (await createIsolatedTestStore());
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    engagementStore,
    snapshotStore: store,
  });
  return { server, store, dispose: async () => server.close() };
}

interface SuccessBody {
  projectId: string;
  entries: Array<{
    id: string;
    createdAtIso: string;
    correlationId: string;
    outcome: string;
    reasonCode: string;
    requestedAction: string;
    folder: string | null;
    principalId: string | null;
    resolvedAccess: string | null;
    detail: string | null;
  }>;
  limit: number;
}

interface ErrorBody {
  error: { class: string; kind: string; message: string };
}

describe('GET /projects/policy/audit (t-089)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('returns 400 when projectId is missing', async () => {
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('t089-http-noid-'),
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects/policy/audit',
      });
      expect(resp.statusCode).toBe(400);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });

  it('returns 404 with typed kind for an unknown project', async () => {
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('t089-http-unknown-'),
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects/policy/audit?projectId=nope',
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body) as ErrorBody;
      expect(body.error.kind).toBe('unknown_project');
    } finally {
      await dispose();
    }
  });

  it('returns mixed grant/deny/reauth/revoked rows in reverse-chronological order, never leaking the engagement nonce', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(
      row('2026-04-15T10:00:00.000Z', {
        result: 'GRANTED',
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'nonce-A',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('2026-04-15T11:00:00.000Z', {
        result: 'DENIED',
        policyEvent: {
          reasonCode: 'handshake_policy_denied',
          requestedAction: 'handshake',
          folder: 'docs',
          principalId: null,
          resolvedAccess: 'none',
          engagementId: null,
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('2026-04-15T12:00:00.000Z', {
        operation: 'POLICY_ACCESS_CHECK',
        result: 'REAUTH_REQUIRED',
        policyEvent: {
          reasonCode: 'access_expired_token',
          requestedAction: 'read',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: null,
          engagementId: 'nonce-B',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('2026-04-15T13:00:00.000Z', {
        operation: 'POLICY_REVOKE',
        result: 'REVOKED',
        policyEvent: {
          reasonCode: 'revoke_completed',
          requestedAction: 'revoke',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'nonce-A',
          detail: null,
        },
      }),
    );
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('t089-http-mix-'),
      store,
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}`,
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as SuccessBody;
      expect(body.projectId).toBe(PROJECT_ID);
      expect(body.entries.map((e) => e.outcome)).toEqual([
        'REVOKED',
        'REAUTH_REQUIRED',
        'DENIED',
        'GRANTED',
      ]);
      expect(body.limit).toBe(50);
      // Content-safety: never leak the engagement nonce.
      expect(resp.body).not.toContain('nonce-A');
      expect(resp.body).not.toContain('nonce-B');
      // No `engagementId` field on any entry.
      expect(body.entries.some((e) => 'engagementId' in e)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('parses the discriminated principal filter (any / none / exact) and rejects ambiguous combinations', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(
      row('2026-04-16T09:00:00.000Z', {
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: null,
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('2026-04-16T10:00:00.000Z', {
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: null,
          resolvedAccess: 'read_only',
          engagementId: null,
          detail: null,
        },
      }),
    );
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('t089-http-principal-'),
      store,
    });
    try {
      const any = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}`,
      });
      expect(any.statusCode).toBe(200);
      expect((JSON.parse(any.body) as SuccessBody).entries.length).toBe(2);

      const none = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&principalFilter=none`,
      });
      expect(none.statusCode).toBe(200);
      const noneEntries = (JSON.parse(none.body) as SuccessBody).entries;
      expect(noneEntries.length).toBe(1);
      expect(noneEntries[0]!.principalId).toBeNull();

      const exact = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&principalId=alice`,
      });
      expect(exact.statusCode).toBe(200);
      const exactEntries = (JSON.parse(exact.body) as SuccessBody).entries;
      expect(exactEntries.length).toBe(1);
      expect(exactEntries[0]!.principalId).toBe('alice');

      const ambiguous = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&principalFilter=none&principalId=alice`,
      });
      expect(ambiguous.statusCode).toBe(400);
      const exactNoId = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&principalFilter=exact`,
      });
      expect(exactNoId.statusCode).toBe(400);
      const unknown = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&principalFilter=foo`,
      });
      expect(unknown.statusCode).toBe(400);
    } finally {
      await dispose();
    }
  });

  it('rejects oversized limit and inverted since/until at the contract layer', async () => {
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('t089-http-bounds-'),
    });
    try {
      const big = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&limit=9999`,
      });
      expect(big.statusCode).toBe(400);
      const inverted = await server.inject({
        method: 'GET',
        url: `/projects/policy/audit?projectId=${PROJECT_ID}&since=2026-05-01T00:00:00.000Z&until=2026-04-01T00:00:00.000Z`,
      });
      expect(inverted.statusCode).toBe(400);
    } finally {
      await dispose();
    }
  });
});
