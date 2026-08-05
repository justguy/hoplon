/**
 * tests/transport/grpc.equivalence.test.ts — EQ1 HTTP↔gRPC equivalence proof.
 *
 * Drives the same mock HoplonEngine through both transports (HTTP via fastify
 * + createRemoteHoplonEngine, gRPC via createHoplonGrpcServer + createRemote
 * HoplonGrpcEngine) and compares *normalized* client-visible behavior:
 *
 *   - Happy paths: deep-equal decoded result object
 *   - Error paths: same HoplonError subclass + same `kind`
 *   - Auth-failure row: both transports surface TransportError(auth_failed)
 *
 * We compare **decoded results and error identity**, never the raw transport
 * mechanics — HTTP 401 and gRPC UNAUTHENTICATED are not byte-identical and
 * never will be. The claim under test is semantic parity at the engine
 * boundary: a caller that `await`s either client gets the same value or the
 * same typed error for the same engine behavior.
 *
 * HTTP is driven via `fastify.inject()` wrapped in a fetch adapter so no real
 * sockets are needed. gRPC uses a real 127.0.0.1:0 socket because grpc-js has
 * no inject equivalent; either way both paths exercise their full stack.
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastifyFactory from 'fastify';
import type { FastifyInstance } from 'fastify';

// protobufjs Long patch — see grpc.server.test.ts.
const testRequire = createRequire(import.meta.url);
const longModule = testRequire('long') as { default?: unknown } & Record<string, unknown>;
const longCtor = typeof longModule === 'function' ? longModule : longModule.default ?? longModule;
for (const spec of ['protobufjs/minimal', 'protobufjs/light', 'protobufjs']) {
  const pb = testRequire(spec) as { util?: { Long?: unknown }; configure?: () => void };
  if (pb?.util) {
    pb.util.Long = longCtor;
    pb.configure?.();
  }
}

import { SemanticError } from '../../src/hoplon/contracts/errors.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { PackedContext } from '../../src/hoplon/contracts/context.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';
import { createHoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import type { HoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import { createRemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';
import type { RemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';

const ENGINE_ID = 'test-engine-eq1';
const CORR = 'corr-eq1';
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-04-13T00:00:00Z';

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-eq1',
  runId: 'run-eq1',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

const VALID_PACKED: PackedContext = {
  metadata: {
    strategyVersion: 1,
    grammarVersion: 'tree-sitter-typescript@0.20.0',
    packerVersion: 1,
    generatedAt: NOW,
    correlationId: CORR,
  },
  slices: [
    { path: 'src/a.ts', byteRange: [0, 10], nodeKinds: ['program'], content: 'export {};' },
    { path: 'src/b.ts', byteRange: [0, 12], nodeKinds: ['program'], content: 'export const y = 2;' },
  ],
  failures: [],
};

function buildMockEngine(overrides: Partial<HoplonEngine> = {}): HoplonEngine {
  const notImpl = (name: string) => (): never => {
    throw new Error(`EQ1 mock: ${name} not exercised`);
  };
  const defaults: HoplonEngine = {
    createSnapshot: async () => ({
      snapshotRef: { id: SNAPSHOT_ID, engineId: ENGINE_ID, runId: 'run-eq1', createdAt: NOW },
      warnings: [],
    }),
    auditDiff: async () => ({
      status: 'PASS' as const, checked: 1, auditSchemaVersion: 1, correlationId: CORR,
    }),
    revertUncontracted: async () => ({ reverted: [], deleted: [], allowlistSkipped: [] }),
    packContext: async () => VALID_PACKED,
    dryRun: async () => ({
      status: 'PASS' as const, checked: 1, auditSchemaVersion: 1, correlationId: CORR,
    }),
    preflight: async () => ({ status: 'PASS' as const, gates: [], correlationId: CORR }),
    health: async () => ({
      engineId: ENGINE_ID,
      adapters: {
        fs: 'ok' as const, versioning: 'ok' as const, snapshotStore: 'ok' as const,
        lockProvider: 'ok' as const, emitter: 'ok' as const, codeIntelligence: 'ok' as const,
        secretScanner: 'ok' as const, staticAnalysis: 'ok' as const,
      },
      uptimeMs: 1,
    }),
    describeCapabilities: async () => ({
      catalogVersion: 1, engineId: ENGINE_ID, capabilities: [],
    }),
    reconcile: async () => ({ reconciled: 0, failed: 0, orphans: { gitObjects: 0, pendingRows: 0 } }),
    queryStructure: notImpl('queryStructure') as unknown as HoplonEngine['queryStructure'],
    extractStructuralTemplate: notImpl('extractStructuralTemplate') as unknown as HoplonEngine['extractStructuralTemplate'],
    extractRollbackTemplate: notImpl('extractRollbackTemplate') as unknown as HoplonEngine['extractRollbackTemplate'],
    computeMinimalPatch: notImpl('computeMinimalPatch') as unknown as HoplonEngine['computeMinimalPatch'],
    compressRetryContext: notImpl('compressRetryContext') as unknown as HoplonEngine['compressRetryContext'],
    getRelevantTests: notImpl('getRelevantTests') as unknown as HoplonEngine['getRelevantTests'],
    analyzeBlastRadius: notImpl('analyzeBlastRadius') as unknown as HoplonEngine['analyzeBlastRadius'],
    findReferencingSymbols: notImpl('findReferencingSymbols') as unknown as HoplonEngine['findReferencingSymbols'],
    synthesizeInterfaceStubs: notImpl('synthesizeInterfaceStubs') as unknown as HoplonEngine['synthesizeInterfaceStubs'],
    ephemeralStructuralSandbox: notImpl('ephemeralStructuralSandbox') as unknown as HoplonEngine['ephemeralStructuralSandbox'],
    predictViolationRisk: notImpl('predictViolationRisk') as unknown as HoplonEngine['predictViolationRisk'],
    scoreAnomaly: notImpl('scoreAnomaly') as unknown as HoplonEngine['scoreAnomaly'],
    gc: async () => ({ deletedCount: 0 }),
  };
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// fastify.inject → fetch adapter. The HTTP client only uses the method, url,
// headers, body, signal, and reads `response.ok`, `response.status`,
// `response.text()`. A minimal Response is sufficient.
// ---------------------------------------------------------------------------

function injectFetchAdapter(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : (input as URL).toString();
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

// ---------------------------------------------------------------------------
// Dual-transport fixture
// ---------------------------------------------------------------------------

interface DualFixture {
  http: HoplonEngine;
  grpc: RemoteHoplonGrpcEngine;
  httpServer: FastifyInstance;
  grpcServer: HoplonGrpcServer;
}

async function makeFixture(
  engineOverrides: Partial<HoplonEngine> = {},
  opts: { grpcAuthReject?: boolean; httpAuthReject?: boolean } = {},
): Promise<DualFixture> {
  const engine = buildMockEngine(engineOverrides);

  // HTTP side
  const fastify = fastifyFactory({ logger: false });
  if (opts.httpAuthReject) {
    fastify.addHook('onRequest', async (_req, reply) => {
      await reply.status(401).send({
        error: {
          name: 'TransportError',
          kind: 'auth_failed',
          message: 'unauthorized',
          engineId: 'http-server',
          correlationId: CORR,
        },
      });
    });
  }
  const httpServer = await createHoplonHttpServer({ engine, fastify });
  await httpServer.ready();
  const http = createRemoteHoplonEngine({
    baseUrl: 'http://inject.local',
    engineId: 'client-http',
    fetchImpl: injectFetchAdapter(httpServer),
  });

  // gRPC side
  const grpcServer = await createHoplonGrpcServer({ engine });
  if (opts.grpcAuthReject) {
    grpcServer.authRegistry.registerAuthMiddleware({
      async authenticate() { return null; },
    });
  }
  const port = await grpcServer.start('127.0.0.1:0');
  const grpc = await createRemoteHoplonGrpcEngine({
    address: `127.0.0.1:${port}`,
    engineId: 'client-grpc',
  });

  return { http, grpc, httpServer, grpcServer };
}

async function teardown(f: DualFixture): Promise<void> {
  f.grpc.close();
  await f.grpcServer.stop(1000);
  await f.httpServer.close();
}

// ---------------------------------------------------------------------------
// Small equivalence helper — compare two promises for happy-path equivalence
// (deep-equal on decoded result) or error equivalence (same class + kind).
// ---------------------------------------------------------------------------

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; className: string; kind: string };

async function settle<T>(p: Promise<T>): Promise<Outcome> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { constructor: { name: string }; kind?: unknown };
    return {
      ok: false,
      className: e.constructor.name,
      kind: typeof e.kind === 'string' ? e.kind : 'unknown',
    };
  }
}

function expectEquivalent(httpOut: Outcome, grpcOut: Outcome): void {
  expect(grpcOut.ok).toBe(httpOut.ok);
  if (httpOut.ok && grpcOut.ok) {
    expect(grpcOut.value).toEqual(httpOut.value);
  } else if (!httpOut.ok && !grpcOut.ok) {
    expect(grpcOut.className).toBe(httpOut.className);
    expect(grpcOut.kind).toBe(httpOut.kind);
  }
}

// ---------------------------------------------------------------------------
// Happy-path corpus
// ---------------------------------------------------------------------------

describe('EQ1 — happy-path equivalence corpus', () => {
  let fx: DualFixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('health returns equivalent EngineHealth', async () => {
    const httpOut = await settle(fx.http.health());
    const grpcOut = await settle(fx.grpc.health());
    expectEquivalent(httpOut, grpcOut);
  });

  it('reconcile returns equivalent ReconcileResult', async () => {
    const httpOut = await settle(fx.http.reconcile());
    const grpcOut = await settle(fx.grpc.reconcile());
    expectEquivalent(httpOut, grpcOut);
  });

  it('createSnapshot returns equivalent SnapshotResult', async () => {
    const req = { manifest: VALID_MANIFEST };
    const httpOut = await settle(fx.http.createSnapshot(req));
    const grpcOut = await settle(fx.grpc.createSnapshot(req));
    expectEquivalent(httpOut, grpcOut);
  });

  it('gc returns equivalent GcResult', async () => {
    const httpOut = await settle(fx.http.gc({ projectId: 'proj-eq1' }));
    const grpcOut = await settle(fx.grpc.gc({ projectId: 'proj-eq1' }));
    expectEquivalent(httpOut, grpcOut);
  });

  it('describeCapabilities returns equivalent catalog', async () => {
    const req = { correlationId: CORR };
    const httpOut = await settle(fx.http.describeCapabilities(req));
    const grpcOut = await settle(fx.grpc.describeCapabilities(req));
    expectEquivalent(httpOut, grpcOut);
  });

  it('packContext reassembles to equivalent PackedContext across transports', async () => {
    const req = {
      projectId: 'proj-eq1',
      runId: 'run-eq1',
      correlationId: CORR,
      files: ['src/a.ts', 'src/b.ts'],
      strategy: { kind: 'whole_file' as const },
    };
    const httpOut = await settle(fx.http.packContext(req));
    const grpcOut = await settle(fx.grpc.packContext(req));
    expectEquivalent(httpOut, grpcOut);
    // Sanity: the decoded PackedContext equals the engine's output.
    expect((grpcOut as { ok: true; value: PackedContext }).value).toEqual(VALID_PACKED);
  });
});

// ---------------------------------------------------------------------------
// Error-path corpus — same engine behavior ⇒ same typed HoplonError on both.
// ---------------------------------------------------------------------------

describe('EQ1 — error-path equivalence corpus', () => {
  it('SemanticError round-trips with matching class + kind', async () => {
    const fx = await makeFixture({
      auditDiff: async () => {
        throw new SemanticError(
          { kind: 'snapshot_missing', engineId: ENGINE_ID, correlationId: CORR },
          'Snapshot not found',
        );
      },
    });
    try {
      const req = {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-eq1',
        runId: 'run-eq1',
        correlationId: CORR,
        files: ['src/foo.ts'],
      };
      const httpOut = await settle(fx.http.auditDiff(req));
      const grpcOut = await settle(fx.grpc.auditDiff(req));
      expect(httpOut.ok).toBe(false);
      expect(grpcOut.ok).toBe(false);
      expectEquivalent(httpOut, grpcOut);
      expect((grpcOut as { ok: false; className: string; kind: string }).className)
        .toBe('SemanticError');
      expect((grpcOut as { ok: false; className: string; kind: string }).kind)
        .toBe('snapshot_missing');
    } finally {
      await teardown(fx);
    }
  });
});

// ---------------------------------------------------------------------------
// Auth-failure row — both transports must surface TransportError(auth_failed)
// when their server denies authentication, even though the underlying wire
// status codes (HTTP 401 vs gRPC UNAUTHENTICATED) differ.
// ---------------------------------------------------------------------------

describe('EQ1 — auth-failure equivalence', () => {
  it('unauthorized call surfaces TransportError(auth_failed) on both transports', async () => {
    const fx = await makeFixture({}, { grpcAuthReject: true, httpAuthReject: true });
    try {
      const httpOut = await settle(fx.http.health());
      const grpcOut = await settle(fx.grpc.health());
      expect(httpOut.ok).toBe(false);
      expect(grpcOut.ok).toBe(false);
      expectEquivalent(httpOut, grpcOut);
      expect((grpcOut as { ok: false; className: string; kind: string }).className)
        .toBe('TransportError');
      expect((grpcOut as { ok: false; className: string; kind: string }).kind)
        .toBe('auth_failed');
    } finally {
      await teardown(fx);
    }
  });
});

// Silence unused-import warnings for Buffer — retained for future fixtures.
void Buffer;
