import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../../contracts/errors.js';
import type { HoplonError } from '../../contracts/errors.js';
import { SeeCodebaseFilePolicyError } from '../../operations/seeCodebaseFilePolicy.js';
import { CapabilityDeniedError } from '../capabilityEngagementGate.js';
import { StrictEngagementError } from '../strictEngagementGate.js';

interface ErrorEnvelope {
  error: {
    class: string;
    kind: string;
    message: string;
    correlationId: string;
    recovery?: unknown;
  };
}

export function toHttpErrorEnvelope(
  err: unknown,
): { status: number; body: ErrorEnvelope } {
  if (err instanceof StrictEngagementError) {
    return envelope(err.statusCode, 'StrictEngagementError', err.kind, err.message, err.correlationId);
  }
  if (err instanceof CapabilityDeniedError) {
    return envelope(err.statusCode, 'CapabilityDeniedError', err.kind, err.message, err.correlationId);
  }
  if (err instanceof SeeCodebaseFilePolicyError) {
    return envelope(403, 'SeeCodebaseFilePolicyError', err.kind, err.message, 'unknown');
  }
  if (err instanceof ValidationError) {
    const recovery = (err as ValidationError & { recovery?: unknown }).recovery;
    const result = envelope(400, 'ValidationError', err.kind, err.message, err.correlationId);
    if (recovery !== undefined) result.body.error.recovery = recovery;
    return result;
  }
  if (err instanceof SemanticError) {
    return envelope(409, 'SemanticError', err.kind, err.message, err.correlationId);
  }
  if (err instanceof AdapterError) {
    return envelope(503, 'AdapterError', err.kind, err.message, err.correlationId);
  }
  if (err instanceof EngineError) {
    return envelope(
      500,
      'EngineError',
      err.kind,
      err.message,
      (err as HoplonError).correlationId,
    );
  }
  return envelope(
    500,
    'UnknownError',
    'internal_error',
    err instanceof Error ? err.message : 'An unexpected error occurred',
    'unknown',
  );
}

function envelope(
  status: number,
  className: string,
  kind: string,
  message: string,
  correlationId: string,
): { status: number; body: ErrorEnvelope } {
  return {
    status,
    body: {
      error: { class: className, kind, message, correlationId },
    },
  };
}
