import {
  SemanticSearchRequestSchema,
  type SemanticSearchRequest,
  type SemanticSearchResult,
} from '../contracts/semanticSearch.js';
import { SemanticSearchRequestValidationError } from '../contracts/semanticSearchRecovery.js';
import { validateCorrelationId } from '../util/validators.js';
import {
  abortError,
  classifySemanticSearchError,
  correlationFallback,
  type SemanticSearchDeps,
} from './semanticSearchShared.js';
import { executeSemanticSearch } from './semanticSearchQueryExecution.js';

export async function semanticSearch(
  deps: SemanticSearchDeps,
  req: SemanticSearchRequest,
  signal?: AbortSignal,
): Promise<SemanticSearchResult> {
  const parsed = SemanticSearchRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new SemanticSearchRequestValidationError({
      engineId: deps.engineId,
      correlationId: correlationFallback(req),
      cause: parsed.error,
    });
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    projectId: request.projectId,
    correlationId: request.correlationId,
  };
  deps.emitter.emit({ op: 'semanticSearch', phase: 'start', ...emitBase });

  try {
    if (signal?.aborted) throw abortError(signal);
    const result = await executeSemanticSearch(deps, request);
    deps.emitter.emit({
      op: 'semanticSearch',
      phase: 'end',
      ...emitBase,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return result;
  } catch (err) {
    deps.emitter.emit({
      op: 'semanticSearch',
      phase: 'error',
      ...emitBase,
      durationMs: Date.now() - start,
      ...classifySemanticSearchError(err, 'search_failed'),
    });
    throw err;
  }
}
