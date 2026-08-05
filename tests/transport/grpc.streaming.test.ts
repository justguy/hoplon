/**
 * tests/transport/grpc.streaming.test.ts — ST1 packContext streaming parity.
 *
 * Proves that gRPC's HoplonStreamFrame sequence matches the HTTP NDJSON frame
 * sequence frame-for-frame for the same engine output:
 *
 *   1. Frame-kind ordering identical: metadata, slice × N, end.
 *   2. Slice payloads identical and in the same order (H7 — path ASC,
 *      byteRange[0] ASC).
 *   3. Metadata frame carries identical core metadata + `failures` list on
 *      both transports.
 *   4. Reassembled PackedContext on both paths deep-equals the source packed
 *      context returned by the engine.
 *
 * Both paths are driven by the same mock engine so any divergence is a real
 * transport bug. The HTTP path uses `streamPackedContextNdjson` — the same
 * generator that feeds the HTTP server's NDJSON reply. The gRPC path observes
 * raw `HoplonStreamFrame` messages via a generic grpc-js client so we see the
 * exact wire sequence, not the client-side reassembly.
 *
 * No low-threshold fast path: gRPC always emits metadata, slice(s), end —
 * exactly like HTTP NDJSON. One reassembly contract serves both transports.
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

import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { PackedContext } from '../../src/hoplon/contracts/context.js';
import { PackedContextSchema } from '../../src/hoplon/contracts/context.js';
import { createHoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import type { HoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import {
  streamPackedContextNdjson,
} from '../../src/hoplon/transport/http/streaming.js';
import type {
  NdjsonFrame,
  MetadataFrameValue,
} from '../../src/hoplon/transport/http/streaming.js';
import {
  generateHoplonProto,
  HOPLON_PROTO_PACKAGE,
} from '../../src/hoplon/transport/proto/generate.js';

const CORR = 'corr-st1';
const NOW = '2026-04-13T00:00:00Z';

// ---------------------------------------------------------------------------
// Fixture: shared mock engine with a deterministic, H7-ordered PackedContext.
// Slices span three files so the parity check exercises more than a trivial
// pair; failures are non-empty so the metadata frame must embed them.
// ---------------------------------------------------------------------------

const PACKED: PackedContext = {
  metadata: {
    strategyVersion: 1,
    grammarVersion: 'tree-sitter-typescript@0.20.0',
    packerVersion: 1,
    generatedAt: NOW,
    correlationId: CORR,
  },
  slices: [
    { path: 'src/a.ts', byteRange: [0, 10], nodeKinds: ['program'], content: 'export {};' },
    { path: 'src/a.ts', byteRange: [10, 30], nodeKinds: ['lexical_declaration'], content: 'export const x = 1;\n' },
    { path: 'src/b.ts', byteRange: [0, 12], nodeKinds: ['program'], content: 'export const y = 2;' },
    { path: 'src/c.ts', byteRange: [0, 8], nodeKinds: ['program'], content: 'const z;' },
  ],
  failures: [
    { path: 'src/broken.ts', reason: 'parse_failure', parseError: 'Unexpected token' },
  ],
};

// Defensive: the fixture itself must be H24-valid. If this parse fails the
// test is nonsense.
PackedContextSchema.parse(PACKED);

function buildMockEngine(): HoplonEngine {
  const notImplemented = (): never => {
    throw new Error('ST1 mock: method not used in streaming parity test');
  };
  return {
    createSnapshot: notImplemented as unknown as HoplonEngine['createSnapshot'],
    auditDiff: notImplemented as unknown as HoplonEngine['auditDiff'],
    revertUncontracted: notImplemented as unknown as HoplonEngine['revertUncontracted'],
    packContext: async () => PACKED,
    dryRun: notImplemented as unknown as HoplonEngine['dryRun'],
    preflight: notImplemented as unknown as HoplonEngine['preflight'],
    health: notImplemented as unknown as HoplonEngine['health'],
    describeCapabilities: notImplemented as unknown as HoplonEngine['describeCapabilities'],
    reconcile: notImplemented as unknown as HoplonEngine['reconcile'],
    queryStructure: notImplemented as unknown as HoplonEngine['queryStructure'],
    extractStructuralTemplate: notImplemented as unknown as HoplonEngine['extractStructuralTemplate'],
    extractRollbackTemplate: notImplemented as unknown as HoplonEngine['extractRollbackTemplate'],
    computeMinimalPatch: notImplemented as unknown as HoplonEngine['computeMinimalPatch'],
    compressRetryContext: notImplemented as unknown as HoplonEngine['compressRetryContext'],
    getRelevantTests: notImplemented as unknown as HoplonEngine['getRelevantTests'],
    analyzeBlastRadius: notImplemented as unknown as HoplonEngine['analyzeBlastRadius'],
    findReferencingSymbols: notImplemented as unknown as HoplonEngine['findReferencingSymbols'],
    synthesizeInterfaceStubs: notImplemented as unknown as HoplonEngine['synthesizeInterfaceStubs'],
    ephemeralStructuralSandbox: notImplemented as unknown as HoplonEngine['ephemeralStructuralSandbox'],
    predictViolationRisk: notImplemented as unknown as HoplonEngine['predictViolationRisk'],
    scoreAnomaly: notImplemented as unknown as HoplonEngine['scoreAnomaly'],
    gc: notImplemented as unknown as HoplonEngine['gc'],
  };
}

// ---------------------------------------------------------------------------
// gRPC raw stream observer — load the committed proto, open a PackContext
// call, and return the HoplonStreamFrame sequence as decoded `{frame_kind,
// value}` tuples so we can compare frame-for-frame against the NDJSON path.
// ---------------------------------------------------------------------------

interface DecodedGrpcFrame {
  frame_kind: 'metadata' | 'slice' | 'end';
  value: unknown;
}

async function observeGrpcPackContextFrames(port: number): Promise<DecodedGrpcFrame[]> {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const protoText = generateHoplonProto();
  const dir = mkdtempSync(join(tmpdir(), 'hoplon-st1-'));
  const file = join(dir, 'hoplon.proto');
  writeFileSync(file, protoText, 'utf8');
  const pkgDef = await loader.load(file, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  rmSync(dir, { recursive: true, force: true });

  const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as Record<string, unknown>;
  let node: Record<string, unknown> = loaded;
  for (const part of HOPLON_PROTO_PACKAGE.split('.')) {
    node = node[part] as Record<string, unknown>;
  }
  const ServiceCtor = node['HoplonService'] as unknown as new (
    addr: string, creds: unknown,
  ) => Record<string, Function> & { close: () => void };
  const client = new ServiceCtor(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

  const requestBody = {
    projectId: 'proj-st1',
    runId: 'run-st1',
    correlationId: CORR,
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    strategy: { kind: 'whole_file' },
  };
  const requestEnvelope = {
    json_payload: Buffer.from(JSON.stringify(requestBody), 'utf8'),
    correlation_id: CORR,
    schema_name: 'request',
    schema_version: 1,
  };

  const frames: DecodedGrpcFrame[] = [];
  await new Promise<void>((resolve, reject) => {
    const call = client['PackContext']!.call(client, requestEnvelope) as NodeJS.EventEmitter;
    call.on('data', (frame: { frame_kind: string; json_payload?: Buffer | Uint8Array }) => {
      const kind = frame.frame_kind as DecodedGrpcFrame['frame_kind'];
      const payloadBuf = frame.json_payload
        ? Buffer.from(frame.json_payload as Buffer | Uint8Array)
        : Buffer.alloc(0);
      const value = payloadBuf.length > 0
        ? JSON.parse(payloadBuf.toString('utf8')) as unknown
        : undefined;
      frames.push({ frame_kind: kind, value });
    });
    call.on('error', reject);
    call.on('end', () => resolve());
  });
  client.close();
  return frames;
}

// ---------------------------------------------------------------------------
// HTTP NDJSON collector — drive streamPackedContextNdjson and decode each line
// into a structured frame so we can compare against gRPC.
// ---------------------------------------------------------------------------

async function collectNdjsonFrames(packed: PackedContext): Promise<NdjsonFrame[]> {
  const frames: NdjsonFrame[] = [];
  for await (const line of streamPackedContextNdjson(packed)) {
    expect(line.endsWith('\n')).toBe(true);
    const trimmed = line.trimEnd();
    frames.push(JSON.parse(trimmed) as NdjsonFrame);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

interface Fixture {
  server: HoplonGrpcServer;
  port: number;
}

async function makeFixture(): Promise<Fixture> {
  const engine = buildMockEngine();
  const server = await createHoplonGrpcServer({ engine });
  const port = await server.start('127.0.0.1:0');
  return { server, port };
}

async function teardown(f: Fixture): Promise<void> {
  await f.server.stop(1000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ST1 — packContext streaming parity (HTTP NDJSON ↔ gRPC frames)', () => {
  let fx: Fixture;
  let grpcFrames: DecodedGrpcFrame[];
  let httpFrames: NdjsonFrame[];

  beforeAll(async () => {
    fx = await makeFixture();
    [grpcFrames, httpFrames] = await Promise.all([
      observeGrpcPackContextFrames(fx.port),
      collectNdjsonFrames(PACKED),
    ]);
  });
  afterAll(async () => { await teardown(fx); });

  it('emits identical frame-kind sequences', () => {
    const grpcKinds = grpcFrames.map((f) => f.frame_kind);
    const httpKinds = httpFrames.map((f) => f.type);
    expect(grpcKinds).toEqual(httpKinds);
    expect(grpcKinds[0]).toBe('metadata');
    expect(grpcKinds[grpcKinds.length - 1]).toBe('end');
    // One slice frame per source slice, no re-ordering.
    const sliceCount = grpcKinds.filter((k) => k === 'slice').length;
    expect(sliceCount).toBe(PACKED.slices.length);
  });

  it('carries identical metadata frame values (core meta + failures)', () => {
    const grpcMeta = grpcFrames[0];
    const httpMeta = httpFrames[0];
    expect(grpcMeta?.frame_kind).toBe('metadata');
    expect(httpMeta?.type).toBe('metadata');
    const httpValue = (httpMeta as { type: 'metadata'; value: MetadataFrameValue }).value;
    expect(grpcMeta?.value).toEqual(httpValue);
    // Spot-check: failures ride on the metadata frame on both transports.
    expect((grpcMeta?.value as MetadataFrameValue).failures).toEqual(PACKED.failures);
  });

  it('emits slices in H7 order with identical payloads frame-for-frame', () => {
    const grpcSlices = grpcFrames
      .filter((f) => f.frame_kind === 'slice')
      .map((f) => f.value);
    const httpSlices = httpFrames
      .filter((f): f is { type: 'slice'; value: unknown } => f.type === 'slice')
      .map((f) => f.value);
    expect(grpcSlices).toEqual(httpSlices);
    expect(grpcSlices).toEqual(PACKED.slices);
  });

  it('reassembles to the same PackedContext on both transports', () => {
    const reassemble = (
      metaValue: MetadataFrameValue,
      slices: unknown[],
    ): PackedContext => {
      const { failures, ...core } = metaValue;
      return PackedContextSchema.parse({ metadata: core, slices, failures });
    };

    const grpcMetaValue = grpcFrames[0]?.value as MetadataFrameValue;
    const grpcSlices = grpcFrames
      .filter((f) => f.frame_kind === 'slice')
      .map((f) => f.value);
    const grpcReassembled = reassemble(grpcMetaValue, grpcSlices);

    const httpMetaValue = (httpFrames[0] as { type: 'metadata'; value: MetadataFrameValue }).value;
    const httpSlices = httpFrames
      .filter((f): f is { type: 'slice'; value: unknown } => f.type === 'slice')
      .map((f) => f.value);
    const httpReassembled = reassemble(httpMetaValue, httpSlices);

    expect(grpcReassembled).toEqual(httpReassembled);
    expect(grpcReassembled).toEqual(PACKED);
  });

  it('terminates with a single end frame carrying no payload', () => {
    const grpcEnds = grpcFrames.filter((f) => f.frame_kind === 'end');
    const httpEnds = httpFrames.filter((f) => f.type === 'end');
    expect(grpcEnds.length).toBe(1);
    expect(httpEnds.length).toBe(1);
    expect(grpcEnds[0]?.value).toBeUndefined();
  });
});
