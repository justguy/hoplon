/**
 * transport/grpc/clientErrors.ts — server-error envelope → HoplonError
 * reconstruction on the client side (CL1).
 *
 * All non-OK gRPC responses carry a `hoplon-error-bin` binary metadata entry
 * with the envelope `{ error: { class, kind, message, correlationId } }`.
 * This module parses that envelope and rebuilds the typed HoplonError subclass
 * so remote callers can `instanceof ValidationError` exactly like the
 * in-process engine.
 *
 * Status-code fallbacks (envelope missing or malformed):
 *   UNAUTHENTICATED (16)        → TransportError(kind: 'auth_failed')
 *   CANCELLED       (1)         → TransportError(kind: 'timeout')
 *   (no code — connection-level) → TransportError(kind: 'connection_refused')
 *   other codes                 → TransportError(kind: 'malformed_response')
 */

import { Buffer } from 'node:buffer';

import { z } from 'zod';

import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../../contracts/errors.js';
import type {
  AdapterErrorKind,
  EngineErrorKind,
  SemanticErrorKind,
  ValidationErrorKind,
} from '../../contracts/errors.js';
import { TransportError } from '../types.js';
import type { TransportErrorKind } from '../types.js';

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    class: z.string(),
    kind: z.string(),
    message: z.string(),
    correlationId: z.string().optional().default('unknown'),
  }),
});

export interface TranslateCtx {
  engineId: string;
  correlationId: string;
  op: string;
}

export function translateGrpcError(err: unknown, ctx: TranslateCtx):
  ValidationError | SemanticError | AdapterError | EngineError | TransportError {
  const asObj = err as {
    code?: number;
    metadata?: { get?: (k: string) => Array<string | Buffer> };
  } | null;
  const code = asObj?.code;

  if (code === 16) {
    return new TransportError(
      { kind: 'auth_failed', engineId: ctx.engineId, correlationId: ctx.correlationId },
      `gRPC ${ctx.op}: UNAUTHENTICATED`,
    );
  }
  if (code === 1) {
    return new TransportError(
      { kind: 'timeout', engineId: ctx.engineId, correlationId: ctx.correlationId },
      `gRPC ${ctx.op}: call cancelled`,
    );
  }

  const envelope = readErrorEnvelope(asObj?.metadata);
  if (envelope) {
    return rebuildFromEnvelope(envelope, ctx);
  }

  if (code === undefined) {
    return new TransportError(
      {
        kind: 'connection_refused',
        engineId: ctx.engineId,
        correlationId: ctx.correlationId,
        cause: err,
      },
      `gRPC ${ctx.op}: transport error`,
    );
  }

  return new TransportError(
    { kind: 'malformed_response', engineId: ctx.engineId, correlationId: ctx.correlationId },
    `gRPC ${ctx.op}: unrecognized status code ${code}`,
  );
}

function readErrorEnvelope(
  metadata: { get?: (k: string) => Array<string | Buffer> } | undefined,
): z.infer<typeof ErrorEnvelopeSchema>['error'] | null {
  const entries = metadata?.get?.('hoplon-error-bin') ?? [];
  if (entries.length === 0) return null;
  const first = entries[0];
  if (first === undefined) return null;
  const buf = Buffer.isBuffer(first) ? first : Buffer.from(first, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  const result = ErrorEnvelopeSchema.safeParse(parsed);
  return result.success ? result.data.error : null;
}

function rebuildFromEnvelope(
  env: z.infer<typeof ErrorEnvelopeSchema>['error'],
  ctx: TranslateCtx,
): ValidationError | SemanticError | AdapterError | EngineError | TransportError {
  const base = {
    engineId: ctx.engineId,
    correlationId: env.correlationId || ctx.correlationId,
  };
  switch (env.class) {
    case 'ValidationError':
      return new ValidationError({ ...base, kind: env.kind as ValidationErrorKind }, env.message);
    case 'SemanticError':
      return new SemanticError({ ...base, kind: env.kind as SemanticErrorKind }, env.message);
    case 'AdapterError':
      return new AdapterError({ ...base, kind: env.kind as AdapterErrorKind }, env.message);
    case 'TransportError':
      return new TransportError({ ...base, kind: env.kind as TransportErrorKind }, env.message);
    case 'EngineError':
      return new EngineError({ ...base, kind: env.kind as EngineErrorKind }, env.message);
    default:
      return new EngineError(
        { ...base, kind: 'remote_not_supported' },
        `gRPC remote error (${env.class}): ${env.message}`,
      );
  }
}
