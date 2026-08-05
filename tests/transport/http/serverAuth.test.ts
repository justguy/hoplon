/**
 * tests/transport/http/serverAuth.test.ts — hcr-003 regression suite.
 *
 * Finding 3: the documented HTTP auth registry was dead code — the server
 * exposed no auth option and never invoked runAuth(), so a non-loopback bind
 * was silently unauthenticated. These tests pin the fix:
 *
 *  (a) When an `authRegistry` is configured, `runAuth()` runs on EVERY request
 *      before routing (engine RPC, health, projects registration). Missing or
 *      bad credentials → 401 with the transport's typed error envelope; valid
 *      credentials pass through to the handler.
 *  (b) Startup guard: binding to a non-loopback host with no auth is refused
 *      unless the caller passes the explicit `allowUnauthenticated` override.
 *      Loopback binds with no auth keep today's behavior exactly.
 *
 * All requests use fastify.inject() — no sockets, no network. The projects
 * fixtures use OS temp dirs only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../../src/hoplon/transport/http/server.js';
import {
  createAuthRegistry,
  createBearerTokenAuthMiddleware,
} from '../../../src/hoplon/transport/http/auth.js';
import type { AuthRegistry } from '../../../src/hoplon/transport/http/auth.js';
import { EngineError } from '../../../src/hoplon/contracts/errors.js';
import { makeMockEngine, MANIFEST } from '../../session/helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'good-token-xyz';

function bearerRegistry(): AuthRegistry {
  const reg = createAuthRegistry();
  reg.registerAuthMiddleware(
    createBearerTokenAuthMiddleware({
      async verifyToken(token) {
        return token === VALID_TOKEN
          ? { engineId: 'eng-auth', principal: 'svc-acct' }
          : null;
      },
    }),
  );
  return reg;
}

const servers: FastifyInstance[] = [];
const tempDirs: string[] = [];

function track(server: FastifyInstance): FastifyInstance {
  servers.push(server);
  return server;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a) Auth enforcement on every request
// ---------------------------------------------------------------------------

describe('hcr-003 (a) — auth registry is enforced on every request', () => {
  it('no auth configured: engine RPC requests pass (behavior unchanged)', async () => {
    const server = track(await createHoplonHttpServer({ engine: makeMockEngine() }));
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
    });
    expect(res.statusCode).toBe(200);
  });

  it('configured auth: missing credentials → 401 with typed envelope on engine RPC route', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { class: string; kind: string } }>();
    expect(body.error.class).toBe('TransportError');
    expect(body.error.kind).toBe('auth_failed');
  });

  it('configured auth: bad token → 401', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('configured auth: valid token passes through to the engine', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('configured auth: missing credentials → 401 on GET /health', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(401);
  });

  it('configured auth: missing credentials → 401 on projects registration route', async () => {
    const launcherRoot = makeTempDir('hoplon-auth-launcher-');
    const fsRoot = makeTempDir('hoplon-auth-project-');
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        launcherRoot,
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/projects/register',
      payload: { projectId: 'p1', fsRoot },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { class: string; kind: string } }>();
    expect(body.error.class).toBe('TransportError');
    expect(body.error.kind).toBe('auth_failed');
  });

  it('configured auth: valid token passes through to projects registration route', async () => {
    const launcherRoot = makeTempDir('hoplon-auth-launcher-');
    const fsRoot = makeTempDir('hoplon-auth-project-');
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        launcherRoot,
        authRegistry: bearerRegistry(),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/projects/register',
      payload: { projectId: 'p1', fsRoot },
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ projectId: string }>();
    expect(body.projectId).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// (b) Startup guard for non-loopback binds
// ---------------------------------------------------------------------------

describe('hcr-003 (b) — non-loopback bind guard', () => {
  it('refuses to start on a non-loopback host with no auth configured', async () => {
    await expect(
      createHoplonHttpServer({ engine: makeMockEngine(), host: '0.0.0.0' }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('the refusal is a config_invalid EngineError with an actionable message', async () => {
    let caught: unknown;
    try {
      await createHoplonHttpServer({ engine: makeMockEngine(), host: '0.0.0.0' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).kind).toBe('config_invalid');
    expect((caught as EngineError).message).toContain('allowUnauthenticated');
  });

  it('accepts a non-loopback host with the explicit allowUnauthenticated override', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        host: '0.0.0.0',
        allowUnauthenticated: true,
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a non-loopback host when auth is configured, and still enforces it', async () => {
    const server = track(
      await createHoplonHttpServer({
        engine: makeMockEngine(),
        host: '0.0.0.0',
        authRegistry: bearerRegistry(),
      }),
    );
    const unauth = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
    });
    expect(unauth.statusCode).toBe(401);

    const auth = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(auth.statusCode).toBe(200);
  });

  it('loopback binds with no auth are unchanged (127.0.0.1, ::1, localhost)', async () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const server = track(
        await createHoplonHttpServer({ engine: makeMockEngine(), host }),
      );
      const res = await server.inject({
        method: 'POST',
        url: '/createSnapshot',
        payload: { manifest: MANIFEST },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('no host option: behavior is unchanged (no guard, no auth)', async () => {
    const server = track(await createHoplonHttpServer({ engine: makeMockEngine() }));
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: MANIFEST },
    });
    expect(res.statusCode).toBe(200);
  });
});
