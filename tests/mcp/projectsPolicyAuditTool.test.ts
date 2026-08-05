/**
 * tests/mcp/projectsPolicyAuditTool.test.ts — t-088 proof that the
 * packaged MCP `projects_handshake` / `projects_renew` / `projects_revoke`
 * tools emit durable `hoplon_audit_log` rows via the shared policy-audit
 * sink.
 *
 * Uses the in-memory sqlite `createIsolatedTestStore()` so assertions run
 * against the real shipped adapter. Tool calls pass `projectId` / `runId`
 * / `correlationId` in args so the default context resolver produces
 * deterministic audit scoping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import {
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
} from '../../src/hoplon/launcher/handshake.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

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

const PROJECT_ID = 'mcp-p1';
const RUN_ID = 'run-t088-mcp';
const CORR_ID = 'corr-t088-mcp';

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

async function buildClient(launcherRoot: string): Promise<{
  client: Client;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  dispose: () => Promise<void>;
}> {
  fs.mkdirSync(launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t088-mcp-fs-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });

  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const sink = createPolicyAuditSink({ store, engineId: 'mcp-test' });
  const engine = makeMinimalMockEngine();
  const server = createHoplonMcpServer({
    engine,
    launcherRoot,
    engagementStore,
    policyAuditSink: sink,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't088-mcp-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    store,
    engagementStore,
    dispose: async () => {
      await client.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

describe('t-088 MCP projects_* policy audit writes', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('emits POLICY_HANDSHAKE / GRANTED on successful projects_handshake', async () => {
    const { client, store, dispose } = await buildClient(
      tmpDir('hoplon-t088-mcp-grant-'),
    );
    try {
      const result = await callTool(client, 'projects_handshake', {
        projectId: PROJECT_ID,
        folder: 'src',
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      expect(result.isError).not.toBe(true);
      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('GRANTED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_granted');
      expect(r.policyEvent?.resolvedAccess).toBe('read_write');
      expect(r.policyEvent?.folder).toBe('src');
      expect(r.correlationId).toBe(CORR_ID);
    } finally {
      await dispose();
    }
  });

  it('emits POLICY_HANDSHAKE / DENIED with typed reason on policy_denied', async () => {
    const { client, store, dispose } = await buildClient(
      tmpDir('hoplon-t088-mcp-deny-'),
    );
    try {
      const result = await callTool(client, 'projects_handshake', {
        projectId: PROJECT_ID,
        folder: 'secrets',
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      expect(result.isError).toBe(true);
      const rows = await store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
      expect(rows.length).toBe(1);
      const r = rows[0]!;
      expect(r.operation).toBe('POLICY_HANDSHAKE');
      expect(r.result).toBe('DENIED');
      expect(r.policyEvent?.reasonCode).toBe('handshake_policy_denied');
      expect(r.policyEvent?.resolvedAccess).toBe('none');
    } finally {
      await dispose();
    }
  });

  it('emits POLICY_REVOKE / REVOKED and REAUTH_REQUIRED for known and unknown tokens', async () => {
    const { client, store, dispose } = await buildClient(
      tmpDir('hoplon-t088-mcp-revoke-'),
    );
    try {
      const handshake = await callTool(client, 'projects_handshake', {
        projectId: PROJECT_ID,
        folder: 'src',
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      const body = JSON.parse(handshake.content[0]!.text) as {
        engagement: { token: string };
      };
      const token = body.engagement.token;

      const revokeOk = await callTool(client, 'projects_revoke', {
        token,
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      expect(revokeOk.isError).not.toBe(true);

      const revokeMissing = await callTool(client, 'projects_revoke', {
        token: 'not-a-live-token',
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      expect(revokeMissing.isError).toBe(true);

      const projectRows = await store.findAuditLogByProjectAndRun(
        PROJECT_ID,
        RUN_ID,
      );
      const ok = projectRows.find((r) => r.operation === 'POLICY_REVOKE');
      expect(ok?.policyEvent?.reasonCode).toBe('revoke_completed');
      expect(ok?.policyEvent?.folder).toBe('src');
      expect(typeof ok?.policyEvent?.engagementId).toBe('string');
      expect(ok?.policyEvent?.engagementId).not.toBe(token);

      const unknownRows = await store.findAuditLogByProjectAndRun(
        'unknown',
        RUN_ID,
      );
      const missing = unknownRows.find((r) => r.operation === 'POLICY_REVOKE');
      expect(missing?.policyEvent?.reasonCode).toBe('revoke_missing_token');
    } finally {
      await dispose();
    }
  });

  it('emits POLICY_RENEW / REAUTH_REQUIRED with renew_reauth_missing for unknown tokens', async () => {
    const { client, store, dispose } = await buildClient(
      tmpDir('hoplon-t088-mcp-renew-missing-'),
    );
    try {
      const renew = await callTool(client, 'projects_renew', {
        token: 'not-a-live-token',
        runId: RUN_ID,
        correlationId: CORR_ID,
      });
      expect(renew.isError).toBe(true);
      const rows = await store.findAuditLogByProjectAndRun('unknown', RUN_ID);
      const renewRow = rows.find((r) => r.operation === 'POLICY_RENEW');
      expect(renewRow?.result).toBe('REAUTH_REQUIRED');
      expect(renewRow?.policyEvent?.reasonCode).toBe('renew_reauth_missing');
    } finally {
      await dispose();
    }
  });
});
