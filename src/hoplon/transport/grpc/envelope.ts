/**
 * transport/grpc/envelope.ts — HoplonEnvelope encode/decode helpers (SV1).
 *
 * The proto wire-layer message for every unary RPC is
 *   message HoplonEnvelope { bytes json_payload; string correlation_id;
 *                            string schema_name; int32 schema_version; }
 *
 * The Zod-validated JSON DTO for the operation is UTF-8 encoded into
 * `json_payload`. Servers and clients decode through the same dispatcher
 * so the wire bytes round-trip through exactly one validation step.
 */
import { Buffer } from 'node:buffer';

import type { ProtoOperation } from '../proto/registry.js';

export interface DecodedEnvelope {
  readonly body: unknown;
  readonly correlationId: string;
}

/** Schema version that matches the committed proto (`phalanx.hoplon.v1`). */
export const HOPLON_ENVELOPE_SCHEMA_VERSION = 1;

export interface WireEnvelope {
  readonly json_payload: Buffer;
  readonly correlation_id: string;
  readonly schema_name: string;
  readonly schema_version: number;
}

export interface WireStreamFrame {
  readonly json_payload: Buffer;
  readonly correlation_id: string;
  readonly frame_kind: string;
}

export interface WireUnit {
  readonly correlation_id: string;
}

/**
 * Build a HoplonEnvelope wire message carrying the already-serialized JSON
 * payload. The caller is responsible for passing a schema-validated object
 * (the dispatcher does request validation; response objects are returned
 * directly by the engine and are already contract-shaped).
 */
export function encodeEnvelope(
  op: ProtoOperation,
  body: unknown,
  correlationId: string,
): WireEnvelope {
  const json = JSON.stringify(body ?? null);
  return {
    json_payload: Buffer.from(json, 'utf8'),
    correlation_id: correlationId,
    schema_name: resolveSchemaName(op),
    schema_version: HOPLON_ENVELOPE_SCHEMA_VERSION,
  };
}

/** Decode the `json_payload` bytes of an incoming envelope into a JS value. */
export function decodeEnvelope(env: WireEnvelope | null | undefined): DecodedEnvelope {
  if (!env) {
    return { body: undefined, correlationId: 'unknown' };
  }
  const buffer = toBuffer(env.json_payload);
  const correlationId =
    typeof env.correlation_id === 'string' && env.correlation_id.length > 0
      ? env.correlation_id
      : 'unknown';
  if (buffer.length === 0) {
    return { body: undefined, correlationId };
  }
  const text = buffer.toString('utf8');
  const body = JSON.parse(text) as unknown;
  return { body, correlationId };
}

/** Encode one HoplonStreamFrame for server-streaming RPCs. */
export function encodeFrame(
  frameKind: 'metadata' | 'slice' | 'end',
  value: unknown,
  correlationId: string,
): WireStreamFrame {
  const payload =
    frameKind === 'end' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value ?? null), 'utf8');
  return {
    json_payload: payload,
    correlation_id: correlationId,
    frame_kind: frameKind,
  };
}

/** Decode an inbound HoplonStreamFrame produced by the server. */
export function decodeFrame(
  frame: WireStreamFrame,
): { frameKind: string; value: unknown; correlationId: string } {
  const buffer = toBuffer(frame.json_payload);
  const correlationId =
    typeof frame.correlation_id === 'string' && frame.correlation_id.length > 0
      ? frame.correlation_id
      : 'unknown';
  const frameKind = typeof frame.frame_kind === 'string' ? frame.frame_kind : '';
  if (buffer.length === 0) {
    return { frameKind, value: null, correlationId };
  }
  return { frameKind, value: JSON.parse(buffer.toString('utf8')) as unknown, correlationId };
}

function resolveSchemaName(op: ProtoOperation): string {
  // Proto's `schema_name` tells clients which Zod schema the bytes roundtrip
  // through. Use the response schema ctor name when the response is on the
  // wire; request schemas are already validated server-side.
  const ctorName =
    (op.responseSchema as unknown as { constructor?: { name?: string } }).constructor?.name ?? '';
  return `${op.rpcName}Response:${ctorName || 'Zod'}`;
}

function toBuffer(raw: Uint8Array | Buffer | null | undefined): Buffer {
  if (!raw) return Buffer.alloc(0);
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw);
}
