/**
 * tests/transport/http/projectsPolicyAuditLifecycle.test.ts — t-088 HTTP
 * lifecycle audit proof for renewal and revocation rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../../src/hoplon/transport/http/server.js';
import { openLauncherProjects } from '../../../src/hoplon/launcher/projects.js';
import {
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
} from '../../../src/hoplon/launcher/handshake.js';
import type { EngagementStore } from '../../../src/hoplon/launcher/engagementStore.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';
import { createPolicyAuditSink } from '../../../src/hoplon/transport/policyAuditSink.js';

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

const PROJECT_ID = 'p1';
const RUN_ID = 'run-t088-http';
const CORR_ID = 'corr-t088-http';

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

async function buildServer(opts: {
  launcherRoot: string;
  store: SnapshotStore;
  engagementStore?: EngagementStore;
}): Promise<{
  server: FastifyInstance;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  dispose: () => Promise<void>;
}> {
  const { launcherRoot, store } = opts;
  fs.mkdirSync(launcherRoot, { recursive: true });
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: tmpDir('hoplon-t088-http-lifecycle-fsroot-'),
    policy: { folderPolicy: policy },
  });
  const engagementStore = opts.engagementStore ?? createInMemoryEngagementStore();
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-test' }),
  });
  return {
    server,
    store,
    engagementStore,
    dispose: async () => {
      await server.close();
    },
  };
}

async function issueToken(server: FastifyInstance): Promise<string> {
  const handshake = await server.inject({
    method: 'POST',
    url: '/projects/handshake',
    headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
    payload: { projectId: PROJECT_ID, folder: 'src' },
  });
  return (JSON.parse(handshake.body) as { engagement: { token: string } })
    .engagement.token;
}

describe('t-088 HTTP lifecycle policy audit writes', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('writes POLICY_RENEW / GRANTED with project-scoped nonce correlation', async () => {
    const store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('hoplon-t088-http-renew-ok-'),
      store,
    });
    try {
      const token = await issueToken(server);
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/renew',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { token },
      });
      expect(resp.statusCode).toBe(200);
      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      const renew = rows.find((r) => r.operation === 'POLICY_RENEW');
      expect(renew?.result).toBe('GRANTED');
      expect(renew?.policyEvent?.reasonCode).toBe('renew_granted');
      expect(renew?.policyEvent?.folder).toBe('src');
      expect(renew?.policyEvent?.resolvedAccess).toBe('read_write');
      expect(typeof renew?.policyEvent?.engagementId).toBe('string');
      expect(renew?.policyEvent?.engagementId).not.toBe(token);
    } finally {
      await dispose();
    }
  });

  it('writes POLICY_RENEW / REAUTH_REQUIRED for a missing token', async () => {
    const store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('hoplon-t088-http-renew-missing-'),
      store,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/renew',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { token: 'definitely-not-live' },
      });
      expect(resp.statusCode).toBe(401);
      const rows = await store.findAuditLogByProjectAndRun('unknown', RUN_ID);
      const renew = rows.find((r) => r.operation === 'POLICY_RENEW');
      expect(renew?.result).toBe('REAUTH_REQUIRED');
      expect(renew?.policyEvent?.reasonCode).toBe('renew_reauth_missing');
    } finally {
      await dispose();
    }
  });

  it('writes project-scoped POLICY_REVOKE / REVOKED and unknown-token REAUTH_REQUIRED', async () => {
    const store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('hoplon-t088-http-revoke-'),
      store,
      engagementStore: createInMemoryEngagementStore(),
    });
    try {
      const token = await issueToken(server);
      const revokeResp = await server.inject({
        method: 'POST',
        url: '/projects/revoke',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { token },
      });
      expect(revokeResp.statusCode).toBe(200);

      const missingResp = await server.inject({
        method: 'POST',
        url: '/projects/revoke',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { token: 'bogus-token-that-is-not-live' },
      });
      expect(missingResp.statusCode).toBe(404);

      const projectRows = await store.findAuditLogByProjectAndRun(
        PROJECT_ID,
        RUN_ID,
      );
      const revoked = projectRows.find((r) => r.operation === 'POLICY_REVOKE');
      expect(revoked?.result).toBe('REVOKED');
      expect(revoked?.policyEvent?.reasonCode).toBe('revoke_completed');
      expect(revoked?.policyEvent?.folder).toBe('src');
      expect(typeof revoked?.policyEvent?.engagementId).toBe('string');
      expect(revoked?.policyEvent?.engagementId).not.toBe(token);

      const unknownRows = await store.findAuditLogByProjectAndRun(
        'unknown',
        RUN_ID,
      );
      const missing = unknownRows.find((r) => r.operation === 'POLICY_REVOKE');
      expect(missing?.result).toBe('REAUTH_REQUIRED');
      expect(missing?.policyEvent?.reasonCode).toBe('revoke_missing_token');
    } finally {
      await dispose();
    }
  });
});
