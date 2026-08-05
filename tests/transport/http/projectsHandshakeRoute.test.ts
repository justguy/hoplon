/**
 * tests/transport/http/projectsHandshakeRoute.test.ts — packaged HTTP
 * handshake surface proof for t-083.
 *
 * Exercises `POST /projects/handshake` over a live `createHoplonHttpServer`
 * via `fastify.inject()`. The engine facade is a light mock (health only);
 * the handshake lives on the launcher-projects router rather than the
 * engine, so no engine methods are invoked.
 *
 * Covers:
 *   - read_only matched rule → 200 with an envelope carrying read_only
 *     access, canonical folder, token, and ISO expiry.
 *   - read_write matched rule → 200 with read_write envelope.
 *   - default_fallback path → 200 with resolution='default_fallback'.
 *   - unknown_project → 404 with HandshakeError envelope.
 *   - invalid_folder → 400 with reason propagated.
 *   - policy_denied → 403.
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

function writePolicy(file: string, policy: FolderPolicy): void {
  fs.writeFileSync(file, JSON.stringify(policy));
}

async function buildServer(opts: {
  launcherRoot: string;
  policy: FolderPolicy;
  projectId?: string;
  projectFsRoot?: string;
}): Promise<{ server: FastifyInstance; dispose: () => Promise<void> }> {
  const { launcherRoot, policy } = opts;
  const projectFsRoot = opts.projectFsRoot ?? tmpDir('hoplon-t083-http-fsroot-');
  const policyFile = path.join(launcherRoot, 'policy.json');
  fs.mkdirSync(launcherRoot, { recursive: true });
  writePolicy(policyFile, policy);

  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: opts.projectId ?? 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });

  const engine = makeMinimalMockEngine();
  const store = createInMemoryEngagementStore();
  const server = await createHoplonHttpServer({
    engine,
    launcherRoot,
  });
  void store;
  return {
    server,
    dispose: async () => {
      await server.close();
    },
  };
}

describe('POST /projects/handshake (t-083 HTTP surface)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  const readWritePolicy: FolderPolicy = {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'docs', access: 'read_only' },
      { folder: 'secrets', access: 'none' },
    ],
  };

  it('returns a read_write envelope for a matched rule', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-lr-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src/hoplon' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        access: string;
        folder: string;
        resolution: string;
        engagement: { token: string; issuedAtIso: string; expiresAtIso: string };
      };
      expect(body.access).toBe('read_write');
      expect(body.folder).toBe('src/hoplon');
      expect(body.resolution).toBe('matched');
      expect(body.engagement.token).toMatch(/^[0-9a-f]{64}$/);
      expect(
        Date.parse(body.engagement.expiresAtIso) -
          Date.parse(body.engagement.issuedAtIso),
      ).toBe(60_000);
    } finally {
      await dispose();
    }
  });

  it('returns a read_only envelope for a matched read_only rule', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-ro-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'docs' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as { access: string; resolution: string };
      expect(body.access).toBe('read_only');
      expect(body.resolution).toBe('matched');
    } finally {
      await dispose();
    }
  });

  it('falls back to default_fallback when no rule matches', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-df-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'tools' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        access: string;
        resolution: string;
        matchedRule: unknown;
      };
      expect(body.resolution).toBe('default_fallback');
      expect(body.access).toBe('read_only');
      expect(body.matchedRule).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('accepts project-root folder spellings', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-root-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      for (const folder of ['', '.']) {
        const resp = await server.inject({
          method: 'POST',
          url: '/projects/handshake',
          payload: { projectId: 'p1', folder },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body) as {
          folder: string;
          access: string;
          resolution: string;
        };
        expect(body.folder).toBe('');
        expect(body.access).toBe('read_only');
        expect(body.resolution).toBe('default_fallback');
      }
    } finally {
      await dispose();
    }
  });

  it('returns 404 with HandshakeError kind unknown_project', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-unknown-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'ghost', folder: 'src' },
      });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body) as {
        error: {
          class: string;
          kind: string;
          requestedProjectId: string;
          registeredProjectIds: string[];
          help: string;
        };
      };
      expect(body.error.class).toBe('HandshakeError');
      expect(body.error.kind).toBe('unknown_project');
      expect(body.error.requestedProjectId).toBe('ghost');
      expect(body.error.registeredProjectIds).toEqual(['p1']);
      expect(body.error.help).toContain('projectId is case-sensitive');
      expect(body.error.help).toContain('same launcher root');
      expect(body.error.help).toContain('MCP agents cannot register projects');
      expect(body.error.help).toContain('trusted host-shell authority');
    } finally {
      await dispose();
    }
  });

  it('returns 400 with invalid_request for malformed handshake fields', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-invalid-request-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const missingProject = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { folder: 'src' },
      });
      expect(missingProject.statusCode).toBe(400);
      expect(
        (JSON.parse(missingProject.body) as { error: { kind: string } }).error
          .kind,
      ).toBe('invalid_request');

      const emptyPrincipal = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src', principalId: '' },
      });
      expect(emptyPrincipal.statusCode).toBe(400);
      expect(
        (JSON.parse(emptyPrincipal.body) as { error: { kind: string } }).error
          .kind,
      ).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });

  it('returns no_folder_policy for concrete and root folders when policy is absent', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-no-policy-');
    const projectFsRoot = tmpDir('hoplon-t083-http-no-policy-fsroot-');
    fs.mkdirSync(launcherRoot, { recursive: true });
    const manager = openLauncherProjects(launcherRoot);
    manager.register({ projectId: 'raw', fsRoot: projectFsRoot });
    const server = await createHoplonHttpServer({
      engine: makeMinimalMockEngine(),
      launcherRoot,
    });
    try {
      for (const folder of ['src', '', '.']) {
        const resp = await server.inject({
          method: 'POST',
          url: '/projects/handshake',
          payload: { projectId: 'raw', folder },
        });
        expect(resp.statusCode).toBe(409);
        const body = JSON.parse(resp.body) as {
          error: {
            kind: string;
            requestedProjectId: string;
            help: string;
            guidance?: {
              policySurface: { mutation: string };
              onboarding: { agentMcp: string; hostCli: string };
              nextSteps: string[];
            };
          };
        };
        expect(body.error.kind).toBe('no_folder_policy');
        expect(body.error.requestedProjectId).toBe('raw');
        expect(body.error.help).toContain('--folder-policy-file');
        expect(body.error.help).toContain('trusted host-shell authority');
        expect(body.error.guidance?.policySurface.mutation).toBe(
          'not_exposed_by_agent_mcp',
        );
        expect(body.error.guidance?.onboarding.agentMcp).toBe(
          'inspect_and_handshake_only',
        );
        expect(body.error.guidance?.onboarding.hostCli).toContain(
          'hoplon project register',
        );
        expect(body.error.guidance?.nextSteps.join(' ')).toContain(
          'folder policy',
        );
      }
    } finally {
      await server.close();
    }
  });

  it('returns 400 with invalid_folder reason for a malformed folder', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-bad-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: '/etc/passwd' },
      });
      expect(resp.statusCode).toBe(400);
      const body = JSON.parse(resp.body) as {
        error: { kind: string; reason?: string };
      };
      expect(body.error.kind).toBe('invalid_folder');
      expect(body.error.reason).toBe('absolute_path');

      const dotSegment = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src/./hoplon' },
      });
      expect(dotSegment.statusCode).toBe(400);
      const dotBody = JSON.parse(dotSegment.body) as {
        error: { kind: string; reason?: string };
      };
      expect(dotBody.error.kind).toBe('invalid_folder');
      expect(dotBody.error.reason).toBe('dot_segment');
    } finally {
      await dispose();
    }
  });

  it('returns 403 with policy_denied when access resolves to none', async () => {
    const launcherRoot = tmpDir('hoplon-t083-http-denied-');
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: readWritePolicy,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'secrets' },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as {
        error: { kind: string; access?: string };
      };
      expect(body.error.kind).toBe('policy_denied');
      expect(body.error.access).toBe('none');
    } finally {
      await dispose();
    }
  });
});
