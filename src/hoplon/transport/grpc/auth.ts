/**
 * transport/grpc/auth.ts — gRPC auth adapter (SV1).
 *
 * Lifts the shipped `AuthMiddleware` / `createAuthRegistry` seam from the HTTP
 * server into the gRPC server. The underlying auth contract is unchanged; the
 * adapter just converts gRPC `Metadata` into the content-free `AuthRequest`
 * the middleware already consumes (lowercased headers + path).
 *
 * H13 compliance: only gRPC metadata string keys are projected — request
 * body / message bytes are never exposed to the auth layer. H25 is preserved
 * because the shared registry always returns a populated AuthContext or null.
 */

import type {
  AuthContext,
  AuthMiddleware,
  AuthRequest,
} from '../http/auth.js';
import {
  createAuthRegistry,
  createNoopAuthMiddleware,
} from '../http/auth.js';

/**
 * Snapshot of gRPC metadata as returned by `Metadata.getMap()`. Values are
 * typed `unknown` because binary metadata keys carry `Buffer` values — we
 * only project string values into the auth headers map, and silently drop
 * non-string binary entries (they are never consumed by HTTP auth either).
 */
export type GrpcMetadataSnapshot = Readonly<Record<string, unknown>>;

/**
 * Build an AuthRequest from a lowercased header snapshot plus the gRPC path.
 *
 * The path form matches the proto service: `/phalanx.hoplon.v1.HoplonService/<RpcName>`.
 */
export function buildAuthRequest(
  metadata: GrpcMetadataSnapshot,
  path: string,
): AuthRequest {
  const headers: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase();
    if (Array.isArray(rawVal)) {
      if (rawVal.length > 0) {
        const first = rawVal[0];
        if (typeof first === 'string') headers[key] = first;
      }
    } else if (typeof rawVal === 'string') {
      headers[key] = rawVal;
    }
  }
  return { headers, path };
}

/**
 * The gRPC auth registry shares the HTTP registry's shape so tests and
 * deployments can reuse the same middleware (noop / bearer / custom). One
 * registry per server instance; calling `registerAuthMiddleware` replaces the
 * active middleware (same contract as HTTP).
 */
export interface GrpcAuthRegistry {
  registerAuthMiddleware(mw: AuthMiddleware): void;
  runAuth(req: AuthRequest): Promise<AuthContext | null>;
}

export function createGrpcAuthRegistry(): GrpcAuthRegistry {
  const underlying = createAuthRegistry();
  return {
    registerAuthMiddleware(mw: AuthMiddleware): void {
      underlying.registerAuthMiddleware(mw);
    },
    runAuth(req: AuthRequest): Promise<AuthContext | null> {
      return underlying.runAuth(req);
    },
  };
}

export { createNoopAuthMiddleware };
export type { AuthContext, AuthMiddleware };
