/**
 * tests/mcp/projectsHandshakeToolAuthz.test.ts — T-146 adapter-routed
 * MCP `projects_handshake` proof.
 *
 * Pins the typed escalation / approval / deny shapes the tool emits
 * when an explicit `AuthorizationAdapter` is injected. The default
 * static path is covered by the existing `projectsHandshakeTool.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import { __resetEngagementStoresForTests } from '../../src/hoplon/launcher/handshake.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMinimalMockEngine(): HoplonEngine {
  return {
    health: async () => ({
      engineId: 'mock-engine',
      status: 'ok',
      version: '0.0.0-test',
      startedAt: '2026-05-03T00:00:00Z',
      capabilities: [],
      adapters: {},
    }),
  } as unknown as HoplonEngine;
}

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

class FakeAdapter implements AuthorizationAdapter {
  constructor(
    private readonly buildDecision: (
      r: HoplonAuthorizationRequest,
    ) => HoplonAuthorizationDecision | Promise<HoplonAuthorizationDecision>,
  ) {}
  async evaluateAccess(
    r: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision> {
    return await this.buildDecision(r);
  }
}

async function buildClient(
  launcherRoot: string,
  adapter?: AuthorizationAdapter,
) {
  const projectFsRoot = tmpDir('hoplon-t146-mcp-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const server = createHoplonMcpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    ...(adapter !== undefined ? { authorizationAdapter: adapter } : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't146-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

describe('projects_handshake MCP tool (T-146 dynamic adapter responses)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('emits typed `requires_escalation` envelope without isError', async () => {
    const launcherRoot = tmpDir('hoplon-t146-mcp-esc-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_escalation',
      escalationKind: 'security_approval',
      requestedScope: { write: { paths: ['**'], branches: ['**'] } },
      reason: 'Security approval required',
      decisionId: 'dec-mcp-esc-1',
      policyVersion: 'opa-bundle-test',
    }));
    const client = await buildClient(launcherRoot, adapter);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    expect(resp.isError).toBeFalsy();
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Record<string, unknown>;
    expect(body['kind']).toBe('requires_escalation');
    expect(body['escalationKind']).toBe('security_approval');
    expect(body['decisionId']).toBe('dec-mcp-esc-1');
    expect(body['policyVersion']).toBe('opa-bundle-test');
    expect(body['engagement']).toBeUndefined();
    expect(body['capabilityToken']).toBeUndefined();
  });

  it('emits typed `requires_approval` envelope without isError', async () => {
    const launcherRoot = tmpDir('hoplon-t146-mcp-app-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_approval',
      escalationKind: 'human_approval',
      requestedScope: { write: { paths: ['**'], branches: ['**'] } },
      reason: 'human-in-loop',
      decisionId: 'dec-mcp-app-1',
      policyVersion: 'opa-bundle-test',
    }));
    const client = await buildClient(launcherRoot, adapter);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    expect(resp.isError).toBeFalsy();
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Record<string, unknown>;
    expect(body['kind']).toBe('requires_approval');
    expect(body['decisionId']).toBe('dec-mcp-app-1');
  });

  it('translates adapter deny to a HandshakeError(policy_denied) error envelope', async () => {
    const launcherRoot = tmpDir('hoplon-t146-mcp-deny-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'deny',
      reason: 'Forbidden by branch policy',
      decisionId: 'dec-mcp-deny-1',
      policyVersion: 'opa-bundle-test',
    }));
    const client = await buildClient(launcherRoot, adapter);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    expect(resp.isError).toBe(true);
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { kind: string; decisionId?: string; policyVersion?: string };
    expect(body.kind).toBe('policy_denied');
    expect(body.decisionId).toBe('dec-mcp-deny-1');
    expect(body.policyVersion).toBe('opa-bundle-test');
  });

  it('fail-closes adapter exceptions to a policy_denied error envelope', async () => {
    const launcherRoot = tmpDir('hoplon-t146-mcp-throw-');
    const adapter: AuthorizationAdapter = {
      evaluateAccess: () =>
        Promise.reject(new Error('OPA sidecar timed out')),
    };
    const client = await buildClient(launcherRoot, adapter);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    expect(resp.isError).toBe(true);
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { kind: string; decisionId?: string };
    expect(body.kind).toBe('policy_denied');
    expect(body.decisionId).toMatch(/^adapter-error-/);
  });

  it('allow body extends the legacy result with kind/capabilityToken/capabilities/decisionId', async () => {
    const launcherRoot = tmpDir('hoplon-t146-mcp-allow-');
    const client = await buildClient(launcherRoot); // default static adapter.

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src' },
    });
    expect(resp.isError).toBeFalsy();
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Record<string, unknown>;
    expect(body['kind']).toBe('allow');
    expect(body['access']).toBe('read_write');
    expect(body['capabilityToken']).toBeDefined();
    expect(body['capabilities']).toBeDefined();
    expect(body['decisionId']).toBeTruthy();
    expect(body['policyVersion']).toMatch(/static-folder-policy/);
    expect(body['source']).toBe('standing_policy');
    expect(body['expiresInSeconds']).toBe(60);
  });
});
