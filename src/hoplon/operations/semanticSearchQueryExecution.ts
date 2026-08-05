import type {
  SemanticDegradationReason,
  SemanticSearchRequest,
  SemanticSearchResult,
} from '../contracts/semanticSearch.js';
import { providersAvailable, type SemanticSearchDeps } from './semanticSearchShared.js';
import { resolveSemanticFreshness, uniqueReasons } from './semanticSearchPolicy.js';
import {
  fuseRrfMatches,
  rankAuthorizedMatches,
  sourceCandidateLimit,
  type RankedSemanticCandidate,
} from './semanticSearchFusion.js';
import { lexicalOverlayMatches, vectorOverlayMatches } from './semanticSessionOverlay.js';
import {
  branchScopeReasons,
  filterBranchScopedBaselineMatches,
  readSemanticSearchSourceIndex,
} from './semanticSearchBranchScope.js';
import {
  buildSemanticSearchSuggestions,
  indexedRecoverySuggestions,
  liveSessionRecoverySuggestions,
} from './semanticSearchSuggestions.js';
import {
  finalizeSemanticSearchResult,
  filterMaskedMatches,
  validateSemanticSearchResult,
} from './semanticSearchQueryResult.js';
import { fromSemanticVectorRecordId } from './semanticSearchShared.js';

export async function executeSemanticSearch(
  deps: SemanticSearchDeps,
  request: SemanticSearchRequest,
): Promise<SemanticSearchResult> {
  const freshness = resolveSemanticFreshness(
    request.currentContext,
    request.indexedContext,
    request.allowStale,
  );
  if (freshness.status === 'UNAVAILABLE') {
    return validateSemanticSearchResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: true,
      resultCount: 0,
      freshness: 'stale',
      degradationReasons: uniqueReasons([freshness.reason]),
      matches: [],
    });
  }
  if (deps.semanticDisabledReason !== undefined) {
    return validateSemanticSearchResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: [deps.semanticDisabledReason],
      matches: [],
    });
  }

  const reasons: SemanticDegradationReason[] = [];
  if (freshness.reason !== null) reasons.push(freshness.reason);
  const candidates: RankedSemanticCandidate[] = [];
  const overlayWorktreeId = request.currentContext?.worktreeId;
  if (request.sessionId !== undefined && deps.sessionOverlayStore === undefined) {
    const providerAvailable = providersAvailable(deps) ||
      deps.lexicalIndexProvided === true ||
      (deps.embeddingProvided === true && deps.vectorIndexProvided === true);
    return validateSemanticSearchResult(deps, request, {
      status: request.allowDegraded === true ? 'DEGRADED' : 'UNAVAILABLE',
      providerStatus: providerAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
      providerAvailable,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: ['overlay_unavailable_process_local_store'],
      matches: [],
      suggestions: liveSessionRecoverySuggestions(),
    });
  }
  const overlay =
    request.sessionId !== undefined
      ? deps.sessionOverlayStore?.get(
          request.projectId,
          request.sessionId,
          overlayWorktreeId,
        ) ?? null
      : null;
  const overlayMissReason =
    request.sessionId !== undefined && overlay === null
      ? deps.sessionOverlayStore?.reapReason(
          request.projectId,
          request.sessionId,
          overlayWorktreeId,
        ) ?? 'overlay_never_created'
      : null;
  const overlayOnly =
    request.overlayScope === 'session_overlay_only' ||
    request.freshness === 'live_session';
  const legacyVectorAvailable = providersAvailable(deps);
  const lexicalAvailable = deps.lexicalIndexProvided === true;
  const splitVectorAvailable =
    deps.embeddingProvided === true && deps.vectorIndexProvided === true;
  const providerAvailable =
    legacyVectorAvailable || lexicalAvailable || splitVectorAvailable;
  if (overlayOnly && overlay === null) {
    return validateSemanticSearchResult(deps, request, {
      status: request.allowDegraded === true ? 'DEGRADED' : 'UNAVAILABLE',
      providerStatus: providerAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
      providerAvailable,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: [overlayMissReason ?? 'overlay_never_created'],
      matches: [],
      suggestions: liveSessionRecoverySuggestions(),
    });
  }

  if (
    !legacyVectorAvailable &&
    !lexicalAvailable &&
    !splitVectorAvailable &&
    overlay === null
  ) {
    return validateSemanticSearchResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons:
        request.sessionId !== undefined
          ? uniqueReasons(['provider_not_bound', 'overlay_never_created'])
          : uniqueReasons(['provider_not_bound', 'no_indexed_corpus']),
      matches: [],
      suggestions:
        request.sessionId !== undefined
          ? liveSessionRecoverySuggestions()
          : indexedRecoverySuggestions(),
    });
  }

  if (request.sessionId !== undefined && overlay === null) {
    reasons.push(overlayMissReason ?? 'overlay_never_created');
  }

  const sourceLimit = sourceCandidateLimit(request.topK);
  const resultFreshness = freshness.reason === null ? 'indexed' : 'stale';
  const overlayMaskedPaths = new Set(overlay?.maskedPaths ?? []);
  const sourceIndex = await readSemanticSearchSourceIndex(deps, request);
  if (sourceIndex.unavailableForScopedRequest) {
    const suggestions = buildSemanticSearchSuggestions({
      request,
      sourceIndex,
      resultCount: 0,
      staleIncluded: false,
    });
    return validateSemanticSearchResult(deps, request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: uniqueReasons(sourceIndex.degradationReasons),
      matches: [],
      ...(suggestions.length === 0 ? {} : { suggestions }),
    });
  }
  let staleBranchIncluded = false;
  const applyBranchScope = <
    T extends Parameters<typeof filterBranchScopedBaselineMatches>[0][number],
  >(
    matches: readonly T[],
  ): T[] => {
    const scoped = filterBranchScopedBaselineMatches(matches, request, sourceIndex);
    staleBranchIncluded = staleBranchIncluded || scoped.staleIncluded;
    return scoped.matches;
  };
  let queryVector: number[] | null = null;
  if (overlay !== null) {
    reasons.push(...uniqueReasons(overlay.degradationReasons));
    const overlayLexical = lexicalOverlayMatches(overlay, request.query, sourceLimit);
    const ranked = rankAuthorizedMatches({
      projectId: request.projectId,
      matches: overlayLexical,
      source: 'session_overlay' as const,
      rankSource: 'overlay_lexical' as const,
      freshness: 'live_session' as const,
    });
    if (ranked.unauthorizedRowsFiltered) reasons.push('unauthorized_rows_filtered');
    candidates.push(...ranked.candidates);
    if (deps.embeddingProvided === true) {
      queryVector = await deps.embedding.embed(request.query);
      if (!Array.isArray(queryVector) || queryVector.length === 0) {
        queryVector = [];
        reasons.push('empty_query_vector');
      }
      const overlayVector = vectorOverlayMatches(overlay, queryVector, sourceLimit);
      const vectorRanked = rankAuthorizedMatches({
        projectId: request.projectId,
        matches: overlayVector,
        source: 'session_overlay' as const,
        rankSource: 'overlay_vector' as const,
        freshness: 'live_session' as const,
      });
      if (vectorRanked.unauthorizedRowsFiltered) {
        reasons.push('unauthorized_rows_filtered');
      }
      candidates.push(...vectorRanked.candidates);
    }
  }

  if (!overlayOnly && lexicalAvailable) {
    const lexical = await deps.lexicalIndex.search(
      request.projectId,
      request.query,
      sourceLimit,
    );
    reasons.push(...uniqueReasons(lexical.degradationReasons));
    const ranked = rankAuthorizedMatches({
      projectId: request.projectId,
      matches: filterMaskedMatches(
        applyBranchScope(lexical.matches),
        overlayMaskedPaths,
      ),
      source: 'baseline' as const,
      rankSource: 'baseline_lexical' as const,
      freshness: resultFreshness,
    });
    if (ranked.unauthorizedRowsFiltered) reasons.push('unauthorized_rows_filtered');
    candidates.push(...ranked.candidates);
  }

  if (!overlayOnly && (legacyVectorAvailable || splitVectorAvailable)) {
    queryVector = queryVector ?? await deps.embedding.embed(request.query);
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      reasons.push('empty_query_vector');
    } else {
      if (legacyVectorAvailable) {
        const raw = await deps.vectorStore.search(queryVector, sourceLimit, {
          projectId: request.projectId,
        });
        const vectorMatches = applyBranchScope(
          raw.map((r) => ({
            id: fromSemanticVectorRecordId(request.projectId, r.id),
            score: Math.max(0, Math.min(1, r.score)),
            metadata: r.metadata,
          })),
        );
        const ranked = rankAuthorizedMatches({
          projectId: request.projectId,
          matches: filterMaskedMatches(vectorMatches, overlayMaskedPaths),
          source: 'baseline' as const,
          rankSource: 'baseline_vector' as const,
          freshness: resultFreshness,
        });
        if (ranked.unauthorizedRowsFiltered) reasons.push('unauthorized_rows_filtered');
        candidates.push(...ranked.candidates);
      }
      if (splitVectorAvailable) {
        const vector = await deps.vectorIndex.search(
          request.projectId,
          queryVector,
          sourceLimit,
        );
        reasons.push(...uniqueReasons(vector.degradationReasons));
        const ranked = rankAuthorizedMatches({
          projectId: request.projectId,
          matches: filterMaskedMatches(
            applyBranchScope(vector.matches),
            overlayMaskedPaths,
          ),
          source: 'baseline' as const,
          rankSource: 'baseline_vector' as const,
          freshness: resultFreshness,
        });
        if (ranked.unauthorizedRowsFiltered) reasons.push('unauthorized_rows_filtered');
        candidates.push(...ranked.candidates);
      }
    }
  }

  reasons.push(...branchScopeReasons({ sourceIndex, staleIncluded: staleBranchIncluded }));
  const deduped = fuseRrfMatches(candidates).slice(0, request.topK);
  const lexicalOnly = lexicalAvailable && !legacyVectorAvailable && !splitVectorAvailable;
  return finalizeSemanticSearchResult({
    deps,
    request,
    sourceIndex,
    matches: deduped,
    reasons,
    lexicalOnly,
    overlayPresent: overlay !== null,
    resultFreshness,
    staleBranchIncluded,
  });
}
