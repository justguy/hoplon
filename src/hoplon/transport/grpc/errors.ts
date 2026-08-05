/**
 * transport/grpc/errors.ts — HoplonError → gRPC status mapping (SV1).
 *
 * Mirrors the HTTP server's error envelope semantics one-for-one, but in
 * gRPC-native form. Error *identity* (class + kind + correlationId) is what
 * the cross-transport equivalence proof compares — the transport wrapper
 * (HTTP status code vs gRPC status code) is not expected to be byte-identical.
 *
 * Status mapping (mirrors the 400/409/503/500 HTTP mapping):
 *   ValidationError → INVALID_ARGUMENT (3)
 *   SemanticError   → FAILED_PRECONDITION (9)
 *   AdapterError    → UNAVAILABLE (14)
 *   EngineError     → INTERNAL (13)
 *   TransportError  → UNAVAILABLE (14)
 *   unknown         → UNKNOWN (2)
 *
 * Auth rejection is handled in the server interceptor and reports
 * UNAUTHENTICATED (16); it does not pass through this helper.
 */

import type { HoplonError } from '../../contracts/errors.js';
import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../../contracts/errors.js';
import { TransportError } from '../types.js';

// gRPC status codes from @grpc/grpc-js — inlined as literal numbers to avoid
// an eager runtime import chain in files that don't need it. Matches
// https://grpc.github.io/grpc/core/md_doc_statuscodes.html.
export const GRPC_STATUS = Object.freeze({
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  FAILED_PRECONDITION: 9,
  UNAVAILABLE: 14,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const);

export type GrpcStatusCode = (typeof GRPC_STATUS)[keyof typeof GRPC_STATUS];

/** Wire envelope carried as gRPC error metadata. Mirrors the HTTP envelope. */
export interface GrpcErrorEnvelope {
  readonly class: string;
  readonly kind: string;
  readonly message: string;
  readonly correlationId: string;
}

export interface MappedGrpcError {
  readonly code: GrpcStatusCode;
  readonly message: string;
  readonly envelope: GrpcErrorEnvelope;
}

/**
 * Map a thrown error into the gRPC status code + envelope pair the server
 * sends back to the client. The envelope mirrors the HTTP error envelope so
 * the cross-transport equivalence proof can compare error identity directly.
 */
export function mapHoplonErrorToGrpc(err: unknown): MappedGrpcError {
  if (err instanceof ValidationError) {
    return {
      code: GRPC_STATUS.INVALID_ARGUMENT,
      message: err.message,
      envelope: envelopeFrom('ValidationError', err),
    };
  }
  if (err instanceof SemanticError) {
    return {
      code: GRPC_STATUS.FAILED_PRECONDITION,
      message: err.message,
      envelope: envelopeFrom('SemanticError', err),
    };
  }
  if (err instanceof AdapterError) {
    return {
      code: GRPC_STATUS.UNAVAILABLE,
      message: err.message,
      envelope: envelopeFrom('AdapterError', err),
    };
  }
  if (err instanceof TransportError) {
    return {
      code: GRPC_STATUS.UNAVAILABLE,
      message: err.message,
      envelope: envelopeFrom('TransportError', err),
    };
  }
  if (err instanceof EngineError) {
    return {
      code: GRPC_STATUS.INTERNAL,
      message: err.message,
      envelope: envelopeFrom('EngineError', err),
    };
  }
  const message = err instanceof Error ? err.message : 'An unexpected error occurred';
  return {
    code: GRPC_STATUS.UNKNOWN,
    message,
    envelope: {
      class: 'UnknownError',
      kind: 'internal_error',
      message,
      correlationId: 'unknown',
    },
  };
}

/**
 * Build the gRPC error metadata payload the server attaches to every non-OK
 * status. The client parses the same envelope shape and rebuilds the typed
 * HoplonError on the remote side.
 */
export function envelopeToMetadataJson(envelope: GrpcErrorEnvelope): string {
  return JSON.stringify({ error: envelope });
}

function envelopeFrom(name: string, err: HoplonError): GrpcErrorEnvelope {
  return {
    class: name,
    kind: err.kind,
    message: err.message,
    correlationId: err.correlationId,
  };
}
