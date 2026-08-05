/**
 * tests/mcp/projectsPolicySummaryTool.test.ts — t-086 proof for the
 * `projects_policy_summary` MCP tool.
 *
 * Asserts the tool registers when a launcherRoot is supplied, returns
 * the same content-safe summary shape as the HTTP route, and surfaces
 * an `unknown_project` error envelope for an unregistered id.
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
} from '../../src/hoplon/launcher/handshake.js';
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

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'docs', access: 'read_only' },
  ],
};
const FUTURE_EXPIRY_ISO = '2999-01-01T00:00:00.000Z';

async function buildClient(opts: {
  launcherRoot: string;
  engagementStore?: EngagementStore;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const engine = makeMinimalMockEngine();
  const server = createHoplonMcpServer({
    engine,
    launcherRoot: opts.launcherRoot,
    ...(opts.engagementStore !== undefined
      ? { engagementStore: opts.engagementStore }
      : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't086-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client, close: async () => server.close() };
}

function seedRegisteredProject(launcherRoot: string): void {
  const projectFsRoot = tmpDir('hoplon-t086-mcp-fs-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
}

describe('projects_policy_summary MCP tool (t-086)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('lists the tool when launcherRoot is supplied', async () => {
    const launcherRoot = tmpDir('hoplon-t086-mcp-list-');
    seedRegisteredProject(launcherRoot);
    const { client, close } = await buildClient({ launcherRoot });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('projects_policy_summary');
      const summaryTool = tools.tools.find(
        (t) => t.name === 'projects_policy_summary',
      );
      expect(summaryTool?.description).toContain(
        'MCP cannot mutate registration or folder policy',
      );
      expect(summaryTool?.description).toContain('trusted local agent');
      expect(summaryTool?.description).toContain('hoplon project register');
      expect(summaryTool?.description).toContain('--folder-policy-file');
      expect(summaryTool?.description).toContain('host/operator');
    } finally {
      await close();
    }
  });

  it('returns the policy + engagement summary without leaking content-bearing fields', async () => {
    const launcherRoot = tmpDir('hoplon-t086-mcp-ok-');
    seedRegisteredProject(launcherRoot);
    const engagementStore = createInMemoryEngagementStore();
    engagementStore.put('TOKEN-MCP', {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2026-04-23T00:00:00.000Z',
      expiresAtIso: FUTURE_EXPIRY_ISO,
      nonce: 'NONCE-MCP',
    });
    const { client, close } = await buildClient({ launcherRoot, engagementStore });
    try {
      const result = await client.callTool({
        name: 'projects_policy_summary',
        arguments: { projectId: 'p1' },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      const body = JSON.parse(text) as {
        projectId: string;
        policy: { folderPolicy?: { folderRuleCount: number } };
        engagementState: { active: number; activeReadWrite: number };
        guidance: {
          policySurface: { mutation: string };
          onboarding: { agentMcp: string; hostCli: string; hostHttp: string };
          nextSteps: string[];
        };
      };
      expect(body.projectId).toBe('p1');
      expect(body.policy.folderPolicy?.folderRuleCount).toBe(2);
      expect(body.engagementState.active).toBe(1);
      expect(body.engagementState.activeReadWrite).toBe(1);
      expect(body.guidance.policySurface.mutation).toBe(
        'not_exposed_by_agent_mcp',
      );
      expect(body.guidance.onboarding.agentMcp).toBe(
        'inspect_and_handshake_only',
      );
      expect(body.guidance.onboarding.hostCli).toContain(
        'hoplon project register',
      );
      expect(body.guidance.onboarding.hostHttp).toContain(
        'POST /projects/register',
      );
      expect(body.guidance.nextSteps.join(' ')).toContain('projects_handshake');
      expect(text).not.toContain('TOKEN-MCP');
      expect(text).not.toContain('NONCE-MCP');
      expect(text).not.toMatch(/"folder":"src"/);
    } finally {
      await close();
    }
  });

  it('returns isError:true with kind=unknown_project for an unregistered id', async () => {
    const launcherRoot = tmpDir('hoplon-t086-mcp-unknown-');
    seedRegisteredProject(launcherRoot);
    const { client, close } = await buildClient({ launcherRoot });
    try {
      const result = await client.callTool({
        name: 'projects_policy_summary',
        arguments: { projectId: 'missing' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      const body = JSON.parse(text) as {
        kind: string;
        requestedProjectId: string;
        registeredProjectIds: string[];
        help: string;
        guidance: {
          policySurface: { mutation: string };
          onboarding: { hostCli: string };
        };
      };
      expect(body.kind).toBe('unknown_project');
      expect(body.requestedProjectId).toBe('missing');
      expect(body.registeredProjectIds).toEqual(['p1']);
      expect(body.help).toContain('projectId is case-sensitive');
      expect(body.help).toContain('same launcher root');
      expect(body.help).toContain('MCP agents cannot register projects');
      expect(body.help).toContain('trusted host-shell authority');
      expect(body.guidance.policySurface.mutation).toBe(
        'not_exposed_by_agent_mcp',
      );
      expect(body.guidance.onboarding.hostCli).toContain(
        '--folder-policy-file',
      );
    } finally {
      await close();
    }
  });

  it('returns isError:true with kind=invalid_request for missing projectId', async () => {
    const launcherRoot = tmpDir('hoplon-t086-mcp-invalid-');
    seedRegisteredProject(launcherRoot);
    const { client, close } = await buildClient({ launcherRoot });
    try {
      const result = await client.callTool({
        name: 'projects_policy_summary',
        arguments: { projectId: '' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      const body = JSON.parse(text) as { kind: string };
      expect(body.kind).toBe('invalid_request');
    } finally {
      await close();
    }
  });
});
