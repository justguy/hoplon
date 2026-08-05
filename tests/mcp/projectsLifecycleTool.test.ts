/**
 * tests/mcp/projectsLifecycleTool.test.ts — packaged MCP surface proof
 * for t-084 engagement-token lifecycle tools.
 *
 * Exercises `projects_renew`, `projects_revoke`, and `projects_prune`
 * over the real `createHoplonMcpServer` + in-memory MCP transport.
 * The engagement store is injected directly so tests can pre-seed
 * expired bindings and assert renewal returns `reauth_required` with
 * the typed reason.
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
  createInMemoryEngagementStore,
  __resetEngagementStoresForTests,
} from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
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

async function buildClient(launcherRoot: string, store: EngagementStore) {
  const engine = makeMinimalMockEngine();
  const server = createHoplonMcpServer({
    engine,
    launcherRoot,
    engagementStore: store,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't084-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

function seedRegisteredProject(launcherRoot: string, policy: FolderPolicy) {
  const projectFsRoot = tmpDir('hoplon-t084-mcp-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
}

function firstTextContent(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> })
    .content;
  if (!content || !content[0] || content[0].type !== 'text') {
    throw new Error('expected first content part to be text');
  }
  return content[0].text;
}

const BASE_POLICY: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

describe('projects_renew / projects_revoke / projects_prune (t-084 MCP surface)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('surfaces all three lifecycle tools in tools/list', async () => {
    const launcherRoot = tmpDir('hoplon-t084-mcp-list-');
    seedRegisteredProject(launcherRoot, BASE_POLICY);
    const store = createInMemoryEngagementStore();
    const client = await buildClient(launcherRoot, store);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain('projects_handshake');
    expect(names).toContain('projects_renew');
    expect(names).toContain('projects_revoke');
    expect(names).toContain('projects_prune');
  });

  it('renews a live handshake token', async () => {
    const launcherRoot = tmpDir('hoplon-t084-mcp-renew-');
    seedRegisteredProject(launcherRoot, BASE_POLICY);
    const store = createInMemoryEngagementStore();
    const client = await buildClient(launcherRoot, store);

    const handshake = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    const issued = JSON.parse(firstTextContent(handshake)) as {
      engagement: { token: string };
    };
    const token = issued.engagement.token;

    const renew = await client.callTool({
      name: 'projects_renew',
      arguments: { token },
    });
    const renewed = JSON.parse(firstTextContent(renew)) as {
      kind: string;
      previousToken: string;
      result: { access: string; engagement: { token: string } };
    };
    expect(renewed.kind).toBe('renewed');
    expect(renewed.previousToken).toBe(token);
    expect(renewed.result.engagement.token).not.toBe(token);
    expect(store.get(token)).toBeNull();
  });

  it('returns reauth_required(expired) when the token is already expired', async () => {
    const launcherRoot = tmpDir('hoplon-t084-mcp-expired-');
    seedRegisteredProject(launcherRoot, BASE_POLICY);
    const store = createInMemoryEngagementStore();
    const client = await buildClient(launcherRoot, store);

    const expiredToken = 'e'.repeat(64);
    store.put(expiredToken, {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2025-01-01T00:01:00.000Z',
      nonce: 'n'.repeat(32),
    });

    const renew = await client.callTool({
      name: 'projects_renew',
      arguments: { token: expiredToken },
    });
    expect(renew.isError).toBe(true);
    const payload = JSON.parse(firstTextContent(renew)) as {
      kind: string;
      reason: string;
    };
    expect(payload.kind).toBe('reauth_required');
    expect(payload.reason).toBe('expired');
    expect(store.get(expiredToken)).toBeNull();
  });

  it('revokes a live token and a subsequent revoke returns missing_token', async () => {
    const launcherRoot = tmpDir('hoplon-t084-mcp-revoke-');
    seedRegisteredProject(launcherRoot, BASE_POLICY);
    const store = createInMemoryEngagementStore();
    const client = await buildClient(launcherRoot, store);

    const handshake = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    const token = (
      JSON.parse(firstTextContent(handshake)) as {
        engagement: { token: string };
      }
    ).engagement.token;

    const first = await client.callTool({
      name: 'projects_revoke',
      arguments: { token },
    });
    expect(JSON.parse(firstTextContent(first))).toEqual({ kind: 'revoked' });
    expect(store.get(token)).toBeNull();

    const second = await client.callTool({
      name: 'projects_revoke',
      arguments: { token },
    });
    expect(second.isError).toBe(true);
    expect(
      (JSON.parse(firstTextContent(second)) as { kind: string }).kind,
    ).toBe('missing_token');
  });

  it('prune removes pre-seeded expired bindings and reports the count', async () => {
    const launcherRoot = tmpDir('hoplon-t084-mcp-prune-');
    seedRegisteredProject(launcherRoot, BASE_POLICY);
    const store = createInMemoryEngagementStore();
    const client = await buildClient(launcherRoot, store);

    await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    store.put('stale-token'.padEnd(64, '0'), {
      projectId: 'p1',
      folder: 'docs',
      access: 'read_only',
      principalId: null,
      issuedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2025-01-01T00:01:00.000Z',
      nonce: 'm'.repeat(32),
    });

    const prune = await client.callTool({
      name: 'projects_prune',
      arguments: {},
    });
    const report = JSON.parse(firstTextContent(prune)) as {
      kind: string;
      removed: number;
    };
    expect(report.kind).toBe('pruned');
    expect(report.removed).toBe(1);
    expect(store.get('stale-token'.padEnd(64, '0'))).toBeNull();
  });
});
