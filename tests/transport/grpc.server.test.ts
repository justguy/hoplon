/**
 * tests/transport/grpc.server.test.ts — SV1 gRPC server proof suite.
 *
 * Proves:
 *  1. Server boots on an ephemeral port and exposes the HoplonService surface.
 *  2. Unary round-trip: `health` (no request body) returns the mock engine
 *     health envelope.
 *  3. Unary round-trip with request body: `createSnapshot` succeeds and the
 *     response carries a schema-shaped `snapshotRef`.
 *  4. Streaming: `packContext` emits metadata → slice(s) → end frames; reassembly
 *     yields the PackedContext shape.
 *  5. Auth rejection: non-noop middleware returning `null` produces an
 *     UNAUTHENTICATED status with a `hoplon-error-bin` envelope.
 *  6. Error mapping: SemanticError → FAILED_PRECONDITION with envelope preserved.
 *
 * Tests boot the server over real gRPC sockets (127.0.0.1:0) and drive it with
 * a generic grpc-js client derived from the same committed proto.
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// protobufjs's `inquire("long")` fails under vitest's ESM context, leaving
// util.Long undefined and breaking @grpc/proto-loader with
// "util.Long.fromNumber is not a function". Plain CJS / native-ESM runs are
// fine — this patch is test-environment-only. Assigning the Long ctor before
// any proto load is the protobufjs-sanctioned workaround.
const testRequire = createRequire(import.meta.url);
const longModule = testRequire('long') as { default?: unknown } & Record<string, unknown>;
// Vitest's createRequire returns an ESM-interop shape `{ __esModule, default }`
// for the `long` package; pick the default if present, else the module itself.
const longCtor = typeof longModule === 'function' ? longModule : longModule.default ?? longModule;
for (const spec of ['protobufjs/minimal', 'protobufjs/light', 'protobufjs']) {
  const pb = testRequire(spec) as { util?: { Long?: unknown }; configure?: () => void };
  if (pb?.util) {
    pb.util.Long = longCtor;
    pb.configure?.();
  }
}

import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { SemanticError } from '../../src/hoplon/contracts/errors.js';
import { createHoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import type { HoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import { generateHoplonProto, HOPLON_PROTO_PACKAGE } from '../../src/hoplon/transport/proto/generate.js';

const ENGINE_ID = 'test-engine-grpc';
const CORR = 'corr-grpc-test';
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-04-13T00:00:00Z';

// ---------------------------------------------------------------------------
// Minimal mock engine — same shape as the HTTP suite uses
// ---------------------------------------------------------------------------

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
    preflight: async () => ({
      status: 'PASS' as const, gates: [], correlationId: CORR,
    }),
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
    extractRollbackTemplate: async () => ({ files: [], snapshotRef: SNAPSHOT_ID, generatedAt: NOW }),
    computeMinimalPatch: () => ({
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE' as const,
      violationRanges: [],
      keepRanges: [],
      retryPrompt: 'n/a',
      unpatchableViolations: [],
    }),
    compressRetryContext: () => ({
      attemptCount: 0,
      structuralDelta: '',
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
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

// ---------------------------------------------------------------------------
// Client helper — load proto via grpc-js + proto-loader, construct a generic
// service client bound to the running server.
// ---------------------------------------------------------------------------

interface TestClient {
  call: (rpcName: string, request: unknown) => Promise<{ error: ServiceErrorLike | null; response: unknown }>;
  stream: (rpcName: string, request: unknown) => Promise<{ frames: unknown[]; error: ServiceErrorLike | null }>;
  close: () => void;
}

interface ServiceErrorLike {
  code: number;
  details: string;
  metadata?: { get?: (k: string) => Array<string | Buffer> };
}

async function makeClient(port: number): Promise<TestClient> {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const protoText = generateHoplonProto();
  const dir = mkdtempSync(join(tmpdir(), 'hoplon-grpc-test-'));
  const file = join(dir, 'hoplon.proto');
  writeFileSync(file, protoText, 'utf8');
  const pkgDef = await loader.load(file, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  rmSync(dir, { recursive: true, force: true });

  const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as Record<string, unknown>;
  const pkgParts = HOPLON_PROTO_PACKAGE.split('.');
  let node: Record<string, unknown> = loaded;
  for (const part of pkgParts) {
    node = node[part] as Record<string, unknown>;
  }
  const ServiceCtor = node['HoplonService'] as unknown as new (
    address: string, creds: unknown,
  ) => Record<string, Function> & { close: () => void };
  const client = new ServiceCtor(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

  return {
    call(rpcName, request) {
      return new Promise((resolve) => {
        const fn = client[rpcName];
        fn.call(client, request, (err: ServiceErrorLike | null, response: unknown) => {
          resolve({ error: err, response });
        });
      });
    },
    stream(rpcName, request) {
      return new Promise((resolve) => {
        const fn = client[rpcName];
        const call = fn.call(client, request) as NodeJS.EventEmitter;
        const frames: unknown[] = [];
        let err: ServiceErrorLike | null = null;
        call.on('data', (frame: unknown) => frames.push(frame));
        call.on('error', (e: ServiceErrorLike) => { err = e; });
        call.on('end', () => resolve({ frames, error: err }));
        call.on('close', () => resolve({ frames, error: err }));
      });
    },
    close() { client.close(); },
  };
}

// ---------------------------------------------------------------------------
// Shared envelope helpers
// ---------------------------------------------------------------------------

function encodeEnvelopeForWire(body: unknown, correlationId = CORR): Record<string, unknown> {
  return {
    json_payload: Buffer.from(JSON.stringify(body), 'utf8'),
    correlation_id: correlationId,
    schema_name: 'request',
    schema_version: 1,
  };
}

function decodeEnvelopeFromWire(env: { json_payload?: Buffer | Uint8Array }): unknown {
  const payload = env.json_payload
    ? Buffer.from(env.json_payload as Buffer | Uint8Array).toString('utf8')
    : '';
  return payload ? JSON.parse(payload) : undefined;
}

// ---------------------------------------------------------------------------
// Server + client lifecycle helpers
// ---------------------------------------------------------------------------

interface Fixture {
  server: HoplonGrpcServer;
  client: TestClient;
  port: number;
}

async function makeFixture(overrides: Partial<HoplonEngine> = {}): Promise<Fixture> {
  const engine = buildMockEngine(overrides);
  const server = await createHoplonGrpcServer({ engine });
  const port = await server.start('127.0.0.1:0');
  const client = await makeClient(port);
  return { server, client, port };
}

async function teardown(f: Fixture): Promise<void> {
  f.client.close();
  await f.server.stop(1000);
}

// ---------------------------------------------------------------------------
// 1. Server boot + unary (no request body)
// ---------------------------------------------------------------------------

describe('gRPC SV1 — boot and unary with no body', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('binds an ephemeral port', () => {
    expect(fx.port).toBeGreaterThan(0);
    expect(fx.server.serviceName).toBe(`${HOPLON_PROTO_PACKAGE}.HoplonService`);
  });

  it('Health returns engine health inside a HoplonEnvelope', async () => {
    const result = await fx.client.call('Health', { correlation_id: CORR });
    expect(result.error).toBeNull();
    const body = decodeEnvelopeFromWire(result.response as { json_payload: Buffer }) as {
      engineId: string;
    };
    expect(body.engineId).toBe(ENGINE_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. Unary with request body
// ---------------------------------------------------------------------------

describe('gRPC SV1 — unary with request body', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('CreateSnapshot round-trips a manifest', async () => {
    const manifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-grpc',
      runId: 'run-grpc',
      correlationId: CORR,
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
    };
    const wire = encodeEnvelopeForWire({ manifest });
    const result = await fx.client.call('CreateSnapshot', wire);
    expect(result.error).toBeNull();
    const body = decodeEnvelopeFromWire(result.response as { json_payload: Buffer }) as {
      snapshotRef: { id: string };
    };
    expect(body.snapshotRef.id).toBe(SNAPSHOT_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. Streaming packContext
// ---------------------------------------------------------------------------

describe('gRPC SV1 — PackContext streaming', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  it('emits metadata + slices + end frames', async () => {
    const req = encodeEnvelopeForWire({
      projectId: 'proj-grpc',
      runId: 'run-grpc',
      correlationId: CORR,
      files: ['src/a.ts', 'src/b.ts'],
      strategy: { kind: 'whole_file' },
    });
    const result = await fx.client.stream('PackContext', req);
    expect(result.error).toBeNull();
    expect(result.frames.length).toBeGreaterThanOrEqual(4); // metadata + 2 slices + end

    const kinds = result.frames.map((f) => (f as { frame_kind: string }).frame_kind);
    expect(kinds[0]).toBe('metadata');
    expect(kinds[kinds.length - 1]).toBe('end');
    expect(kinds.filter((k) => k === 'slice').length).toBe(2);

    const metaFrame = result.frames[0] as { json_payload: Buffer };
    const meta = decodeEnvelopeFromWire(metaFrame) as { correlationId: string; failures: unknown[] };
    expect(meta.correlationId).toBe(CORR);
    expect(Array.isArray(meta.failures)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Auth rejection
// ---------------------------------------------------------------------------

describe('gRPC SV1 — auth rejection', () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await makeFixture();
    fx.server.authRegistry.registerAuthMiddleware({
      async authenticate() { return null; },
    });
  });
  afterAll(async () => { await teardown(fx); });

  it('Health returns UNAUTHENTICATED when middleware rejects', async () => {
    const result = await fx.client.call('Health', { correlation_id: CORR });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe(16); // UNAUTHENTICATED

    const metaBin = result.error!.metadata?.get?.('hoplon-error-bin') ?? [];
    expect(metaBin.length).toBeGreaterThan(0);
    const firstEntry = metaBin[0];
    expect(firstEntry).toBeDefined();
    const asBuffer = Buffer.isBuffer(firstEntry)
      ? firstEntry
      : Buffer.from(firstEntry as string, 'utf8');
    const envelope = JSON.parse(asBuffer.toString('utf8')) as { error: { class: string; kind: string } };
    expect(envelope.error.class).toBe('TransportError');
    expect(envelope.error.kind).toBe('auth_failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Error mapping — SemanticError → FAILED_PRECONDITION
// ---------------------------------------------------------------------------

describe('gRPC SV1 — error mapping', () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await makeFixture({
      auditDiff: async () => {
        throw new SemanticError(
          { kind: 'snapshot_missing', engineId: ENGINE_ID, correlationId: CORR },
          'Snapshot not found',
        );
      },
    });
  });
  afterAll(async () => { await teardown(fx); });

  it('maps SemanticError → FAILED_PRECONDITION with envelope', async () => {
    const wire = encodeEnvelopeForWire({
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-grpc',
      runId: 'run-grpc',
      correlationId: CORR,
      files: ['src/foo.ts'],
    });
    const result = await fx.client.call('AuditDiff', wire);
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe(9); // FAILED_PRECONDITION

    const metaBin = result.error!.metadata?.get?.('hoplon-error-bin') ?? [];
    const firstEntry = metaBin[0];
    expect(firstEntry).toBeDefined();
    const asBuffer = Buffer.isBuffer(firstEntry)
      ? firstEntry
      : Buffer.from(firstEntry as string, 'utf8');
    const envelope = JSON.parse(asBuffer.toString('utf8')) as {
      error: { class: string; kind: string; correlationId: string };
    };
    expect(envelope.error.class).toBe('SemanticError');
    expect(envelope.error.kind).toBe('snapshot_missing');
    expect(envelope.error.correlationId).toBe(CORR);
  });
});
