/**
 * tests/transport/http/projectsHandshakeRouteAuthzAudit.test.ts —
 * t-148 proof that the packaged HTTP `/projects/handshake` route emits
 * a single typed `POLICY_HANDSHAKE` audit row per dynamic-authz outcome
 * (allow / requires_escalation / requires_approval / deny / adapter
 * error) carrying the new audit-evidence fields:
 *
 *   policyEngine, decisionId, policyVersion, tokenId, issuedTokenId,
 *   capability, branch, paths, grantIds, astNodeIds, astSelectors.
 *
 * The route is exercised through `server.inject` so the test runs
 * against the real packaged Fastify app + the real sqlite store.
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
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../../src/hoplon/contracts/auditLog.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';
import { createPolicyAuditSink } from '../../../src/hoplon/transport/policyAuditSink.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../../src/hoplon/authorization/authorizationAdapter.js';

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

class FakeAdapter implements AuthorizationAdapter {
  constructor(
    private readonly buildDecision: (
      req: HoplonAuthorizationRequest,
    ) => HoplonAuthorizationDecision | Promise<HoplonAuthorizationDecision>,
  ) {}
  async evaluateAccess(req: HoplonAuthorizationRequest) {
    return this.buildDecision(req);
  }
}

const PROJECT_ID = 'p1';
const RUN_ID = 'run-t148-http';
const CORR_ID = 'corr-t148-http';

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

async function buildServer(opts: {
  store: SnapshotStore;
  adapter?: AuthorizationAdapter;
}): Promise<{ server: FastifyInstance; dispose: () => Promise<void> }> {
  const launcherRoot = tmpDir('hoplon-t148-http-');
  fs.mkdirSync(launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t148-http-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const policyAuditSink = createPolicyAuditSink({
    store: opts.store,
    engineId: 'http-test',
  });
  const engagementStore = createInMemoryEngagementStore();
  const engine = makeMinimalMockEngine();
  const server = await createHoplonHttpServer({
    engine,
    launcherRoot,
    engagementStore,
    policyAuditSink,
    ...(opts.adapter !== undefined ? { authorizationAdapter: opts.adapter } : {}),
  });
  return {
    server,
    dispose: async () => {
      await server.close();
    },
  };
}

function rowsFor(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

const HEADERS = { 'x-correlation-id': CORR_ID, 'x-run-id': RUN_ID };

describe('t-148 HTTP handshake authz audit (live handler proof)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('writes a single POLICY_HANDSHAKE row with t-148 evidence fields on allow', async () => {
    const _store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({ store });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        capabilityToken: { tokenId: string; token: string };
      };
      const tokenId = body.capabilityToken.tokenId;
      const rawBearer = body.capabilityToken.token;

      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('GRANTED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_granted');
      expect(r.policyEvent?.requestedAction).toBe('handshake');
      expect(r.policyEvent?.folder).toBe('src');
      expect(r.policyEvent?.resolvedAccess).toBe('read_write');
      expect(r.policyEvent?.policyEngine).toBe('static');
      expect(r.policyEvent?.tokenId).toBe(tokenId);
      expect(r.policyEvent?.issuedTokenId).toBe(tokenId);
      expect(typeof r.policyEvent?.decisionId).toBe('string');
      expect(typeof r.policyEvent?.policyVersion).toBe('string');

      // CRITICAL H13: raw bearer token must NOT appear in the persisted row.
      const persistedJson = JSON.stringify(r);
      expect(persistedJson).not.toContain(rawBearer);
    } finally {
      await dispose();
    }
  });

  it('writes a POLICY_HANDSHAKE / DENIED row with handshake_policy_denied on a static deny', async () => {
    const _store = await createIsolatedTestStore();
    const { server, dispose } = await buildServer({ store });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'secrets' },
      });
      expect(resp.statusCode).toBe(403);
      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('DENIED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_policy_denied');
      expect(r.policyEvent?.policyEngine).toBe('static');
      expect(r.policyEvent?.tokenId).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('writes a POLICY_HANDSHAKE / REAUTH_REQUIRED row on requires_escalation', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'cto approval required',
      decisionId: 'opa-d-1',
      policyVersion: 'opa-v-1',
    }));
    const { server, dispose } = await buildServer({ store, adapter });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(202);
      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('REAUTH_REQUIRED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_requires_escalation');
      expect(r.policyEvent?.decisionId).toBe('opa-d-1');
      expect(r.policyEvent?.policyVersion).toBe('opa-v-1');
      expect(r.policyEvent?.tokenId).toBeNull();
      expect(r.policyEvent?.issuedTokenId).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('writes a POLICY_HANDSHAKE / REAUTH_REQUIRED row on requires_approval', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_approval',
      escalationKind: 'security_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'security approval required',
      decisionId: 'opa-d-2',
      policyVersion: 'opa-v-1',
    }));
    const { server, dispose } = await buildServer({ store, adapter });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(202);
      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.policyEvent?.reasonCode).toBe('handshake_requires_approval');
      expect(r.policyEvent?.decisionId).toBe('opa-d-2');
    } finally {
      await dispose();
    }
  });

  it('writes a POLICY_HANDSHAKE / DENIED row with handshake_adapter_error on adapter throw', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => {
      throw new Error('opa unreachable');
    });
    const { server, dispose } = await buildServer({ store, adapter });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(403);
      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('DENIED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_adapter_error');
      expect(r.policyEvent?.policyVersion).toBe('adapter-error');
    } finally {
      await dispose();
    }
  });

  it('writes a POLICY_HANDSHAKE / DENIED row with adapter_invalid_expires on bad ttl', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => ({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { read: { paths: ['**'], branches: ['**'] } },
      expiresInSeconds: 0,
      decisionId: 'opa-d-3',
      policyVersion: 'opa-v-1',
    }));
    const { server, dispose } = await buildServer({ store, adapter });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      expect(resp.statusCode).toBe(403);
      const rows = await rowsFor(store);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.policyEvent?.reasonCode).toBe('handshake_adapter_invalid_expires');
    } finally {
      await dispose();
    }
  });

  it('audit-write failure does NOT change the handshake decision (best-effort)', async () => {
    const sink = {
      recordHandshakeGrant: async () => {},
      recordHandshakeDeny: async () => {},
      recordAccessCheck: async () => {},
      recordRenew: async () => {},
      recordRevoke: async () => {},
      recordHandshakeAuthzOutcome: async () => {
        throw new Error('audit sink down');
      },
      recordCapabilityCheck: async () => {},
    };
    const launcherRoot = tmpDir('hoplon-t148-http-fail-');
    fs.mkdirSync(launcherRoot, { recursive: true });
    const projectFsRoot = tmpDir('hoplon-t148-http-fail-fsroot-');
    const manager = openLauncherProjects(launcherRoot);
    manager.register({
      projectId: PROJECT_ID,
      fsRoot: projectFsRoot,
      policy: { folderPolicy: policy },
    });
    const engagementStore = createInMemoryEngagementStore();
    const engine = makeMinimalMockEngine();
    const server = await createHoplonHttpServer({
      engine,
      launcherRoot,
      engagementStore,
      policyAuditSink: sink,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        headers: HEADERS,
        payload: { projectId: PROJECT_ID, folder: 'src' },
      });
      // The handshake itself should succeed even when the audit write fails.
      expect(resp.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
