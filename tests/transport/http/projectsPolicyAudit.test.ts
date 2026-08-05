/**
 * tests/transport/http/projectsPolicyAudit.test.ts — t-088 proof that
 * the packaged HTTP project routes emit durable `hoplon_audit_log` rows
 * for handshake grant/deny and gated access checks through the
 * `auditedVerifyEngagementToken` seam.
 *
 * Uses the in-memory sqlite `createIsolatedTestStore()` so assertions
 * run against the real shipped adapter — every row is Zod-validated on
 * both INSERT and SELECT.
 *
 * Covers the t-088 DOD proof matrix:
 *   - one granted handshake         → POLICY_HANDSHAKE / GRANTED
 *   - one denied handshake          → POLICY_HANDSHAKE / DENIED
 *   - one expired gated access      → POLICY_ACCESS_CHECK / REAUTH_REQUIRED
 *   - one allowed scoped access     → POLICY_ACCESS_CHECK / GRANTED
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../../src/hoplon/transport/http/server.js';
import { openLauncherProjects } from '../../../src/hoplon/launcher/projects.js';
import {
  createInMemoryEngagementStore,
  __resetEngagementStoresForTests,
} from '../../../src/hoplon/launcher/handshake.js';
import type { EngagementStore } from '../../../src/hoplon/launcher/engagementStore.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../../src/hoplon/contracts/auditLog.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';
import {
  auditedVerifyEngagementToken,
  createPolicyAuditSink,
} from '../../../src/hoplon/transport/policyAuditSink.js';

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
  const projectFsRoot = tmpDir('hoplon-t088-http-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const engagementStore = opts.engagementStore ?? createInMemoryEngagementStore();
  const policyAuditSink = createPolicyAuditSink({
    store,
    engineId: 'http-test',
  });
  const engine = makeMinimalMockEngine();
  const server = await createHoplonHttpServer({
    engine,
    launcherRoot,
    engagementStore,
    policyAuditSink,
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

function auditRowsFor(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

describe('t-088 HTTP policy audit writes', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('writes POLICY_HANDSHAKE / GRANTED on a successful handshake', async () => {
    const launcherRoot = tmpDir('hoplon-t088-http-grant-');
    const store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({ launcherRoot, store });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(200);
      const rows = await auditRowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('GRANTED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_granted');
      expect(r.policyEvent?.requestedAction).toBe('handshake');
      expect(r.policyEvent?.folder).toBe('src');
      expect(r.policyEvent?.resolvedAccess).toBe('read_write');
    } finally {
      await dispose();
    }
  });

  it('writes POLICY_HANDSHAKE / DENIED with typed reason on a policy-denied handshake', async () => {
    const launcherRoot = tmpDir('hoplon-t088-http-deny-');
    const store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({ launcherRoot, store });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { projectId: PROJECT_ID, folder: 'secrets' },
      });
      expect(resp.statusCode).toBe(403);
      const rows = await auditRowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('DENIED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_policy_denied');
      expect(r.policyEvent?.resolvedAccess).toBe('none');
      expect(r.policyEvent?.folder).toBe('secrets');
    } finally {
      await dispose();
    }
  });

  it('records a gated access check GRANTED via auditedVerifyEngagementToken', async () => {
    const launcherRoot = tmpDir('hoplon-t088-http-access-');
    const store = await createIsolatedTestStore();
    const engagementStore = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      store,
      engagementStore,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(200);
      const handshakeBody = JSON.parse(resp.body) as {
        engagement: { token: string };
      };
      const token = handshakeBody.engagement.token;

      const sink = createPolicyAuditSink({ store, engineId: 'http-test' });
      const verification = await auditedVerifyEngagementToken({
        sink,
        store: engagementStore,
        token,
        expectation: {
          now: new Date(),
          projectId: PROJECT_ID,
          folder: 'src',
          requiredAccess: 'read_only',
        },
        action: 'read',
        context: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
        },
      });
      expect(verification.kind).toBe('valid');

      const rows = await auditRowsFor(store);
      const accessRow = rows.find((r) => r.operation === 'POLICY_ACCESS_CHECK');
      expect(accessRow).toBeTruthy();
      expect(accessRow?.result).toBe('GRANTED');
      expect(accessRow?.policyEvent?.reasonCode).toBe('access_granted');
      expect(accessRow?.policyEvent?.requestedAction).toBe('read');
      expect(accessRow?.policyEvent?.folder).toBe('src');
      expect(accessRow?.policyEvent?.resolvedAccess).toBe('read_write');
      expect(typeof accessRow?.policyEvent?.engagementId).toBe('string');
      expect(accessRow?.policyEvent?.engagementId).not.toBe(token);
    } finally {
      await dispose();
    }
  });

  it('records a gated access check REAUTH_REQUIRED when the token has expired', async () => {
    const launcherRoot = tmpDir('hoplon-t088-http-expired-');
    const store = await createIsolatedTestStore();
    const engagementStore = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      store,
      engagementStore,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      const token = (JSON.parse(resp.body) as {
        engagement: { token: string };
      }).engagement.token;

      const sink = createPolicyAuditSink({ store, engineId: 'http-test' });
      const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24);
      const verification = await auditedVerifyEngagementToken({
        sink,
        store: engagementStore,
        token,
        expectation: {
          now: farFuture,
          projectId: PROJECT_ID,
          folder: 'src',
          requiredAccess: 'read_only',
        },
        action: 'read',
        context: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
        },
      });
      expect(verification.kind).toBe('expired');

      const rows = await auditRowsFor(store);
      const accessRow = rows.find((r) => r.operation === 'POLICY_ACCESS_CHECK');
      expect(accessRow).toBeTruthy();
      expect(accessRow?.result).toBe('REAUTH_REQUIRED');
      expect(accessRow?.policyEvent?.reasonCode).toBe('access_expired_token');
    } finally {
      await dispose();
    }
  });
});
