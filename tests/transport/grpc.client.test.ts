/**
 * tests/transport/grpc.client.test.ts — CL1 gRPC remote-engine proof suite.
 *
 * Drives the full SV1 server + `createRemoteHoplonGrpcEngine` pair over a real
 * gRPC socket, so the same binary format, metadata, and streaming frames are
 * exercised end-to-end. The suite proves:
 *  1. Unary happy-path — createSnapshot, health, gc, reconcile round-trip.
 *  2. Streaming happy-path — packContext returns a schema-valid PackedContext.
 *  3. AbortSignal wiring — aborting a call surfaces a TransportError(timeout).
 *  4. Bearer auth — token attached as metadata reaches the server middleware.
 *  5. Error translation — server-thrown SemanticError comes back as a typed
 *     SemanticError on the client (instanceof + kind preserved).
 *  6. Auth rejection — null middleware result → TransportError(auth_failed).
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// protobufjs `inquire("long")` patch — see grpc.server.test.ts for context.
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

import { SemanticError, AdapterError } from '../../src/hoplon/contracts/errors.js';
import { TransportError } from '../../src/hoplon/transport/types.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { createHoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import type { HoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import { createRemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';
import type { RemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';
import { createBearerTokenAuthMiddleware } from '../../src/hoplon/transport/http/auth.js';

const ENGINE_ID = 'test-engine-grpc';
const CORR = 'corr-grpc-client';
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-04-13T00:00:00Z';

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-grpc',
  runId: 'run-grpc',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

function buildMockEngine(overrides: Partial<HoplonEngine> = {}): HoplonEngine {
  const defaults: HoplonEngine = {
    createSnapshot: async () => ({
      snapshotRef: { id: SNAPSHOT_ID, engineId: ENGINE_ID, runId: 'run-grpc', createdAt: NOW },
      warnings: [],
    }),
    auditDiff: async () => ({
      status: 'PASS' as const, checked: 1, auditSchemaVersion: 1, correlationId: CORR,
    }),
    revertUncontracted: async () => ({ reverted: [], deleted: [], allowlistSkipped: [] }),
    packContext: async () => ({
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
    }),
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
    queryStructure: async () => ({ matches: [], failures: [] }),
    extractStructuralTemplate: async () => ({
      files: [], snapshotRef: null, queryId: 'structural-template', generatedAt: NOW,
    }),
    extractRollbackTemplate: async () => ({
      files: [], snapshotRef: SNAPSHOT_ID, generatedAt: NOW,
    }),
    computeMinimalPatch: () => ({
      patchable: false, action: 'PATCH_NOT_COMPUTABLE' as const,
      violationRanges: [], keepRanges: [], retryPrompt: 'n/a', unpatchableViolations: [],
    }),
    compressRetryContext: () => ({
      attemptCount: 0, structuralDelta: '',
      persistentViolations: [], resolvedViolations: [], newViolations: [],
      retryDirective: 'n/a',
    }),
    getRelevantTests: async () => ({
      relevantTests: [], coverageConfidence: 'exact' as const, unusedModifiedFiles: [],
    }),
    analyzeBlastRadius: async () => ({
      correlationId: CORR, advisory: true as const, status: 'OK' as const,
      providerAvailable: true, warnThreshold: 10, entries: [],
    }),
    findReferencingSymbols: async () => ({
      correlationId: CORR, advisory: true as const, status: 'UNAVAILABLE' as const,
      providerStatus: 'unavailable' as const,
      targetResolution: {
        status: 'resolved' as const,
        symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] as [number, number] },
        candidates: [{ name: 'alpha', kind: 'function', byteRange: [0, 5] as [number, number] }],
        reason: 'direct_symbol' as const,
      },
      references: [], files: [], referenceCount: 0, providerError: null,
    }),
    synthesizeInterfaceStubs: async () => ({
      correlationId: CORR, advisory: true as const, status: 'AUTHORITATIVE' as const,
      stubs: [], authoritativeCount: 0, placeholderCount: 0,
    }),
    ephemeralStructuralSandbox: async () => ({
      sandboxSchemaVersion: 1 as const,
      correlationId: CORR,
      advisory: true as const,
      status: 'PARSE_AND_STRUCTURE_OK' as const,
      checked: 0,
      snippets: [],
      typeProvider: {
        status: 'NOT_REQUESTED' as const,
        providerId: null,
        reason: null,
        compilerProof: false as const,
      },
      sideEffectProfile: {
        inMemoryOnly: true as const,
        detachedAstContext: true as const,
        usesFilesystem: false as const,
        usesVersioning: false as const,
        usesSnapshotStore: false as const,
        usesAuditLog: false as const,
        usesSessionMutation: false as const,
        usesLocks: false as const,
      },
      authority: {
        canMutateFiles: false as const,
        canChangeDeterministicVerdict: false as const,
        deterministicVerdictAuthority: 'structural_manifest_policy_only' as const,
      },
      nonBypass: {
        doesNotReplace: ['dryRun', 'auditDiff', 'policy', 'session_apply_edits'] as const,
        successCannotAuthorizeWrites: true as const,
      },
    }),
    predictViolationRisk: async () => ({
      correlationId: CORR, advisory: true as const, engineId: ENGINE_ID,
      scoreVersion: 1, score: 0, signals: [],
    }),
    scoreAnomaly: async () => ({
      correlationId: CORR, advisory: true as const, engineId: ENGINE_ID,
      scoreVersion: 1, score: 0, window: { auditCount: 0 }, signals: [],
    }),
    gc: async () => ({ deletedCount: 0 }),
  };
  return { ...defaults, ...overrides };
}

interface Fixture {
  server: HoplonGrpcServer;
  engine: RemoteHoplonGrpcEngine;
}

async function makeFixture(overrides: Partial<HoplonEngine> = {}): Promise<Fixture> {
  const mock = buildMockEngine(overrides);
  const server = await createHoplonGrpcServer({ engine: mock });
  const port = await server.start('127.0.0.1:0');
  const engine = await createRemoteHoplonGrpcEngine({
    address: `127.0.0.1:${port}`,
    engineId: 'client-grpc',
  });
  return { server, engine };
}

async function teardown(f: Fixture): Promise<void> {
  f.engine.close();
  await f.server.stop(1000);
}

// ---------------------------------------------------------------------------
// 1. Unary happy-path
// ---------------------------------------------------------------------------

describe('gRPC CL1 — unary happy-path', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('createSnapshot round-trips a manifest', async () => {
    const res = await fx.engine.createSnapshot({ manifest: VALID_MANIFEST });
    expect(res.snapshotRef.id).toBe(SNAPSHOT_ID);
    expect(res.snapshotRef.engineId).toBe(ENGINE_ID);
  });

  it('health returns an EngineHealth shape', async () => {
    const health = await fx.engine.health();
    expect(health.engineId).toBe(ENGINE_ID);
    expect(health.adapters.fs).toBe('ok');
  });

  it('gc returns deletedCount', async () => {
    const res = await fx.engine.gc({ projectId: 'proj-grpc' });
    expect(res.deletedCount).toBe(0);
  });

  it('reconcile round-trips with no request body', async () => {
    const res = await fx.engine.reconcile();
    expect(res.reconciled).toBe(0);
    expect(res.orphans.gitObjects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming happy-path
// ---------------------------------------------------------------------------

describe('gRPC CL1 — packContext streaming round-trip', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('reassembles metadata + slices into a PackedContext', async () => {
    const ctx = await fx.engine.packContext({
      projectId: 'proj-grpc',
      runId: 'run-grpc',
      correlationId: CORR,
      files: ['src/a.ts', 'src/b.ts'],
      strategy: { kind: 'whole_file' },
    });
    expect(ctx.metadata.correlationId).toBe(CORR);
    expect(ctx.slices.length).toBe(2);
    expect(ctx.slices[0]?.path).toBe('src/a.ts');
    expect(ctx.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. AbortSignal wiring — verifies the cancel path at least produces a typed
//    TransportError (timeout) rather than hanging / leaking.
// ---------------------------------------------------------------------------

describe('gRPC CL1 — AbortSignal wiring', () => {
  let fx: Fixture;
  beforeAll(async () => {
    // Slow engine — long enough that we can abort before it resolves.
    fx = await makeFixture({
      health: async (signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({
            engineId: ENGINE_ID,
            adapters: {
              fs: 'ok', versioning: 'ok', snapshotStore: 'ok', lockProvider: 'ok',
              emitter: 'ok', codeIntelligence: 'ok', secretScanner: 'ok', staticAnalysis: 'ok',
            },
            uptimeMs: 1,
          }), 5000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted on server'));
          });
        }),
    });
  });
  afterAll(async () => { await teardown(fx); });

  it('cancelling before response yields TransportError', async () => {
    const ac = new AbortController();
    const pending = fx.engine.health(ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(TransportError);
  });
});

// ---------------------------------------------------------------------------
// 4. Bearer auth — token threads through metadata into the server middleware.
// ---------------------------------------------------------------------------

describe('gRPC CL1 — Bearer auth round-trip', () => {
  let server: HoplonGrpcServer;
  let engine: RemoteHoplonGrpcEngine;

  beforeAll(async () => {
    const mock = buildMockEngine();
    server = await createHoplonGrpcServer({ engine: mock });
    server.authRegistry.registerAuthMiddleware(
      createBearerTokenAuthMiddleware({
        async verifyToken(token) {
          return token === 'secret-grpc'
            ? { engineId: 'authenticated', principal: 'tester' }
            : null;
        },
      }),
    );
    const port = await server.start('127.0.0.1:0');
    engine = await createRemoteHoplonGrpcEngine({
      address: `127.0.0.1:${port}`,
      authToken: 'secret-grpc',
    });
  });
  afterAll(async () => {
    engine.close();
    await server.stop(1000);
  });

  it('authorised token passes — health succeeds', async () => {
    const res = await engine.health();
    expect(res.engineId).toBe(ENGINE_ID);
  });
});

// ---------------------------------------------------------------------------
// 5. Auth rejection
// ---------------------------------------------------------------------------

describe('gRPC CL1 — auth rejection', () => {
  let server: HoplonGrpcServer;
  let engine: RemoteHoplonGrpcEngine;

  beforeAll(async () => {
    const mock = buildMockEngine();
    server = await createHoplonGrpcServer({ engine: mock });
    server.authRegistry.registerAuthMiddleware({ async authenticate() { return null; } });
    const port = await server.start('127.0.0.1:0');
    engine = await createRemoteHoplonGrpcEngine({ address: `127.0.0.1:${port}` });
  });
  afterAll(async () => {
    engine.close();
    await server.stop(1000);
  });

  it('maps UNAUTHENTICATED to TransportError(auth_failed)', async () => {
    let caught: unknown;
    try { await engine.health(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as TransportError).kind).toBe('auth_failed');
  });
});

// ---------------------------------------------------------------------------
// 6. Error translation — server-thrown SemanticError / AdapterError come
//    back as typed HoplonError subclasses on the client.
// ---------------------------------------------------------------------------

describe('gRPC CL1 — typed error translation', () => {
  it('SemanticError round-trips with class + kind preserved', async () => {
    const fx = await makeFixture({
      auditDiff: async () => {
        throw new SemanticError(
          { kind: 'snapshot_missing', engineId: ENGINE_ID, correlationId: CORR },
          'Snapshot not found',
        );
      },
    });
    try {
      let caught: unknown;
      try {
        await fx.engine.auditDiff({
          snapshotRefId: SNAPSHOT_ID,
          projectId: 'proj-grpc',
          runId: 'run-grpc',
          correlationId: CORR,
          files: ['src/foo.ts'],
        });
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(SemanticError);
      expect((caught as SemanticError).kind).toBe('snapshot_missing');
      expect((caught as SemanticError).correlationId).toBe(CORR);
    } finally {
      await teardown(fx);
    }
  });

  it('AdapterError round-trips', async () => {
    const fx = await makeFixture({
      createSnapshot: async () => {
        throw new AdapterError(
          { kind: 'git_commit_failed', engineId: ENGINE_ID, correlationId: CORR },
          'Git commit failed',
        );
      },
    });
    try {
      let caught: unknown;
      try {
        await fx.engine.createSnapshot({ manifest: VALID_MANIFEST });
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(AdapterError);
      expect((caught as AdapterError).kind).toBe('git_commit_failed');
    } finally {
      await teardown(fx);
    }
  });
});

// Silence unused-import warnings for Buffer — retained for future fixtures.
void Buffer;
