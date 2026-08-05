/**
 * tests/transport/http/projectsPolicySummaryRoute.test.ts — t-086 proof
 * for `GET /projects/policy/summary`.
 *
 * Mounts the live `createHoplonHttpServer` with a launcher root, an
 * injected engagement store with one live binding, and a minimal mock
 * engine. Asserts the read-only summary route returns folder-policy
 * shape + engagement-state counts and never leaks folder paths,
 * principal labels, or token bytes.
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
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';

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
    { folder: 'secrets', access: 'none' },
  ],
};
const FUTURE_EXPIRY_ISO = '2999-01-01T00:00:00.000Z';

async function buildServer(opts: {
  launcherRoot: string;
  engagementStore?: EngagementStore;
}): Promise<{
  server: FastifyInstance;
  dispose: () => Promise<void>;
}> {
  const { launcherRoot } = opts;
  fs.mkdirSync(launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t086-http-fs-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const engagementStore = opts.engagementStore ?? createInMemoryEngagementStore();
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    engagementStore,
  });
  return { server, dispose: async () => server.close() };
}

describe('GET /projects/policy/summary (t-086)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('returns 400 when projectId is missing or empty', async () => {
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('hoplon-t086-http-noid-'),
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects/policy/summary',
      });
      expect(resp.statusCode).toBe(400);
      const body = JSON.parse(resp.body) as { error: { kind: string } };
      expect(body.error.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });

  it('returns 404 with typed kind for an unknown project', async () => {
    const { server, dispose } = await buildServer({
      launcherRoot: tmpDir('hoplon-t086-http-unknown-'),
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects/policy/summary?projectId=nope',
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body) as {
        error: {
          kind: string;
          requestedProjectId: string;
          registeredProjectIds: string[];
          help: string;
          guidance: {
            policySurface: { mutation: string };
            onboarding: { hostCli: string };
          };
        };
      };
      expect(body.error.kind).toBe('unknown_project');
      expect(body.error.requestedProjectId).toBe('nope');
      expect(body.error.registeredProjectIds).toEqual(['p1']);
      expect(body.error.help).toContain('projectId is case-sensitive');
      expect(body.error.help).toContain('same launcher root');
      expect(body.error.help).toContain('MCP agents cannot register projects');
      expect(body.error.help).toContain('trusted host-shell authority');
      expect(body.error.guidance.policySurface.mutation).toBe(
        'not_exposed_by_agent_mcp',
      );
      expect(body.error.guidance.onboarding.hostCli).toContain(
        '--folder-policy-file',
      );
    } finally {
      await dispose();
    }
  });

  it('returns the policy + engagement summary without leaking folder paths or token bytes', async () => {
    const launcherRoot = tmpDir('hoplon-t086-http-summary-');
    const engagementStore = createInMemoryEngagementStore();
    engagementStore.put('TOKEN-XYZ', {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2026-04-23T00:00:00.000Z',
      expiresAtIso: FUTURE_EXPIRY_ISO,
      nonce: 'NONCE-XYZ',
    });
    const { server, dispose } = await buildServer({
      launcherRoot,
      engagementStore,
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects/policy/summary?projectId=p1',
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        projectId: string;
        policy: { folderPolicy?: { defaultAccess: string; folderRuleCount: number; principalCount: number; engagementTokenTtlMs: number } };
        engagementState: { active: number; activeReadWrite: number };
        guidance: {
          policySurface: { mutation: string };
          onboarding: { agentMcp: string; hostCli: string; hostHttp: string };
          nextSteps: string[];
        };
      };
      expect(body.projectId).toBe('p1');
      expect(body.policy.folderPolicy).toEqual({
        defaultAccess: 'read_only',
        folderRuleCount: 3,
        principalCount: 0,
        engagementTokenTtlMs: 60_000,
      });
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
      expect(resp.body).not.toContain('TOKEN-XYZ');
      expect(resp.body).not.toContain('NONCE-XYZ');
      expect(resp.body).not.toMatch(/"folder":"src"/);
    } finally {
      await dispose();
    }
  });

  it('uses the shared engagement store on the base projects report', async () => {
    const launcherRoot = tmpDir('hoplon-t086-http-projects-');
    const engagementStore = createInMemoryEngagementStore();
    engagementStore.put('TOKEN-PROJECTS', {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2026-04-23T00:00:00.000Z',
      expiresAtIso: FUTURE_EXPIRY_ISO,
      nonce: 'NONCE-PROJECTS',
    });
    const { server, dispose } = await buildServer({
      launcherRoot,
      engagementStore,
    });
    try {
      const resp = await server.inject({
        method: 'GET',
        url: '/projects',
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        registered: Array<{
          projectId: string;
          engagementState: { active: number; activeReadWrite: number };
        }>;
      };
      const entry = body.registered.find((p) => p.projectId === 'p1');
      expect(entry?.engagementState.active).toBe(1);
      expect(entry?.engagementState.activeReadWrite).toBe(1);
      expect(resp.body).not.toContain('TOKEN-PROJECTS');
      expect(resp.body).not.toContain('NONCE-PROJECTS');
      expect(resp.body).not.toMatch(/"folder":"src"/);
    } finally {
      await dispose();
    }
  });
});
