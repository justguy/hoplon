/**
 * tests/transport/proto.generate.test.ts — GRPC-PG1 reproducibility proof.
 *
 * Two bounded claims:
 *
 *   1. `generateHoplonProto()` is deterministic — two calls return the exact
 *      same string.
 *   2. The committed `.proto` artifact at
 *      `src/hoplon/transport/proto/generated/hoplon.proto` matches
 *      `generateHoplonProto()` byte-for-byte. Drift fails this test.
 *
 * The test also enforces structural invariants over the emitted text so
 * a reviewer can see at a glance that the output is still a well-formed
 * proto3 file carrying one RPC per registry entry, with server-streaming
 * used exactly for the ops that declare it.
 *
 * Regeneration path
 *
 *   When the registry intentionally changes (new engine RPC, streaming
 *   posture flip, etc.), re-emit the artifact with:
 *
 *     HOPLON_PROTO_REGEN=1 npx vitest run tests/transport/proto.generate.test.ts
 *
 *   With `HOPLON_PROTO_REGEN=1` set, the test writes the artifact and the
 *   byte-equality assertion still runs against the freshly written file —
 *   so regeneration still proves reproducibility.
 *
 * This test does NOT instantiate any gRPC runtime, does not import
 * `@grpc/grpc-js` (it is not a dependency on this branch), and does not
 * claim a live gRPC path. It only proves the generator is stable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  generateHoplonProto,
  HOPLON_PROTO_ARTIFACT_PATH,
  HOPLON_PROTO_SERVICE,
  HOPLON_PROTO_OPERATIONS,
} from '../../src/hoplon/transport/proto/index.js';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT_ABS_PATH = resolve(REPO_ROOT, HOPLON_PROTO_ARTIFACT_PATH);

describe('GRPC-PG1 — proto generator reproducibility', () => {
  it('generateHoplonProto() is deterministic across calls', () => {
    const a = generateHoplonProto();
    const b = generateHoplonProto();
    expect(a).toBe(b);
  });

  it('emits exactly one RPC per registry entry', () => {
    const proto = generateHoplonProto();
    const rpcMatches = proto.match(/^\s*rpc\s+/gm) ?? [];
    expect(rpcMatches.length).toBe(HOPLON_PROTO_OPERATIONS.length);
    for (const op of HOPLON_PROTO_OPERATIONS) {
      expect(proto).toContain(`rpc ${op.rpcName}(`);
    }
  });

  it('keeps the registry method list aligned with the shipped remote-engine surface', () => {
    const engine = createRemoteHoplonEngine({
      baseUrl: 'http://hoplon.test',
      fetchImpl: (async () => {
        throw new Error('fetch should not run during surface parity checks');
      }) as unknown as typeof globalThis.fetch,
    });

    // findSyntaxNode is still MCP/in-process only. Semantic operations are now
    // first-class transport methods and must remain in registry/client parity.
    const TRANSPORT_PENDING_METHODS = new Set([
      'findSyntaxNode',
    ]);

    const registryMethods = HOPLON_PROTO_OPERATIONS.map((op) => op.method).sort();
    const engineMethods = Object.keys(engine)
      .filter((method) => !TRANSPORT_PENDING_METHODS.has(method))
      .sort();

    expect(engineMethods).toEqual(registryMethods);
  });

  it('marks declared server-streaming ops with `stream HoplonStreamFrame`', () => {
    const proto = generateHoplonProto();
    const streamingOps = HOPLON_PROTO_OPERATIONS.filter(
      (op) => op.streaming === 'server',
    );
    // Sanity check: packContext must still be server-streaming on this branch.
    expect(streamingOps.map((op) => op.rpcName)).toContain('PackContext');
    for (const op of streamingOps) {
      expect(proto).toContain(
        `rpc ${op.rpcName}(HoplonEnvelope) returns (stream HoplonStreamFrame);`,
      );
    }
  });

  it('uses HoplonUnit for bodyless RPCs and HoplonEnvelope otherwise', () => {
    const proto = generateHoplonProto();
    for (const op of HOPLON_PROTO_OPERATIONS) {
      if (!op.hasRequestBody) {
        expect(proto).toContain(`rpc ${op.rpcName}(HoplonUnit) returns (`);
      } else {
        expect(proto).toContain(`rpc ${op.rpcName}(HoplonEnvelope) returns (`);
      }
    }
  });

  it('declares the proto3 preamble, package, envelope messages, and service', () => {
    const proto = generateHoplonProto();
    expect(proto).toContain('syntax = "proto3";');
    expect(proto).toContain('package phalanx.hoplon.v1;');
    expect(proto).toContain('message HoplonEnvelope {');
    expect(proto).toContain('message HoplonStreamFrame {');
    expect(proto).toContain('message HoplonUnit {');
    expect(proto).toContain(`service ${HOPLON_PROTO_SERVICE} {`);
  });

  it('matches the committed artifact byte-for-byte (regenerate with HOPLON_PROTO_REGEN=1)', () => {
    const generated = generateHoplonProto();
    if (process.env['HOPLON_PROTO_REGEN'] === '1') {
      writeFileSync(ARTIFACT_ABS_PATH, generated, 'utf8');
    }
    const committed = readFileSync(ARTIFACT_ABS_PATH, 'utf8');
    expect(committed).toBe(generated);
  });
});
