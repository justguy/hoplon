/**
 * transport/grpc/handlers.ts — unary + streaming handler factories (SV1).
 *
 * Kept separate from `server.ts` so the server factory stays under the
 * 300-line architecture limit and so handler logic is straightforward to
 * cover in isolation from server boot wiring.
 *
 * Both handlers share one contract: decode `HoplonEnvelope` (or `HoplonUnit`),
 * invoke the shared dispatcher, and send back an envelope / frame sequence.
 * Auth rejection and typed error mapping both attach a binary
 * `hoplon-error-bin` metadata entry so clients can reconstruct the original
 * HoplonError (mirrors the HTTP error-envelope shape).
 */

import { Buffer } from 'node:buffer';

import type * as grpcNs from '@grpc/grpc-js';

import type { EngineDispatcher } from '../dispatcher.js';
import type { ProtoOperation } from '../proto/registry.js';

import { buildAuthRequest } from './auth.js';
import type { GrpcAuthRegistry } from './auth.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  encodeFrame,
} from './envelope.js';
import type { WireEnvelope, WireStreamFrame, WireUnit } from './envelope.js';
import {
  GRPC_STATUS,
  envelopeToMetadataJson,
  mapHoplonErrorToGrpc,
} from './errors.js';
import { HOPLON_PROTO_PACKAGE, HOPLON_PROTO_SERVICE } from './protoLoader.js';

export type GrpcModule = typeof grpcNs;
export type UnaryHandler = grpcNs.handleUnaryCall<WireEnvelope | WireUnit, WireEnvelope>;
export type StreamingHandler = grpcNs.handleServerStreamingCall<WireEnvelope, WireStreamFrame>;

export function makeUnaryHandler(
  grpc: GrpcModule,
  dispatcher: EngineDispatcher,
  auth: GrpcAuthRegistry,
  op: ProtoOperation,
): UnaryHandler {
  return function handleUnary(
    call: grpcNs.ServerUnaryCall<WireEnvelope | WireUnit, WireEnvelope>,
    callback: grpcNs.sendUnaryData<WireEnvelope>,
  ): void {
    const controller = new AbortController();
    call.on('cancelled', () => controller.abort());

    void (async () => {
      const path = `/${HOPLON_PROTO_PACKAGE}.${HOPLON_PROTO_SERVICE}/${op.rpcName}`;
      const authOk = await runAuthForCall(grpc, auth, call, callback, path);
      if (!authOk) return;

      const request = call.request;
      let body: unknown = undefined;
      let correlationId = 'unknown';
      try {
        if (op.hasRequestBody) {
          const decoded = decodeEnvelope(request as WireEnvelope);
          body = decoded.body;
          correlationId = decoded.correlationId;
        } else {
          const unit = request as WireUnit | null | undefined;
          correlationId =
            typeof unit?.correlation_id === 'string' && unit.correlation_id.length > 0
              ? unit.correlation_id
              : 'unknown';
        }
      } catch (err) {
        sendGrpcError(grpc, callback, err);
        return;
      }

      try {
        const result = await dispatcher.invoke({
          method: op.method,
          body,
          signal: controller.signal,
          engineId: 'grpc-server',
          correlationId: 'parse',
        });
        callback(null, encodeEnvelope(op, result, correlationId));
      } catch (err) {
        sendGrpcError(grpc, callback, err);
      }
    })();
  };
}

export function makeStreamingHandler(
  grpc: GrpcModule,
  dispatcher: EngineDispatcher,
  auth: GrpcAuthRegistry,
  op: ProtoOperation,
): StreamingHandler {
  return function handleStreaming(
    call: grpcNs.ServerWritableStream<WireEnvelope, WireStreamFrame>,
  ): void {
    const controller = new AbortController();
    call.on('cancelled', () => controller.abort());

    void (async () => {
      const path = `/${HOPLON_PROTO_PACKAGE}.${HOPLON_PROTO_SERVICE}/${op.rpcName}`;
      const authOk = await runAuthForStream(grpc, auth, call, path);
      if (!authOk) return;

      let body: unknown;
      let correlationId = 'unknown';
      try {
        const decoded = decodeEnvelope(call.request);
        body = decoded.body;
        correlationId = decoded.correlationId;
      } catch (err) {
        emitStreamError(grpc, call, err);
        return;
      }

      try {
        const result = (await dispatcher.invoke({
          method: op.method,
          body,
          signal: controller.signal,
          engineId: 'grpc-server',
          correlationId: 'parse',
        })) as {
          slices?: unknown[];
          metadata?: Record<string, unknown>;
          failures?: unknown[];
        };

        // packContext returns { metadata, slices, failures }. Frame order mirrors
        // the HTTP NDJSON stream exactly: metadata (+ failures), then slices in
        // H7 order, then the end terminator. No fast-path single-message shortcut.
        const metadataFrameValue = {
          ...(result.metadata ?? {}),
          failures: Array.isArray(result.failures) ? result.failures : [],
        };
        call.write(encodeFrame('metadata', metadataFrameValue, correlationId));
        const slices = Array.isArray(result.slices) ? result.slices : [];
        for (const slice of slices) {
          if (controller.signal.aborted) break;
          call.write(encodeFrame('slice', slice, correlationId));
        }
        call.write(encodeFrame('end', null, correlationId));
        call.end();
      } catch (err) {
        emitStreamError(grpc, call, err);
      }
    })();
  };
}

async function runAuthForCall<TReq, TRes>(
  grpc: GrpcModule,
  auth: GrpcAuthRegistry,
  call: grpcNs.ServerUnaryCall<TReq, TRes>,
  callback: grpcNs.sendUnaryData<TRes>,
  path: string,
): Promise<boolean> {
  const ctx = await auth.runAuth(buildAuthRequest(call.metadata.getMap(), path));
  if (ctx === null) {
    callback(buildAuthError(grpc));
    return false;
  }
  return true;
}

async function runAuthForStream(
  grpc: GrpcModule,
  auth: GrpcAuthRegistry,
  call: grpcNs.ServerWritableStream<unknown, unknown>,
  path: string,
): Promise<boolean> {
  const ctx = await auth.runAuth(buildAuthRequest(call.metadata.getMap(), path));
  if (ctx === null) {
    call.emit('error', buildAuthError(grpc));
    return false;
  }
  return true;
}

function buildAuthError(grpc: GrpcModule): grpcNs.ServiceError {
  const metadata = new grpc.Metadata();
  metadata.set(
    'hoplon-error-bin',
    Buffer.from(
      envelopeToMetadataJson({
        class: 'TransportError',
        kind: 'auth_failed',
        message: 'Unauthenticated',
        correlationId: 'unknown',
      }),
      'utf8',
    ),
  );
  return {
    code: GRPC_STATUS.UNAUTHENTICATED,
    details: 'Unauthenticated',
    metadata,
  } as grpcNs.ServiceError;
}

function sendGrpcError<T>(
  grpc: GrpcModule,
  callback: grpcNs.sendUnaryData<T>,
  err: unknown,
): void {
  const mapped = mapHoplonErrorToGrpc(err);
  const metadata = new grpc.Metadata();
  metadata.set('hoplon-error-bin', Buffer.from(envelopeToMetadataJson(mapped.envelope), 'utf8'));
  callback({
    code: mapped.code,
    details: mapped.message,
    metadata,
  } as grpcNs.ServiceError);
}

function emitStreamError(
  grpc: GrpcModule,
  call: grpcNs.ServerWritableStream<unknown, unknown>,
  err: unknown,
): void {
  const mapped = mapHoplonErrorToGrpc(err);
  const metadata = new grpc.Metadata();
  metadata.set('hoplon-error-bin', Buffer.from(envelopeToMetadataJson(mapped.envelope), 'utf8'));
  call.emit('error', {
    code: mapped.code,
    details: mapped.message,
    metadata,
  });
}
