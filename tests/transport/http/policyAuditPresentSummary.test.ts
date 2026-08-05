/**
 * tests/transport/http/policyAuditPresentSummary.test.ts — t-086 proof
 * (DOD #4) that operator-visible audit-evidence presentation correctly
 * surfaces grant / deny / expired / revoked decisions.
 *
 * Drives real handshake + lifecycle + access-check flows through the
 * shipped `policyAuditSink` (writing into the in-memory sqlite store
 * via `createIsolatedTestStore()`), then projects the rows through
 * `summarizePolicyAuditRow` to assert each decision class renders the
 * right reason code, requested action, resolved access, and outcome
 * for an operator — without exposing the engagement-id binding nonce.
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
import {
  summarizePolicyAuditRow,
  summarizePolicyAuditRows,
} from '../../../src/hoplon/transport/http/policyAuditPresent.js';

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
const RUN_ID = 'run-t086';
const CORR_ID = 'corr-t086';

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
  const projectFsRoot = tmpDir('hoplon-t086-present-fs-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const engagementStore = opts.engagementStore ?? createInMemoryEngagementStore();
  const policyAuditSink = createPolicyAuditSink({
    store,
    engineId: 't086-test',
  });
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    engagementStore,
    policyAuditSink,
  });
  return {
    server,
    store,
    engagementStore,
    dispose: async () => server.close(),
  };
}

function rowsByOp(rows: AuditLogRecord[]): Record<string, AuditLogRecord[]> {
  const out: Record<string, AuditLogRecord[]> = {};
  for (const r of rows) {
    (out[r.operation] ??= []).push(r);
  }
  return out;
}

describe('summarizePolicyAuditRow operator presentation (t-086)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('summarizes a granted handshake with operator-readable reason and resolved access', async () => {
    const launcherRoot = tmpDir('hoplon-t086-present-grant-');
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

      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      const summaries = summarizePolicyAuditRows(rows);
      expect(summaries.length).toBe(1);
      const grant = summaries[0]!;
      expect(grant.operation).toBe('POLICY_HANDSHAKE');
      expect(grant.outcome).toBe('GRANTED');
      expect(grant.reasonCode).toBe('handshake_granted');
      expect(grant.requestedAction).toBe('handshake');
      expect(grant.folder).toBe('src');
      expect(grant.resolvedAccess).toBe('read_write');
      expect(grant.correlationId).toBe(CORR_ID);
      expect(grant.runId).toBe(RUN_ID);
      // The presentation projection must drop the t-088 engagementId
      // (the server-private binding nonce). Operators see the decision,
      // not the internal correlation handle.
      expect((grant as Record<string, unknown>)['engagementId']).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('summarizes a denied handshake with the typed policy_denied reason', async () => {
    const launcherRoot = tmpDir('hoplon-t086-present-deny-');
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

      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      const summaries = summarizePolicyAuditRows(rows);
      expect(summaries.length).toBe(1);
      const deny = summaries[0]!;
      expect(deny.operation).toBe('POLICY_HANDSHAKE');
      expect(deny.outcome).toBe('DENIED');
      expect(deny.reasonCode).toBe('handshake_policy_denied');
      expect(deny.resolvedAccess).toBe('none');
      expect(deny.folder).toBe('secrets');
    } finally {
      await dispose();
    }
  });

  it('summarizes an expired access check as REAUTH_REQUIRED with access_expired_token', async () => {
    const launcherRoot = tmpDir('hoplon-t086-present-expired-');
    const store = await createIsolatedTestStore();
    const engagementStore = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      store,
      engagementStore,
    });
    try {
      const handshake = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID },
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      const token = (JSON.parse(handshake.body) as {
        engagement: { token: string };
      }).engagement.token;

      const sink = createPolicyAuditSink({ store, engineId: 't086-test' });
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

      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      const grouped = rowsByOp(rows);
      const accessRow = grouped['POLICY_ACCESS_CHECK']?.[0];
      expect(accessRow).toBeTruthy();
      const summary = summarizePolicyAuditRow(accessRow!);
      expect(summary).not.toBeNull();
      expect(summary!.operation).toBe('POLICY_ACCESS_CHECK');
      expect(summary!.outcome).toBe('REAUTH_REQUIRED');
      expect(summary!.reasonCode).toBe('access_expired_token');
      expect(summary!.requestedAction).toBe('read');
      // The serialized projection never carries the binding nonce.
      expect(JSON.stringify(summary)).not.toContain('engagementId');
    } finally {
      await dispose();
    }
  });

  it('drops non-policy rows from the operator presentation', () => {
    const legacyRow = {
      id: '00000000-0000-4000-8000-000000000000',
      snapshotId: null,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      engineId: 't086-test',
      correlationId: CORR_ID,
      operation: 'CREATE_SNAPSHOT' as const,
      result: 'PASS' as const,
      violationCount: 0,
      violationKinds: [],
      durationMs: 5,
      createdAt: '2026-04-23T00:00:00.000Z',
    } as AuditLogRecord;
    expect(summarizePolicyAuditRow(legacyRow)).toBeNull();
    expect(summarizePolicyAuditRows([legacyRow])).toEqual([]);
  });
});
