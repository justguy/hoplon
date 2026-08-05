import type { VectorRecord } from '../adapters/vectorStore.js';
import {
  IndexSemanticCorpusRequestSchema,
  type IndexSemanticCorpusRequest,
  type IndexSemanticCorpusResult,
  type SemanticDegradationReason,
} from '../contracts/semanticSearch.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId } from '../util/validators.js';
import {
  abortError,
  classifySemanticSearchError,
  correlationFallback,
  providersAvailable,
  toSemanticVectorRecordId,
  type SemanticSearchDeps,
} from './semanticSearchShared.js';
import {
  collectSemanticTombstones,
  uniqueReasons,
} from './semanticSearchPolicy.js';
import {
  resolveDocumentVector,
  validateSemanticIndexResult,
} from './semanticIndexCorpusHelpers.js';

export async function indexSemanticCorpus(
  deps: SemanticSearchDeps,
  req: IndexSemanticCorpusRequest,
  signal?: AbortSignal,
): Promise<IndexSemanticCorpusResult> {
  const parsed = IndexSemanticCorpusRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: correlationFallback(req),
        cause: parsed.error,
      },
      `indexSemanticCorpus: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    projectId: request.projectId,
    correlationId: request.correlationId,
  };
  deps.emitter.emit({ op: 'indexSemanticCorpus', phase: 'start', ...emitBase });

  try {
    if (signal?.aborted) throw abortError(signal);
    const result = await indexSemanticCorpusParsed(deps, request, signal);
    deps.emitter.emit({
      op: 'indexSemanticCorpus',
      phase: 'end',
      ...emitBase,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return result;
  } catch (err) {
    deps.emitter.emit({
      op: 'indexSemanticCorpus',
      phase: 'error',
      ...emitBase,
      durationMs: Date.now() - start,
      ...classifySemanticSearchError(err, 'indexing_failed'),
    });
    throw err;
  }
}

async function indexSemanticCorpusParsed(
  deps: SemanticSearchDeps,
  request: IndexSemanticCorpusRequest,
  signal?: AbortSignal,
): Promise<IndexSemanticCorpusResult> {
  const reasons: SemanticDegradationReason[] = [];
  if (deps.semanticDisabledReason !== undefined) {
    return validateSemanticIndexResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: [deps.semanticDisabledReason],
      indexedCount: 0,
      requestedCount: request.documents.length,
      tombstonedCount: 0,
    });
  }
  if (request.ignoreRulesChanged === true && request.scope === 'dirty_files_only') {
    reasons.push('ignore_rules_changed_full_reconcile_required');
    return validateSemanticIndexResult(deps, request, {
      status: 'DEGRADED',
      providerStatus: 'DEGRADED',
      providerAvailable: true,
      resultCount: 0,
      freshness: 'stale',
      degradationReasons: reasons,
      indexedCount: 0,
      requestedCount: request.documents.length,
      tombstonedCount: 0,
    });
  }

  const legacyVectorAvailable = providersAvailable(deps);
  const lexicalAvailable = deps.lexicalIndexProvided === true;
  const splitVectorAvailable =
    deps.embeddingProvided === true && deps.vectorIndexProvided === true;
  const semanticStoreAvailable = deps.semanticIndexStoreProvided === true;
  const anyIndexAvailable =
    legacyVectorAvailable ||
    lexicalAvailable ||
    splitVectorAvailable ||
    semanticStoreAvailable;
  if (!anyIndexAvailable) {
    return validateSemanticIndexResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: ['provider_not_bound'],
      indexedCount: 0,
      requestedCount: request.documents.length,
      tombstonedCount: 0,
    });
  }

  const counters = {
    embedded: 0,
    reused: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    tombstoned: 0,
  };
  const indexedIds = new Set<string>();

  const lexicalDocs = request.documents.map((doc) => ({
    id: doc.id,
    text: doc.text,
    metadata: { ...(doc.metadata ?? {}), projectId: request.projectId },
    ...(doc.sourceSnapshot === undefined
      ? {}
      : { sourceSnapshot: doc.sourceSnapshot }),
    ...(doc.branchAliases === undefined
      ? {}
      : { branchAliases: doc.branchAliases }),
    ...(doc.chunkIdentity === undefined
      ? {}
      : { chunkIdentity: doc.chunkIdentity }),
  }));
  if (lexicalAvailable) {
    const lexical = await deps.lexicalIndex.upsert(request.projectId, lexicalDocs);
    if (lexical.status !== 'UNAVAILABLE') {
      for (const doc of request.documents) indexedIds.add(doc.id);
    }
    reasons.push(...uniqueReasons(lexical.degradationReasons));
  }
  if (semanticStoreAvailable) {
    const stored = await deps.semanticIndexStore.write(
      request.projectId,
      request.documents.map((doc) => ({
        id: doc.id,
        text: doc.text,
        metadata: { ...(doc.metadata ?? {}), projectId: request.projectId },
        contentHash: doc.documentTextHash ?? doc.id,
        ...(doc.sourceSnapshot === undefined
          ? {}
          : { sourceSnapshot: doc.sourceSnapshot }),
        ...(doc.branchAliases === undefined
          ? {}
          : { branchAliases: doc.branchAliases }),
        ...(doc.chunkIdentity === undefined
          ? {}
          : { chunkIdentity: doc.chunkIdentity }),
      })),
    );
    if (stored.status !== 'UNAVAILABLE') {
      for (const doc of request.documents) indexedIds.add(doc.id);
    }
    reasons.push(...uniqueReasons(stored.degradationReasons));
  }

  if (legacyVectorAvailable || splitVectorAvailable) {
    for (const doc of request.documents) {
      if (signal?.aborted) throw abortError(signal);
      const vector = await resolveDocumentVector(deps, request, doc, counters, reasons);
      if (vector.length === 0) continue;
      const metadata = { ...(doc.metadata ?? {}), projectId: request.projectId };
      if (legacyVectorAvailable) {
        const record: VectorRecord = {
          id: toSemanticVectorRecordId(request.projectId, doc.id),
          vector,
          metadata,
        };
        await deps.vectorStore.upsert(record);
      }
      if (splitVectorAvailable) {
        const vectorResult = await deps.vectorIndex.upsert(request.projectId, [
          {
            id: doc.id,
            vector,
            metadata,
            ...(doc.sourceSnapshot === undefined
              ? {}
              : { sourceSnapshot: doc.sourceSnapshot }),
            ...(doc.branchAliases === undefined
              ? {}
              : { branchAliases: doc.branchAliases }),
            ...(doc.chunkIdentity === undefined
              ? {}
              : { chunkIdentity: doc.chunkIdentity }),
          },
        ]);
        reasons.push(...uniqueReasons(vectorResult.degradationReasons));
      }
      indexedIds.add(doc.id);
    }
  }

  const tombstones = collectSemanticTombstones(request);
  for (const tombstone of tombstones) {
    if (lexicalAvailable) {
      await deps.lexicalIndex.delete(request.projectId, [tombstone.id], {
        tombstoneKind: tombstone.kind,
      });
    }
    if (splitVectorAvailable) {
      await deps.vectorIndex.delete(request.projectId, [tombstone.id], {
        tombstoneKind: tombstone.kind,
      });
    }
    if (semanticStoreAvailable) {
      await deps.semanticIndexStore.delete(request.projectId, [tombstone.id]);
    }
    if (legacyVectorAvailable) {
      await deps.vectorStore.delete(toSemanticVectorRecordId(request.projectId, tombstone.id));
    }
    counters.tombstoned += 1;
  }

  const degraded = reasons.length > 0 || (lexicalAvailable && !splitVectorAvailable);
  return validateSemanticIndexResult(deps, request, {
    status: degraded ? 'DEGRADED' : 'AVAILABLE',
    providerStatus: degraded ? 'DEGRADED' : 'AVAILABLE',
    providerAvailable: true,
    resultCount: indexedIds.size,
    freshness: degraded ? 'stale' : 'indexed',
    degradationReasons: uniqueReasons([
      ...reasons,
      lexicalAvailable && !splitVectorAvailable ? 'lexical_only_profile' : null,
    ]),
    indexedCount: indexedIds.size,
    requestedCount: request.documents.length,
    reusedCount: counters.reused,
    embeddedCount: counters.embedded,
    cacheHitCount: counters.cacheHits,
    cacheMissCount: counters.cacheMisses,
    cacheWriteCount: counters.cacheWrites,
    tombstonedCount: counters.tombstoned,
  });
}
