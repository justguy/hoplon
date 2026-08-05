/**
 * transport/grpc/clientDispatch.ts — CL1 generic dispatch helpers.
 *
 * Shared between unary and server-streaming engine methods. Holds everything
 * that touches @grpc/grpc-js so `client.ts` stays under the 300-line limit
 * and reads as a thin HoplonEngine-shaped facade.
 *
 * Wire contract (mirrors SV1):
 *   Unary request  — HoplonEnvelope or HoplonUnit
 *   Unary response — HoplonEnvelope (json_payload → response DTO)
 *   Stream request — HoplonEnvelope
 *   Stream frames  — HoplonStreamFrame (metadata / slice* / end)
 *
 * Validation: request DTOs run through the op's Zod schema before send
 * (defensive H24 boundary — server re-validates authoritatively). Responses
 * always parse through the op's Zod response schema before returning to the
 * caller so typed errors reach user code instead of wire-shape surprises.
 */

import type { z } from 'zod';

import { TransportError } from '../types.js';
import type { ProtoOperation } from '../proto/registry.js';

import { decodeEnvelope, decodeFrame, encodeEnvelope } from './envelope.js';
import type { WireEnvelope, WireStreamFrame, WireUnit } from './envelope.js';
import { translateGrpcError } from './clientErrors.js';
import { loadHoplonProto, HOPLON_PROTO_PACKAGE, HOPLON_PROTO_SERVICE } from './protoLoader.js';

export interface GrpcClientHandle {
  call(
    rpcName: string,
    request: WireEnvelope | WireUnit,
    metadata: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<WireEnvelope>;
  stream(
    rpcName: string,
    request: WireEnvelope,
    metadata: Record<string, string>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<WireStreamFrame>;
  close(): void;
}

export async function buildGrpcClientHandle(address: string): Promise<GrpcClientHandle> {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const { protoText } = await loadHoplonProto();
  const dir = mkdtempSync(join(tmpdir(), 'hoplon-grpc-client-'));
  const file = join(dir, 'hoplon.proto');
  writeFileSync(file, protoText, 'utf8');
  const pkgDef = await loader.load(file, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }

  const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as Record<string, unknown>;
  let node: Record<string, unknown> = loaded;
  for (const part of HOPLON_PROTO_PACKAGE.split('.')) {
    node = node[part] as Record<string, unknown>;
  }
  const ServiceCtor = node[HOPLON_PROTO_SERVICE] as unknown as new (
    addr: string,
    creds: unknown,
  ) => GenericGrpcClient;
  const client = new ServiceCtor(address, grpc.credentials.createInsecure());

  return {
    call(rpcName, request, metadata, signal) {
      return new Promise<WireEnvelope>((resolve, reject) => {
        const md = new grpc.Metadata();
        for (const [k, v] of Object.entries(metadata)) md.set(k, v);
        const fn = client[rpcName] as GenericUnaryFn;
        const call = fn.call(client, request, md, (err, response) => {
          signal?.removeEventListener('abort', abortHandler);
          if (err) reject(err);
          else resolve(response as WireEnvelope);
        });
        function abortHandler(): void {
          try { call?.cancel(); } catch { /* best-effort */ }
        }
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
    },
    stream(rpcName, request, metadata, signal) {
      const md = new grpc.Metadata();
      for (const [k, v] of Object.entries(metadata)) md.set(k, v);
      const fn = client[rpcName] as GenericStreamFn;
      const call = fn.call(client, request, md);
      const abortHandler = (): void => {
        try { call.cancel(); } catch { /* best-effort */ }
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      const queue: WireStreamFrame[] = [];
      const waiters: Array<(r: IteratorResult<WireStreamFrame>) => void> = [];
      let done = false;
      let error: unknown = null;

      call.on('data', (frame: WireStreamFrame) => {
        const waiter = waiters.shift();
        if (waiter) waiter({ value: frame, done: false });
        else queue.push(frame);
      });
      call.on('error', (err: unknown) => {
        error = err;
        done = true;
        while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
      });
      call.on('end', () => {
        done = true;
        while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
      });

      return {
        [Symbol.asyncIterator](): AsyncIterator<WireStreamFrame> {
          return {
            async next(): Promise<IteratorResult<WireStreamFrame>> {
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              if (done) {
                signal?.removeEventListener('abort', abortHandler);
                if (error) throw error;
                return { value: undefined as unknown as WireStreamFrame, done: true };
              }
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      };
    },
    close() { client.close(); },
  };
}

// ---------------------------------------------------------------------------
// Unary dispatch
// ---------------------------------------------------------------------------

export interface UnaryDispatchArgs<Req, Res> {
  handle: GrpcClientHandle;
  op: ProtoOperation;
  body: Req | undefined;
  reqSchema: z.ZodType<Req> | null;
  resSchema: z.ZodType<Res>;
  authToken: string | undefined;
  engineId: string;
  correlationId: string;
  signal: AbortSignal | undefined;
}

export async function dispatchUnary<Req, Res>(args: UnaryDispatchArgs<Req, Res>): Promise<Res> {
  const { handle, op, body, reqSchema, resSchema, authToken, engineId, correlationId, signal } = args;
  const metadata: Record<string, string> = {};
  if (authToken !== undefined) metadata['authorization'] = `Bearer ${authToken}`;

  if (reqSchema && body !== undefined) {
    const parsed = reqSchema.safeParse(body);
    if (!parsed.success) {
      throw new TransportError(
        { kind: 'malformed_response', engineId, correlationId, cause: parsed.error },
        `gRPC client: DTO for ${op.rpcName} failed pre-send schema validation`,
      );
    }
  }

  const request: WireEnvelope | WireUnit = op.hasRequestBody
    ? encodeEnvelope(op, body, correlationId)
    : { correlation_id: correlationId };

  let response: WireEnvelope;
  try {
    response = await handle.call(op.rpcName, request, metadata, signal);
  } catch (err) {
    throw translateGrpcError(err, { engineId, correlationId, op: op.rpcName });
  }

  const decoded = decodeEnvelope(response);
  const parsed = resSchema.safeParse(decoded.body);
  if (!parsed.success) {
    throw new TransportError(
      { kind: 'malformed_response', engineId, correlationId, cause: parsed.error },
      `gRPC client: response for ${op.rpcName} failed Zod parse`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Streaming dispatch — reassemble HoplonStreamFrame sequence into the full
// PackedContext DTO, matching the HTTP NDJSON reassembly contract frame-for-frame.
// ---------------------------------------------------------------------------

export interface StreamDispatchArgs<Req, Res> {
  handle: GrpcClientHandle;
  op: ProtoOperation;
  body: Req;
  reqSchema: z.ZodType<Req>;
  resSchema: z.ZodType<Res>;
  authToken: string | undefined;
  engineId: string;
  correlationId: string;
  signal: AbortSignal | undefined;
}

export async function dispatchStream<Req, Res>(args: StreamDispatchArgs<Req, Res>): Promise<Res> {
  const { handle, op, body, reqSchema, resSchema, authToken, engineId, correlationId, signal } = args;
  const metadata: Record<string, string> = {};
  if (authToken !== undefined) metadata['authorization'] = `Bearer ${authToken}`;

  const parsedReq = reqSchema.safeParse(body);
  if (!parsedReq.success) {
    throw new TransportError(
      { kind: 'malformed_response', engineId, correlationId, cause: parsedReq.error },
      `gRPC client: DTO for ${op.rpcName} failed pre-send schema validation`,
    );
  }

  const request = encodeEnvelope(op, body, correlationId);
  let metaFrameValue: Record<string, unknown> | undefined;
  const slices: unknown[] = [];
  let ended = false;

  try {
    for await (const frame of handle.stream(op.rpcName, request, metadata, signal)) {
      const decoded = decodeFrame(frame);
      if (decoded.frameKind === 'metadata') {
        metaFrameValue = decoded.value as Record<string, unknown>;
      } else if (decoded.frameKind === 'slice') {
        slices.push(decoded.value);
      } else if (decoded.frameKind === 'end') {
        ended = true;
        break;
      }
    }
  } catch (err) {
    throw translateGrpcError(err, { engineId, correlationId, op: op.rpcName });
  }

  if (!ended || !metaFrameValue) {
    throw new TransportError(
      { kind: 'stream_interrupted', engineId, correlationId },
      `gRPC client: ${op.rpcName} stream ended before receiving metadata + end`,
    );
  }

  const { failures: failureList, ...meta } = metaFrameValue as {
    failures?: unknown[];
    [k: string]: unknown;
  };
  const reassembled = {
    metadata: meta,
    slices,
    failures: Array.isArray(failureList) ? failureList : [],
  };
  const parsed = resSchema.safeParse(reassembled);
  if (!parsed.success) {
    throw new TransportError(
      { kind: 'malformed_response', engineId, correlationId, cause: parsed.error },
      `gRPC client: reassembled ${op.rpcName} stream failed Zod parse`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Minimal structural types for grpc-js
// ---------------------------------------------------------------------------

interface GenericGrpcClient {
  close(): void;
  [rpcName: string]: unknown;
}

type GenericUnaryFn = (
  this: GenericGrpcClient,
  request: unknown,
  metadata: unknown,
  cb: (err: unknown, response: unknown) => void,
) => { cancel(): void };

type GenericStreamFn = (
  this: GenericGrpcClient,
  request: unknown,
  metadata: unknown,
) => NodeJS.EventEmitter & { cancel(): void };
