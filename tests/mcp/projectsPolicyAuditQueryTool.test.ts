/**
 * tests/mcp/projectsPolicyAuditQueryTool.test.ts — t-089 proof for the
 * packaged `projects_policy_audit` MCP tool.
 *
 * Wires `createHoplonMcpServer` with a launcher root, a registered
 * project, and an injected sqlite snapshot store seeded with mixed
 * grant / deny / reauth / revoked rows. Asserts the MCP surface returns
 * the same shape the HTTP route does and never leaks the engagement
 * binding nonce.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import {
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
} from '../../src/hoplon/launcher/handshake.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
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

const PROJECT_ID = 'p-mcp';
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
    engineId: 'mcp-test',
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
      engagementId: 'server-private-nonce-MCP',
      detail: null,
    },
    ...overrides,
  };
}

async function buildClient(opts: {
  launcherRoot: string;
  store?: SnapshotStore;
}): Promise<{
  client: Client;
  store: SnapshotStore;
  dispose: () => Promise<void>;
}> {
  fs.mkdirSync(opts.launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t089-mcp-fs-');
  const manager = openLauncherProjects(opts.launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const store = opts.store ?? (await createIsolatedTestStore());
  const engagementStore = createInMemoryEngagementStore();
  const server = createHoplonMcpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot: opts.launcherRoot,
    engagementStore,
    snapshotStore: store,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't089-mcp-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client, store, dispose: async () => client.close() };
}

interface ToolResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}

interface SuccessBody {
  projectId: string;
  entries: Array<Record<string, unknown>>;
  limit: number;
}

interface ErrorBody {
  error: true;
  kind: string;
  message: string;
}

async function callPolicyAudit(
  client: Client,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name: 'projects_policy_audit',
    arguments: args,
  })) as unknown as ToolResult;
}

describe('projects_policy_audit MCP tool (t-089)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('lists read-only onboarding guidance in the MCP tool description', async () => {
    const store = await createIsolatedTestStore();
    const { client, dispose } = await buildClient({
      launcherRoot: tmpDir('t089-mcp-list-'),
      store,
    });
    try {
      const tools = await client.listTools();
      const auditTool = tools.tools.find(
        (t) => t.name === 'projects_policy_audit',
      );
      expect(auditTool?.description).toContain(
        'MCP cannot mutate registration or folder policy',
      );
      expect(auditTool?.description).toContain('hoplon project register');
      expect(auditTool?.description).toContain('--folder-policy-file');
      expect(auditTool?.description).toContain('host/admin HTTP');
    } finally {
      await dispose();
    }
  });

  it('returns mixed events sorted reverse-chronologically with no engagement nonce in the JSON', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(
      row('2026-04-20T10:00:00.000Z', { result: 'GRANTED' }),
    );
    await store.appendAuditLog(
      row('2026-04-20T11:00:00.000Z', {
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
      row('2026-04-20T12:00:00.000Z', {
        operation: 'POLICY_REVOKE',
        result: 'REVOKED',
        policyEvent: {
          reasonCode: 'revoke_completed',
          requestedAction: 'revoke',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'server-private-nonce-MCP',
          detail: null,
        },
      }),
    );
    const { client, dispose } = await buildClient({
      launcherRoot: tmpDir('t089-mcp-mix-'),
      store,
    });
    try {
      const resp = await callPolicyAudit(client, { projectId: PROJECT_ID });
      expect(resp.isError).toBeFalsy();
      const text = resp.content[0]!.text;
      expect(text).not.toContain('server-private-nonce-MCP');
      const body = JSON.parse(text) as SuccessBody;
      expect(body.entries.map((e) => e['outcome'])).toEqual([
        'REVOKED',
        'DENIED',
        'GRANTED',
      ]);
      expect(body.entries.every((e) => !('engagementId' in e))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('returns isError for unknown project', async () => {
    const { client, dispose } = await buildClient({
      launcherRoot: tmpDir('t089-mcp-unknown-'),
    });
    try {
      const resp = await callPolicyAudit(client, { projectId: 'no-such' });
      expect(resp.isError).toBe(true);
      const body = JSON.parse(resp.content[0]!.text) as ErrorBody;
      expect(body.kind).toBe('unknown_project');
    } finally {
      await dispose();
    }
  });

  it('returns isError for ambiguous principal filter', async () => {
    const { client, dispose } = await buildClient({
      launcherRoot: tmpDir('t089-mcp-principal-'),
    });
    try {
      const resp = await callPolicyAudit(client, {
        projectId: PROJECT_ID,
        principalFilter: 'none',
        principalId: 'alice',
      });
      expect(resp.isError).toBe(true);
      const body = JSON.parse(resp.content[0]!.text) as ErrorBody;
      expect(body.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });

  it('returns isError when limit exceeds the contract bound', async () => {
    const { client, dispose } = await buildClient({
      launcherRoot: tmpDir('t089-mcp-limit-'),
    });
    try {
      const resp = await callPolicyAudit(client, {
        projectId: PROJECT_ID,
        limit: 9999,
      });
      expect(resp.isError).toBe(true);
      const body = JSON.parse(resp.content[0]!.text) as ErrorBody;
      expect(body.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });
});
