/**
 * tests/transport/http/projectsHandshakeRouteAuthz.test.ts — T-146
 * adapter-routed HTTP handshake proof.
 *
 * Verifies the typed escalation / approval / deny shapes the route
 * emits when an explicit `AuthorizationAdapter` is injected. The
 * default static path is covered by the existing
 * `projectsHandshakeRoute.test.ts`; this file pins the dynamic-adapter
 * surface so a future OPA injection cannot regress it silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../../src/hoplon/transport/http/server.js';
import { openLauncherProjects } from '../../../src/hoplon/launcher/projects.js';
import { __resetEngagementStoresForTests } from '../../../src/hoplon/launcher/handshake.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { FolderPolicy } from '../../../src/hoplon/concurrency/projectPolicy.js';
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
      startedAt: '2026-05-03T00:00:00Z',
      capabilities: [],
      adapters: {},
    }),
  } as unknown as HoplonEngine;
}

function policyDoc(): FolderPolicy {
  return {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'secrets', access: 'none' },
    ],
  };
}

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

async function buildServer(opts: {
  launcherRoot: string;
  policy: FolderPolicy;
  adapter?: AuthorizationAdapter;
}): Promise<{ server: FastifyInstance; dispose: () => Promise<void> }> {
  fs.mkdirSync(opts.launcherRoot, { recursive: true });
  const fsRoot = tmpDir('hoplon-t146-fsroot-');
  const manager = openLauncherProjects(opts.launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot,
    policy: { folderPolicy: opts.policy },
  });
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot: opts.launcherRoot,
    ...(opts.adapter !== undefined
      ? { authorizationAdapter: opts.adapter }
      : {}),
  });
  return {
    server,
    dispose: async () => {
      await server.close();
    },
  };
}

describe('POST /projects/handshake (T-146 dynamic adapter responses)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('emits 202 with typed `requires_escalation` envelope (no token)', async () => {
    const launcherRoot = tmpDir('hoplon-t146-http-esc-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['**'], branches: ['**'] } },
      reason: 'Write requires CTO approval',
      decisionId: 'dec-esc-http-1',
      policyVersion: 'opa-bundle-test',
    }));
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: policyDoc(),
      adapter,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      expect(resp.statusCode).toBe(202);
      const body = JSON.parse(resp.body) as Record<string, unknown>;
      expect(body['kind']).toBe('requires_escalation');
      expect(body['escalationKind']).toBe('cto_approval');
      expect(body['decisionId']).toBe('dec-esc-http-1');
      expect(body['policyVersion']).toBe('opa-bundle-test');
      // No engagement / capabilityToken in the body.
      expect(body['engagement']).toBeUndefined();
      expect(body['capabilityToken']).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('emits 202 with typed `requires_approval` envelope (no token)', async () => {
    const launcherRoot = tmpDir('hoplon-t146-http-app-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_approval',
      escalationKind: 'human_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'human-in-loop',
      decisionId: 'dec-app-http-1',
      policyVersion: 'opa-bundle-test',
    }));
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: policyDoc(),
      adapter,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      expect(resp.statusCode).toBe(202);
      const body = JSON.parse(resp.body) as Record<string, unknown>;
      expect(body['kind']).toBe('requires_approval');
      expect(body['escalationKind']).toBe('human_approval');
      expect(body['engagement']).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('emits 403 deny with decisionId+policyVersion when adapter denies', async () => {
    const launcherRoot = tmpDir('hoplon-t146-http-deny-');
    const adapter = new FakeAdapter(() => ({
      outcome: 'deny',
      reason: 'Branch policy denied',
      decisionId: 'dec-deny-http-1',
      policyVersion: 'opa-bundle-test',
    }));
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: policyDoc(),
      adapter,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as {
        error: {
          class: string;
          kind: string;
          decisionId?: string;
          policyVersion?: string;
        };
      };
      expect(body.error.class).toBe('HandshakeError');
      expect(body.error.kind).toBe('policy_denied');
      expect(body.error.decisionId).toBe('dec-deny-http-1');
      expect(body.error.policyVersion).toBe('opa-bundle-test');
    } finally {
      await dispose();
    }
  });

  it('fail-closes adapter exceptions to a 403 deny envelope', async () => {
    const launcherRoot = tmpDir('hoplon-t146-http-throw-');
    const adapter: AuthorizationAdapter = {
      evaluateAccess: () =>
        Promise.reject(new Error('OPA sidecar timed out')),
    };
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: policyDoc(),
      adapter,
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      expect(resp.statusCode).toBe(403);
      const body = JSON.parse(resp.body) as {
        error: { kind: string; decisionId?: string };
      };
      expect(body.error.kind).toBe('policy_denied');
      expect(body.error.decisionId).toMatch(/^adapter-error-/);
    } finally {
      await dispose();
    }
  });

  it('allow body additively carries kind, capabilityToken, capabilities, decisionId, policyVersion', async () => {
    const launcherRoot = tmpDir('hoplon-t146-http-allow-');
    // No adapter override → default static.
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: policyDoc(),
    });
    try {
      const resp = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as Record<string, unknown>;
      // Legacy fields preserved.
      expect(body['access']).toBe('read_write');
      expect(body['folder']).toBe('src');
      expect(body['resolution']).toBe('matched');
      // T-146 additions.
      expect(body['kind']).toBe('allow');
      expect(body['capabilityToken']).toBeDefined();
      expect(body['capabilities']).toBeDefined();
      expect(body['decisionId']).toBeTruthy();
      expect(body['policyVersion']).toMatch(/static-folder-policy/);
      expect(body['expiresInSeconds']).toBe(60);
      expect(body['source']).toBe('standing_policy');
    } finally {
      await dispose();
    }
  });
});
