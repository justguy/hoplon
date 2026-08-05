import type { AuditViolation } from '../contracts/audit.js';
import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../contracts/errors.js';

export function buildDryRunParseSignal(
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

export function classifyDryRunParseError(
  error: unknown,
  filePath: string,
): AuditViolation | null {
  if (isTimeoutError(error)) {
    return parseViolation(filePath, 'parse_timeout');
  }
  if (isAbortError(error)) return null;
  if (error instanceof AdapterError && error.kind === 'parser_init_failed') {
    const cause = error.cause as Record<string, unknown> | null | undefined;
    if (cause?.['reason'] === 'unsupported_extension') {
      return parseViolation(filePath, 'unsupported_extension');
    }
    if (cause?.['reason'] === 'file_too_large') {
      return parseViolation(filePath, 'file_too_large');
    }
    return parseViolation(filePath, error.message);
  }
  return parseViolation(
    filePath,
    error instanceof Error ? error.message : String(error),
  );
}

function parseViolation(path: string, parseError: string): AuditViolation {
  return {
    kind: 'parse_failure',
    path,
    parseError,
    nodeKind: null,
    message: `Could not parse ${path}: ${parseError}.`,
    correction: `Fix the syntax error in ${path} (${parseError}) so it can be parsed before retrying.`,
  };
}

export function dryRunAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

type ErrorCategory = 'engine' | 'adapter' | 'semantic' | 'validation';

export function classifyDryRunError(
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
