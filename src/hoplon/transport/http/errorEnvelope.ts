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

/** Error envelope shape sent by the packaged HTTP server on non-2xx responses. */
export const HttpErrorEnvelopeSchema = z.object({
  error: z.object({
    name: z.string().optional(),
    class: z.string().optional(),
    kind: z.string(),
    message: z.string(),
    engineId: z.string().optional().default('remote'),
    correlationId: z.string().optional().default('unknown'),
    recovery: z.unknown().optional(),
  }),
});

export function translateHoplonServerError(
  envelope: z.infer<typeof HttpErrorEnvelopeSchema>['error'],
): ValidationError | SemanticError | AdapterError | EngineError | TransportError {
  const name = envelope.name ?? envelope.class ?? 'UnknownError';
  const { kind, message, engineId, correlationId } = envelope;

  if (name === 'ValidationError') {
    const error = new ValidationError(
      { kind: kind as ValidationErrorKind, engineId, correlationId },
      message,
    );
    if (envelope.recovery !== undefined) {
      Object.defineProperty(error, 'recovery', {
        value: envelope.recovery,
        enumerable: true,
      });
    }
    return error;
  }
  if (name === 'SemanticError') {
    return new SemanticError(
      { kind: kind as SemanticErrorKind, engineId, correlationId },
      message,
    );
  }
  if (name === 'AdapterError') {
    return new AdapterError(
      { kind: kind as AdapterErrorKind, engineId, correlationId },
      message,
    );
  }
  if (name === 'TransportError') {
    return new TransportError(
      { kind: kind as TransportErrorKind, engineId, correlationId },
      message,
    );
  }
  if (name === 'EngineError') {
    return new EngineError(
      { kind: kind as EngineErrorKind, engineId, correlationId },
      message,
    );
  }
  return new EngineError(
    { kind: 'remote_not_supported', engineId, correlationId },
    `Remote server error (${name}): ${message}`,
  );
}
