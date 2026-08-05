import { ValidationError } from '../contracts/errors.js';
import type { SemanticCorpusDocument } from '../contracts/semanticSearch.js';
import { indexSemanticCorpus } from './semanticIndexCorpus.js';
import {
  aliasFor,
  buildDocumentsForCommit,
  corpusRequest,
  markStaleAliases,
  mergeDocumentAliases,
  snapshotId,
} from './semanticRefIndexingDocuments.js';
import type {
  SemanticRefIndexingDeps,
  SemanticRefIndexingRequest,
  SemanticRefIndexingResult,
} from './semanticRefIndexingModel.js';
import {
  groupExistingByCommit,
  groupRefsByCommit,
  resolveSemanticSourceRefs,
} from './semanticRefIndexingRefs.js';
import { abortError, classifySemanticSearchError } from './semanticSearchShared.js';

export type {
  SemanticRefIndexingDeps,
  SemanticRefIndexingRequest,
  SemanticRefIndexingResult,
} from './semanticRefIndexingModel.js';

export async function indexSemanticRefs(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
  signal?: AbortSignal,
): Promise<SemanticRefIndexingResult> {
  validateRequest(deps, req);
  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    projectId: req.projectId,
    runId: req.runId,
    correlationId: req.correlationId,
  };
  deps.emitter.emit({ op: 'indexSemanticCorpus', phase: 'start', ...emitBase });
  try {
    if (signal?.aborted) throw abortError(signal);
    const result = await indexSemanticRefsInner(deps, req, signal);
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

async function indexSemanticRefsInner(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
  signal?: AbortSignal,
): Promise<SemanticRefIndexingResult> {
  const existing = await readExistingDocuments(deps, req);
  const refs = await resolveSemanticSourceRefs(deps, req, existing.documents);
  const byCommit = groupRefsByCommit(refs);
  const existingByCommit = groupExistingByCommit(existing.documents);
  const documents: SemanticCorpusDocument[] = [];
  const aliasOnlyDocuments: SemanticCorpusDocument[] = [];
  let excludedCount = 0;
  let indexedCommitCount = 0;
  let aliasOnlyCommitCount = 0;

  for (const [commitOid, commitRefs] of byCommit) {
    if (signal?.aborted) throw abortError(signal);
    const aliases = commitRefs.map((ref) =>
      aliasFor(req, ref, snapshotId(req, commitOid)),
    );
    const priorDocs = existingByCommit.get(commitOid) ?? [];
    if (priorDocs.length > 0 && req.force !== true) {
      aliasOnlyCommitCount += 1;
      aliasOnlyDocuments.push(...mergeDocumentAliases(priorDocs, aliases));
      continue;
    }
    indexedCommitCount += 1;
    const built = await buildDocumentsForCommit(deps, req, commitOid, commitRefs, signal);
    documents.push(...built.documents);
    excludedCount += built.excludedCount;
  }

  const aliasRefreshDocs = [
    ...aliasOnlyDocuments,
    ...markStaleAliases(existing.documents, refs),
  ];
  const degradationReasons = [...existing.degradationReasons];
  const aliasRefreshedDocumentCount = await writeAliasRefreshes(
    deps,
    req,
    aliasRefreshDocs,
    degradationReasons,
  );
  const request = corpusRequest(req, documents);
  const indexResult =
    request === null ? undefined : await indexSemanticCorpus(deps.semantic, request, signal);
  if (indexResult !== undefined) degradationReasons.push(...indexResult.degradationReasons);
  const indexedDocumentCount = indexResult?.indexedCount ?? 0;
  return {
    status: resolveStatus({
      requestedRefs: refs.length,
      indexedDocumentCount,
      aliasRefreshedDocumentCount,
      degradationReasons,
    }),
    projectId: req.projectId,
    correlationId: req.correlationId,
    resolvedBranchCount: refs.length,
    indexedCommitCount,
    indexedDocumentCount,
    aliasOnlyCommitCount,
    aliasRefreshedDocumentCount,
    excludedCount,
    degradationReasons: uniqueStrings(degradationReasons),
    ...(indexResult === undefined ? {} : { indexResult }),
  };
}

async function readExistingDocuments(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
): Promise<{ documents: SemanticCorpusDocument[]; degradationReasons: string[] }> {
  if (deps.semantic.semanticIndexStoreProvided !== true) {
    return { documents: [], degradationReasons: ['provider_not_bound'] };
  }
  const read = await deps.semantic.semanticIndexStore.read(req.projectId);
  return {
    documents: read.documents.map((doc) => ({
      id: doc.id,
      text: doc.text,
      documentTextHash: doc.contentHash,
      metadata: doc.metadata,
      ...(doc.sourceSnapshot === undefined ? {} : { sourceSnapshot: doc.sourceSnapshot }),
      ...(doc.branchAliases === undefined ? {} : { branchAliases: [...doc.branchAliases] }),
      ...(doc.chunkIdentity === undefined ? {} : { chunkIdentity: doc.chunkIdentity }),
    })),
    degradationReasons: read.degradationReasons,
  };
}

async function writeAliasRefreshes(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
  docs: readonly SemanticCorpusDocument[],
  degradationReasons: string[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const write = await deps.semantic.semanticIndexStore.write(
    req.projectId,
    docs.map((doc) => ({
      id: doc.id,
      text: doc.text,
      metadata: { ...(doc.metadata ?? {}), projectId: req.projectId },
      contentHash: doc.documentTextHash ?? doc.id,
      ...(doc.sourceSnapshot === undefined ? {} : { sourceSnapshot: doc.sourceSnapshot }),
      ...(doc.branchAliases === undefined ? {} : { branchAliases: doc.branchAliases }),
      ...(doc.chunkIdentity === undefined ? {} : { chunkIdentity: doc.chunkIdentity }),
    })),
  );
  degradationReasons.push(...write.degradationReasons);
  return write.status === 'UNAVAILABLE' ? 0 : write.writtenCount;
}

function validateRequest(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
): void {
  if (req.projectId.length === 0 || req.fsRootIdentityHash.length === 0) {
    throw new ValidationError(
      { kind: 'invalid_scope', engineId: deps.engineId, correlationId: req.correlationId },
      'semantic ref indexing requires projectId and fsRootIdentityHash',
    );
  }
  if (req.embeddingProfileHash === undefined && req.modelProfileHash === undefined) {
    throw new ValidationError(
      { kind: 'invalid_scope', engineId: deps.engineId, correlationId: req.correlationId },
      'semantic ref indexing requires embeddingProfileHash or modelProfileHash',
    );
  }
}

function resolveStatus(args: {
  requestedRefs: number;
  indexedDocumentCount: number;
  aliasRefreshedDocumentCount: number;
  degradationReasons: readonly string[];
}): SemanticRefIndexingResult['status'] {
  if (args.requestedRefs === 0) return 'EMPTY';
  if (args.indexedDocumentCount === 0 && args.aliasRefreshedDocumentCount === 0) {
    return 'UNAVAILABLE';
  }
  return args.degradationReasons.length > 0 ? 'DEGRADED' : 'AVAILABLE';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
