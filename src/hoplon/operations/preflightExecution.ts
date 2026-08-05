import type { PreflightGateResult, PreflightResult } from '../contracts/preflight.js';
import { PreflightRequestSchema } from '../contracts/requests.js';
import type { PreflightRequest } from '../contracts/requests.js';
import {
  ValidationError,
  AdapterError,
  EngineError,
  SemanticError,
} from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import type { PreflightDeps, PreflightGateContext } from './preflight.js';
import { aggregatePreflightResult } from './preflightGates.js';

export async function runPreflight(
  deps: PreflightDeps,
  req: PreflightRequest,
  signal?: AbortSignal,
): Promise<PreflightResult> {
  const { emitter, engineId, gates } = deps;
  const startMs = Date.now();

  if (signal?.aborted) {
    throw abortError(signal);
  }

  const parseResult = PreflightRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const corrId =
      typeof (req as Record<string, unknown>)?.['correlationId'] === 'string' &&
      ((req as Record<string, unknown>)?.['correlationId'] as string).length > 0
        ? ((req as Record<string, unknown>)['correlationId'] as string)
        : 'unvalidated';
    const err = new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId: corrId,
        cause: parseResult.error,
      },
      `preflight: invalid request: ${parseResult.error.message}`,
    );
    emitter.emit({
      op: 'preflight',
      phase: 'error',
      engineId,
      correlationId: corrId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_manifest',
    });
    throw err;
  }
  const validated = parseResult.data;

  try {
    validateCorrelationId(validated.correlationId);
  } catch (error) {
    emitter.emit({
      op: 'preflight',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId || 'unvalidated',
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_correlation_id',
    });
    throw error;
  }
  try {
    validateRunId(validated.runId);
  } catch (error) {
    emitter.emit({
      op: 'preflight',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_run_id',
    });
    throw error;
  }

  emitter.emit({
    op: 'preflight',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  const gateResults: PreflightGateResult[] = [];
  const gateContext: PreflightGateContext = {
    fs: deps.fs,
    versioning: deps.versioning,
    snapshotStore: deps.snapshotStore,
    codeIntelligence: deps.codeIntelligence,
    emitter: deps.emitter,
    engineId: deps.engineId,
    config: deps.config,
  };

  try {
    for (const gate of gates) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      const gateResult = await gate.run(validated, gateContext, signal);
      gateResults.push(gateResult);
    }
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const [errorCategory, errorKind] = classifyError(error);
    emitter.emit({
      op: 'preflight',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    });
    throw error;
  }

  const result = aggregatePreflightResult(gateResults, validated.correlationId);
  emitter.emit({
    op: 'preflight',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs: Date.now() - startMs,
    classification: result.status,
  });
  return result;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}

type ErrorCategory = 'engine' | 'adapter' | 'semantic' | 'validation';

function classifyError(error: unknown): [ErrorCategory | undefined, string | undefined] {
  if (error instanceof ValidationError) return ['validation', error.kind];
  if (error instanceof AdapterError) return ['adapter', error.kind];
  if (error instanceof EngineError) return ['engine', error.kind];
  if (error instanceof SemanticError) return ['semantic', error.kind];
  return [undefined, undefined];
}
