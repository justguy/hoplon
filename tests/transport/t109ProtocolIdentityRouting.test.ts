import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';
import { createHoplonEngineRouter, createProjectRegistry } from '../../src/hoplon/concurrency/index.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { SemanticError } from '../../src/hoplon/contracts/errors.js';

const SNAPSHOT_REF_ID = `sha256:${'a'.repeat(64)}`;
const CREATED_AT = '2026-04-28T00:00:00Z';

function engineWith(overrides: Partial<HoplonEngine>): HoplonEngine {
  return overrides as unknown as HoplonEngine;
}

function seeRequest(projectId: string | undefined): Record<string, unknown> {
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    runId: 'run-t109',
    correlationId: 'corr-t109',
    intent: 'read_exact_text',
    targets: [{ kind: 'file', path: 'src/a.ts' }],
    mode: 'raw',
  };
}

function snapshotManifest(projectId: string | undefined): Record<string, unknown> {
  return {
    manifestSchemaVersion: 1,
    ...(projectId !== undefined ? { projectId } : {}),
    runId: 'run-t109',
    correlationId: 'corr-t109',
    entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
  };
}

function injectFetchAdapter(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const parsed = new URL(url);
    const res = await server.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: parsed.pathname + parsed.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body as string | undefined,
    });
    return new Response(res.rawPayload, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as typeof globalThis.fetch;
}

async function createRoutingServer(
  engines: ReadonlyMap<string, HoplonEngine>,
  defaultProjectId = 'alpha',
): Promise<FastifyInstance> {
  const registry = createProjectRegistry();
  for (const projectId of engines.keys()) {
    registry.register({ projectId, fsRoot: `/tmp/t109-${projectId}` });
  }
  const router = createHoplonEngineRouter({
    registry,
    buildEngine: async (project) => {
      const engine = engines.get(project.projectId);
      if (!engine) throw new Error(`Missing test engine for ${project.projectId}`);
      return engine;
    },
  });
  const engine = engines.get(defaultProjectId);
  if (!engine) throw new Error(`Missing default test engine for ${defaultProjectId}`);
  return createHoplonHttpServer({ engine, projectRouter: router });
}

describe('t-109 HTTP protocol identity and routing corpus', () => {
  it('routes an explicit registered projectId to that project engine', async () => {
    const alphaSee = vi.fn(async () => ({ routedProjectId: 'alpha' }));
    const betaSee = vi.fn(async () => ({ routedProjectId: 'beta' }));
    const engines = new Map<string, HoplonEngine>([
      ['alpha', engineWith({ seeCodebase: alphaSee })],
      ['beta', engineWith({ seeCodebase: betaSee })],
    ]);
    const server = await createRoutingServer(engines);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: seeRequest('beta'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ routedProjectId: string }>().routedProjectId).toBe('beta');
      expect(betaSee).toHaveBeenCalledOnce();
      expect(alphaSee).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('omitted projectId on a project-scoped route fails validation instead of choosing a registered project', async () => {
    const defaultSee = vi.fn(async () => ({ routedProjectId: 'alpha' }));
    const defaultEngine = engineWith({ seeCodebase: defaultSee });
    const server = await createRoutingServer(
      new Map([
        ['alpha', defaultEngine],
        ['beta', defaultEngine],
      ]),
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: seeRequest(undefined),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { class: string; kind: string } }>();
      expect(body.error.class).toBe('ValidationError');
      expect(body.error.kind).toBe('invalid_scope');
      expect(defaultSee).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('malformed projectId on a project-scoped route fails validation before engine dispatch', async () => {
    const defaultSee = vi.fn(async () => ({ routedProjectId: 'alpha' }));
    const server = await createRoutingServer(
      new Map([['alpha', engineWith({ seeCodebase: defaultSee })]]),
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: seeRequest(''),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { class: string; kind: string } }>();
      expect(body.error.class).toBe('ValidationError');
      expect(body.error.kind).toBe('invalid_scope');
      expect(defaultSee).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('routes manifest-nested projectId for createSnapshot without a top-level projectId', async () => {
    const alphaSnapshot = vi.fn(async () => ({
      snapshotRef: { id: SNAPSHOT_REF_ID, engineId: 'alpha', runId: 'run-t109', createdAt: CREATED_AT },
      warnings: [],
    }));
    const betaSnapshot = vi.fn(async () => ({
      snapshotRef: { id: SNAPSHOT_REF_ID, engineId: 'beta', runId: 'run-t109', createdAt: CREATED_AT },
      warnings: [],
    }));
    const engines = new Map<string, HoplonEngine>([
      ['alpha', engineWith({ createSnapshot: alphaSnapshot })],
      ['beta', engineWith({ createSnapshot: betaSnapshot })],
    ]);
    const server = await createRoutingServer(engines);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/createSnapshot',
        payload: { manifest: snapshotManifest('beta') },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ snapshotRef: { engineId: string } }>().snapshotRef.engineId).toBe('beta');
      expect(betaSnapshot).toHaveBeenCalledOnce();
      expect(alphaSnapshot).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('unknown manifest-nested projectId returns a typed SemanticError envelope', async () => {
    const alphaSnapshot = vi.fn(async () => ({
      snapshotRef: { id: SNAPSHOT_REF_ID, engineId: 'alpha', runId: 'run-t109', createdAt: CREATED_AT },
      warnings: [],
    }));
    const server = await createRoutingServer(
      new Map([['alpha', engineWith({ createSnapshot: alphaSnapshot })]]),
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/createSnapshot',
        payload: { manifest: snapshotManifest('ghost') },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<{ error: { class: string; kind: string } }>();
      expect(body.error.class).toBe('SemanticError');
      expect(body.error.kind).toBe('unknown_project');
      expect(alphaSnapshot).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('unknown projectId returns a typed SemanticError envelope, not a generic routing failure', async () => {
    const server = await createRoutingServer(
      new Map([['alpha', engineWith({ seeCodebase: vi.fn() })]]),
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: seeRequest('ghost'),
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<{
        error: { class: string; kind: string; correlationId: string; message: string };
      }>();
      expect(body.error.class).toBe('SemanticError');
      expect(body.error.kind).toBe('unknown_project');
      expect(body.error.correlationId).toBe('parse');
      expect(body.error.message).toMatch(/explicit registered projectId/);
    } finally {
      await server.close();
    }
  });

  it('HTTP client/server preserves manifest-version skew as a typed SemanticError', async () => {
    const server = await createHoplonHttpServer({
      engine: engineWith({
        auditDiff: async () => {
          throw new SemanticError(
            {
              kind: 'manifest_version_mismatch',
              engineId: 'engine-t109',
              correlationId: 'corr-t109',
            },
            'Snapshot manifest schema version is newer than this client supports',
          );
        },
      }),
    });
    const client = createRemoteHoplonEngine({
      baseUrl: 'http://t109.local',
      fetchImpl: injectFetchAdapter(server),
    });

    try {
      await expect(
        client.auditDiff({
          snapshotRefId: SNAPSHOT_REF_ID,
          projectId: 'proj-t109',
          runId: 'run-t109',
          correlationId: 'corr-t109',
          files: ['src/a.ts'],
        }),
      ).rejects.toMatchObject({
        name: 'SemanticError',
        kind: 'manifest_version_mismatch',
        correlationId: 'corr-t109',
      });
    } finally {
      await server.close();
    }
  });

  it('HTTP client treats response schema-version drift as a transport malformed_response', async () => {
    const client = createRemoteHoplonEngine({
      baseUrl: 'http://t109.local',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            catalogVersion: 2,
            engineId: 'remote-t109',
            capabilities: [],
          }),
          { status: 200 },
        )) as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.describeCapabilities({ correlationId: 'corr-t109' }),
    ).rejects.toMatchObject({
      name: 'TransportError',
      kind: 'malformed_response',
      correlationId: 'corr-t109',
    });
  });
});
