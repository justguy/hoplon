import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../contracts/errors.js';

type ErrorCategory = 'engine' | 'adapter' | 'semantic' | 'validation';

export function classifyRevertError(
  error: unknown,
): [ErrorCategory | undefined, string | undefined] {
  if (error instanceof ValidationError) return ['validation', error.kind];
  if (error instanceof AdapterError) return ['adapter', error.kind];
  if (error instanceof EngineError) return ['engine', error.kind];
  if (error instanceof SemanticError) return ['semantic', error.kind];
  return [undefined, undefined];
}

export function revertAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
