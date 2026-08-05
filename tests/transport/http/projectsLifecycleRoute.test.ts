/**
 * tests/transport/http/projectsLifecycleRoute.test.ts — packaged
 * HTTP surface proof for the t-084 engagement-token lifecycle.
 *
 * Exercises `POST /projects/renew`, `POST /projects/revoke`, and
 * `POST /projects/prune` via `fastify.inject()` on the real server.
 * The engagement store is injected directly through the server
 * option, so tests can pre-seed expired bindings without waiting on
 * wall-clock TTL.
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
} from '../../../src/hoplon/launcher/engagementStore.js';
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

async function buildServer(opts: {
  launcherRoot: string;
  policy: FolderPolicy;
  store: EngagementStore;
}): Promise<{ server: FastifyInstance; dispose: () => Promise<void> }> {
  const { launcherRoot, policy, store } = opts;
  const projectFsRoot = tmpDir('hoplon-t084-http-fsroot-');
  fs.mkdirSync(launcherRoot, { recursive: true });
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'p1',
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const server = await createHoplonHttpServer({
    engine: makeMinimalMockEngine(),
    launcherRoot,
    engagementStore: store,
  });
  return {
    server,
    dispose: async () => {
      await server.close();
    },
  };
}

const BASE_POLICY: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

describe('POST /projects/renew (t-084 HTTP surface)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('renews a live token and returns the new envelope', async () => {
    const launcherRoot = tmpDir('hoplon-t084-http-renew-');
    const store = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: BASE_POLICY,
      store,
    });
    try {
      const handshake = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src/hoplon' },
      });
      expect(handshake.statusCode).toBe(200);
      const issued = JSON.parse(handshake.body) as {
        engagement: { token: string };
      };
      const token = issued.engagement.token;

      const renew = await server.inject({
        method: 'POST',
        url: '/projects/renew',
        payload: { token },
      });
      expect(renew.statusCode).toBe(200);
      const body = JSON.parse(renew.body) as {
        kind: string;
        previousToken: string;
        result: { access: string; engagement: { token: string } };
      };
      expect(body.kind).toBe('renewed');
      expect(body.previousToken).toBe(token);
      expect(body.result.access).toBe('read_write');
      expect(body.result.engagement.token).not.toBe(token);
      expect(store.get(token)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('returns 401 reauth_required(expired) for a pre-seeded expired token', async () => {
    const launcherRoot = tmpDir('hoplon-t084-http-expired-');
    const store = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: BASE_POLICY,
      store,
    });
    try {
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

      const renew = await server.inject({
        method: 'POST',
        url: '/projects/renew',
        payload: { token: expiredToken },
      });
      expect(renew.statusCode).toBe(401);
      const body = JSON.parse(renew.body) as {
        error: { kind: string; reason: string };
      };
      expect(body.error.kind).toBe('reauth_required');
      expect(body.error.reason).toBe('expired');
      expect(store.get(expiredToken)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('returns 400 invalid_request when token is missing', async () => {
    const launcherRoot = tmpDir('hoplon-t084-http-badreq-');
    const store = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: BASE_POLICY,
      store,
    });
    try {
      const renew = await server.inject({
        method: 'POST',
        url: '/projects/renew',
        payload: {},
      });
      expect(renew.statusCode).toBe(400);
      const body = JSON.parse(renew.body) as { error: { kind: string } };
      expect(body.error.kind).toBe('invalid_request');
    } finally {
      await dispose();
    }
  });
});

describe('POST /projects/revoke (t-084 HTTP surface)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('revokes a live token and a second revoke returns 404 missing_token', async () => {
    const launcherRoot = tmpDir('hoplon-t084-http-revoke-');
    const store = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: BASE_POLICY,
      store,
    });
    try {
      const handshake = await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      const issued = JSON.parse(handshake.body) as {
        engagement: { token: string };
      };
      const token = issued.engagement.token;

      const first = await server.inject({
        method: 'POST',
        url: '/projects/revoke',
        payload: { token },
      });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ kind: 'revoked' });
      expect(store.get(token)).toBeNull();

      const second = await server.inject({
        method: 'POST',
        url: '/projects/revoke',
        payload: { token },
      });
      expect(second.statusCode).toBe(404);
      expect((JSON.parse(second.body) as { error: { kind: string } }).error.kind).toBe(
        'missing_token',
      );
    } finally {
      await dispose();
    }
  });
});

describe('POST /projects/prune (t-084 HTTP surface)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('removes only the expired bindings and reports the count', async () => {
    const launcherRoot = tmpDir('hoplon-t084-http-prune-');
    const store = createInMemoryEngagementStore();
    const { server, dispose } = await buildServer({
      launcherRoot,
      policy: BASE_POLICY,
      store,
    });
    try {
      // Issue one live binding, then pre-seed two stale ones.
      await server.inject({
        method: 'POST',
        url: '/projects/handshake',
        payload: { projectId: 'p1', folder: 'src' },
      });
      store.put('stale-a'.padEnd(64, '0'), {
        projectId: 'p1',
        folder: 'docs',
        access: 'read_only',
        principalId: null,
        issuedAtIso: '2025-01-01T00:00:00.000Z',
        expiresAtIso: '2025-01-01T00:01:00.000Z',
        nonce: 'x'.repeat(32),
      });
      store.put('stale-b'.padEnd(64, '0'), {
        projectId: 'p1',
        folder: 'docs/arch',
        access: 'read_only',
        principalId: null,
        issuedAtIso: '2025-01-01T00:00:00.000Z',
        expiresAtIso: '2025-01-01T00:02:00.000Z',
        nonce: 'y'.repeat(32),
      });

      const prune = await server.inject({ method: 'POST', url: '/projects/prune' });
      expect(prune.statusCode).toBe(200);
      const body = JSON.parse(prune.body) as { kind: string; removed: number };
      expect(body.kind).toBe('pruned');
      expect(body.removed).toBe(2);
      expect(store.get('stale-a'.padEnd(64, '0'))).toBeNull();
      expect(store.get('stale-b'.padEnd(64, '0'))).toBeNull();
    } finally {
      await dispose();
    }
  });
});
