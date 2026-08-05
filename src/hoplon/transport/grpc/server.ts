/**
 * transport/grpc/server.ts — SV1 gRPC server over the shared dispatcher.
 *
 * `createHoplonGrpcServer({ engine, authRegistry? })` spins up a grpc-js server
 * implementing the HoplonService surface committed by PG1. Every method is
 * dispatched through `createEngineDispatcher`, so HTTP and gRPC share exactly
 * one validation + engine-call pipeline.
 *
 * Transport posture:
 *   - Unary RPCs carry `HoplonEnvelope` (JSON DTO bytes + correlationId).
 *   - Server-streaming `PackContext` always emits `HoplonStreamFrame` sequence
 *     (metadata / slice* / end) — no single-message fast path. Small payloads
 *     are a short sequence; large payloads are a longer one. Reassembly is a
 *     single contract on both transports.
 *   - Auth adapts gRPC `Metadata` into the existing `AuthRequest` (headers +
 *     path) so the HTTP middleware implementations work unchanged.
 *   - Error mapping mirrors HTTP: ValidationError → INVALID_ARGUMENT,
 *     SemanticError → FAILED_PRECONDITION, AdapterError → UNAVAILABLE,
 *     EngineError → INTERNAL, unknown → UNKNOWN, auth reject → UNAUTHENTICATED.
 *   - gRPC remains optional at runtime: constructing this server is the only
 *     path that loads `@grpc/grpc-js`; no default binding, no hidden default
 *     transport swap.
 */

import type * as grpcNs from '@grpc/grpc-js';

import type { HoplonEngine } from '../../engine/types.js';
import { createEngineDispatcher } from '../dispatcher.js';
import type { EngineDispatcher } from '../dispatcher.js';
import { HOPLON_PROTO_OPERATIONS } from '../proto/registry.js';

import { createGrpcAuthRegistry } from './auth.js';
import type { GrpcAuthRegistry } from './auth.js';
import { makeStreamingHandler, makeUnaryHandler } from './handlers.js';
import type { GrpcModule, StreamingHandler, UnaryHandler } from './handlers.js';
import { loadHoplonProto, HOPLON_PROTO_PACKAGE, HOPLON_PROTO_SERVICE } from './protoLoader.js';

export interface HoplonGrpcServerOptions {
  engine: HoplonEngine;
  /**
   * Optional pre-built auth registry. When omitted, the server creates its own
   * registry with a noop middleware default. Callers replace with
   * `createBearerTokenAuthMiddleware` etc. via `registerAuthMiddleware`.
   */
  authRegistry?: GrpcAuthRegistry;
}

export interface HoplonGrpcServer {
  /** Start listening on the provided address, resolving with the bound port. */
  start(bindAddress: string): Promise<number>;
  /** Gracefully shutdown; forces shutdown after `graceMs` on hang. */
  stop(graceMs?: number): Promise<void>;
  /** The live auth registry — same shape as the HTTP auth registry. */
  readonly authRegistry: GrpcAuthRegistry;
  /** The service path exposed on the wire, e.g. `phalanx.hoplon.v1.HoplonService`. */
  readonly serviceName: string;
  /** Direct access to the underlying grpc-js server (tests, plugin hooks). */
  readonly server: grpcNs.Server;
}

export async function createHoplonGrpcServer(
  opts: HoplonGrpcServerOptions,
): Promise<HoplonGrpcServer> {
  const grpc = await import('@grpc/grpc-js');
  const loaded = await loadHoplonProto();
  const dispatcher = createEngineDispatcher(opts.engine);
  const authRegistry = opts.authRegistry ?? createGrpcAuthRegistry();

  const server = new grpc.Server();
  const implementation = buildImplementation(grpc, dispatcher, authRegistry);
  server.addService(loaded.serviceDefinition, implementation);

  return {
    server,
    authRegistry,
    serviceName: `${HOPLON_PROTO_PACKAGE}.${HOPLON_PROTO_SERVICE}`,
    start(bindAddress: string): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(port);
        });
      });
    },
    stop(graceMs: number = 2000): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, graceMs);
        timer.unref?.();
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function buildImplementation(
  grpc: GrpcModule,
  dispatcher: EngineDispatcher,
  auth: GrpcAuthRegistry,
): Record<string, UnaryHandler | StreamingHandler> {
  const impl: Record<string, UnaryHandler | StreamingHandler> = {};
  for (const op of HOPLON_PROTO_OPERATIONS) {
    if (op.streaming === 'server') {
      impl[op.rpcName] = makeStreamingHandler(grpc, dispatcher, auth, op);
    } else {
      impl[op.rpcName] = makeUnaryHandler(grpc, dispatcher, auth, op);
    }
  }
  return impl;
}
