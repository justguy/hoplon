/**
 * tests/mcp/projectsHandshakeTool.test.ts — packaged MCP handshake tool proof
 * for t-083.
 *
 * Asserts that `projects_handshake` registers only when a `launcherRoot` is
 * provided, and that the tool delegates to the shared
 * `issueProjectHandshake` implementation rather than inventing a second
 * handshake mechanism. We cover:
 *
 *   - tools/list surfaces `projects_handshake` when launcherRoot is set.
 *   - read_write happy path round-trips an envelope with canonical folder +
 *     opaque token.
 *   - default_fallback path returns resolution='default_fallback'.
 *   - invalid_folder returns an isError:true response with kind +
 *     reason preserved.
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

async function buildClient(launcherRoot: string) {
  const engine = makeMinimalMockEngine();
  const server = createHoplonMcpServer({ engine, launcherRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 't083-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

function seedRegisteredProject(launcherRoot: string, policy: FolderPolicy) {
  const projectFsRoot = tmpDir('hoplon-t083-mcp-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
}

describe('projects_handshake MCP tool (t-083)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  const policy: FolderPolicy = {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'secrets', access: 'none' },
    ],
  };

  it('is only registered when launcherRoot is supplied', async () => {
    const engine = makeMinimalMockEngine();
    const server = createHoplonMcpServer({ engine });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: 't083-no-root', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('projects_handshake');
  });

  it('lists projects_handshake when launcherRoot is provided', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-list-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('projects_handshake');
    const handshakeTool = tools.tools.find(
      (t) => t.name === 'projects_handshake',
    );
    expect(handshakeTool?.inputSchema.type).toBe('object');
    expect(handshakeTool?.description).toContain(
      'does not mutate project registration or folder policy',
    );
    expect(handshakeTool?.description).toContain('trusted local agent');
    expect(handshakeTool?.description).toContain('hoplon project register');
    expect(handshakeTool?.description).toContain('--folder-policy-file');
    expect(handshakeTool?.description).toContain('MCP-only agent');
    const props = handshakeTool?.inputSchema.properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('projectId');
    expect(props).toHaveProperty('folder');
  });

  it('returns registered project ids on unknown projectId', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-unknown-guidance-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'missing', folder: 'src' },
    });
    expect(resp.isError).toBe(true);
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      kind: string;
      requestedProjectId: string;
      registeredProjectIds: string[];
      help: string;
    };
    expect(body.kind).toBe('unknown_project');
    expect(body.requestedProjectId).toBe('missing');
    expect(body.registeredProjectIds).toEqual(['p1']);
    expect(body.help).toContain('projectId is case-sensitive');
  });

  it('issues a read_write envelope for a matched rule', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-rw-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src/hoplon' },
    });
    expect(resp.isError).toBeFalsy();
    const text = (resp.content as Array<{ type: string; text: string }>)[0]
      ?.text;
    const body = JSON.parse(text!) as {
      access: string;
      folder: string;
      resolution: string;
      engagement: { token: string };
    };
    expect(body.access).toBe('read_write');
    expect(body.folder).toBe('src/hoplon');
    expect(body.resolution).toBe('matched');
    expect(body.engagement.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns default_fallback for an unmatched folder', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-fallback-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'tooling' },
    });
    expect(resp.isError).toBeFalsy();
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { resolution: string; access: string };
    expect(body.resolution).toBe('default_fallback');
    expect(body.access).toBe('read_only');
  });

  it('issues an envelope for project-root folder spellings', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-root-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    for (const folder of ['', '.']) {
      const resp = await client.callTool({
        name: 'projects_handshake',
        arguments: { projectId: 'p1', folder },
      });
      expect(resp.isError).toBeFalsy();
      const body = JSON.parse(
        (resp.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { folder: string; resolution: string; access: string };
      expect(body.folder).toBe('');
      expect(body.resolution).toBe('default_fallback');
      expect(body.access).toBe('read_only');
    }
  });

  it('surfaces invalid_folder with reason on the MCP error envelope', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-bad-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: '/etc/passwd' },
    });
    expect(resp.isError).toBe(true);
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { error?: boolean; kind: string; reason?: string };
    expect(body.kind).toBe('invalid_folder');
    expect(body.reason).toBe('absolute_path');

    const dotSegment = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src/./hoplon' },
    });
    expect(dotSegment.isError).toBe(true);
    const dotBody = JSON.parse(
      (dotSegment.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { error?: boolean; kind: string; reason?: string };
    expect(dotBody.kind).toBe('invalid_folder');
    expect(dotBody.reason).toBe('dot_segment');
  });

  it('surfaces invalid_request for malformed handshake arguments', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-invalid-request-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const missingProject = await client.callTool({
      name: 'projects_handshake',
      arguments: { folder: 'src' },
    });
    expect(missingProject.isError).toBe(true);
    const missingBody = JSON.parse(
      (missingProject.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { error?: boolean; kind: string };
    expect(missingBody.kind).toBe('invalid_request');

    const emptyPrincipal = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'p1', folder: 'src', principalId: '' },
    });
    expect(emptyPrincipal.isError).toBe(true);
    const emptyBody = JSON.parse(
      (emptyPrincipal.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { error?: boolean; kind: string };
    expect(emptyBody.kind).toBe('invalid_request');
  });

  it('surfaces unknown_project with registered ids and recovery help', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-unknown-project-');
    seedRegisteredProject(launcherRoot, policy);
    const client = await buildClient(launcherRoot);

    const resp = await client.callTool({
      name: 'projects_handshake',
      arguments: { projectId: 'ghost', folder: 'src' },
    });
    expect(resp.isError).toBe(true);
    const body = JSON.parse(
      (resp.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      error?: boolean;
      kind: string;
      requestedProjectId: string;
      registeredProjectIds: string[];
      help: string;
    };
    expect(body.kind).toBe('unknown_project');
    expect(body.requestedProjectId).toBe('ghost');
    expect(body.registeredProjectIds).toEqual(['p1']);
    expect(body.help).toContain('same launcher root');
    expect(body.help).toContain('MCP agents cannot register projects');
    expect(body.help).toContain('trusted host-shell authority');
  });

  it('preserves no_folder_policy for concrete and root folders', async () => {
    const launcherRoot = tmpDir('hoplon-t083-mcp-no-policy-');
    const projectFsRoot = tmpDir('hoplon-t083-mcp-no-policy-fsroot-');
    const manager = openLauncherProjects(launcherRoot);
    manager.register({ projectId: 'raw', fsRoot: projectFsRoot });
    const client = await buildClient(launcherRoot);

    for (const folder of ['src', '', '.']) {
      const resp = await client.callTool({
        name: 'projects_handshake',
        arguments: { projectId: 'raw', folder },
      });
      expect(resp.isError).toBe(true);
      const body = JSON.parse(
        (resp.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        error?: boolean;
        kind: string;
        requestedProjectId: string;
        help: string;
        guidance?: {
          policySurface: { mutation: string };
          onboarding: { agentMcp: string; hostCli: string };
          nextSteps: string[];
        };
      };
      expect(body.kind).toBe('no_folder_policy');
      expect(body.requestedProjectId).toBe('raw');
      expect(body.help).toContain('--folder-policy-file');
      expect(body.help).toContain('trusted host-shell authority');
      expect(body.guidance?.policySurface.mutation).toBe(
        'not_exposed_by_agent_mcp',
      );
      expect(body.guidance?.onboarding.agentMcp).toBe(
        'inspect_and_handshake_only',
      );
      expect(body.guidance?.onboarding.hostCli).toContain(
        'hoplon project register',
      );
      expect(body.guidance?.nextSteps.join(' ')).toContain('folder policy');
    }
  });
});
