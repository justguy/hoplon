import {
  IndexSemanticCorpusResultSchema,
  type IndexSemanticCorpusRequest,
  type IndexSemanticCorpusResult,
  type SemanticDegradationReason,
} from '../contracts/semanticSearch.js';
import { ValidationError } from '../contracts/errors.js';
import type { SemanticSearchDeps } from './semanticSearchShared.js';
import {
  createEmbeddingCacheRecord,
  resolveSemanticCacheDecision,
  uniqueReasons,
} from './semanticSearchPolicy.js';

export interface SemanticIndexCounters {
  embedded: number;
  reused: number;
  cacheHits: number;
  cacheMisses: number;
  cacheWrites: number;
}

export async function resolveDocumentVector(
  deps: SemanticSearchDeps,
  request: IndexSemanticCorpusRequest,
  doc: IndexSemanticCorpusRequest['documents'][number],
  counters: SemanticIndexCounters,
  reasons: SemanticDegradationReason[],
): Promise<number[]> {
  const decision = resolveSemanticCacheDecision(
    request.projectId,
    doc,
    request.cache,
    request.dryRun,
  );
  if (decision.degradationReason !== null) reasons.push(decision.degradationReason);
  if (decision.key !== null && deps.embeddingCacheProvided === true) {
    const cached = await deps.embeddingCache.get(decision.key);
    if (cached.status === 'AVAILABLE' && cached.record !== null) {
      counters.cacheHits += 1;
      counters.reused += 1;
      return [...cached.record.vector];
    }
    counters.cacheMisses += 1;
    reasons.push(...uniqueReasons(cached.degradationReasons));
  }

  const vector = await deps.embedding.embed(doc.text);
  if (!Array.isArray(vector) || vector.length === 0) {
    reasons.push('unindexable_document');
    return [];
  }
  counters.embedded += 1;
  if (
    decision.key !== null &&
    decision.canWritePersistentMiss &&
    deps.embeddingCacheProvided === true
  ) {
    const write = await deps.embeddingCache.put(
      createEmbeddingCacheRecord(decision.key, vector, doc),
    );
    if (write.status === 'AVAILABLE') counters.cacheWrites += 1;
    reasons.push(...uniqueReasons(write.degradationReasons));
  }
  return vector;
}

export function validateSemanticIndexResult(
  deps: SemanticSearchDeps,
  request: IndexSemanticCorpusRequest,
  result: Omit<IndexSemanticCorpusResult, 'correlationId' | 'projectId'>,
): IndexSemanticCorpusResult {
  const validated = IndexSemanticCorpusResultSchema.safeParse({
    correlationId: request.correlationId,
    projectId: request.projectId,
    ...result,
  });
  if (!validated.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: request.correlationId,
        cause: validated.error,
      },
      `indexSemanticCorpus: produced invalid result: ${validated.error.message}`,
    );
  }
  return validated.data;
}
