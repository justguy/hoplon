import type { PackFailure } from '../contracts/context.js';
import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../contracts/errors.js';

export function buildParseSignal(
  operationSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (operationSignal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([operationSignal, timeoutSignal]);
  }

  const controller = new AbortController();
  if (operationSignal.aborted) {
    controller.abort(operationSignal.reason);
    return controller.signal;
  }
  if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason);
    return controller.signal;
  }
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
    operationSignal.removeEventListener('abort', onOperationAbort);
    timeoutSignal.removeEventListener('abort', onTimeoutAbort);
  };
  const onOperationAbort = (): void => abort(operationSignal.reason);
  const onTimeoutAbort = (): void => abort(timeoutSignal.reason);
  operationSignal.addEventListener('abort', onOperationAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
  return controller.signal;
}

export function classifyParseError(
  error: unknown,
  path: string,
  parseTimeoutMs: number,
): PackFailure | null {
  if (error instanceof AdapterError && error.kind === 'parser_init_failed') {
    const cause = error.cause as Record<string, unknown> | null | undefined;
    if (cause != null && cause['reason'] === 'unsupported_extension') {
      const extension =
        typeof cause['extension'] === 'string'
          ? cause['extension']
          : extractExtension(path);
      return { path, reason: 'unsupported_extension', extension };
    }
    return { path, reason: 'parse_failure', parseError: error.message };
  }
  if (isTimeoutError(error)) {
    return { path, reason: 'parse_timeout', timeoutMs: parseTimeoutMs };
  }
  if (isAbortError(error)) return null;
  return {
    path,
    reason: 'parse_failure',
    parseError: error instanceof Error ? error.message : String(error),
  };
}

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

type ErrorCategory = 'engine' | 'adapter' | 'semantic' | 'validation';

export function classifyPackContextError(
  error: unknown,
): [ErrorCategory | undefined, string | undefined] {
  if (error instanceof ValidationError) return ['validation', error.kind];
  if (error instanceof AdapterError) return ['adapter', error.kind];
  if (error instanceof EngineError) return ['engine', error.kind];
  if (error instanceof SemanticError) return ['semantic', error.kind];
  return [undefined, undefined];
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

function extractExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}
