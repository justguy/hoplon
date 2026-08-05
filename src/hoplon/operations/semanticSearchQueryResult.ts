import { ValidationError } from '../contracts/errors.js';
import {
  SemanticSearchResultSchema,
  type SemanticDegradationReason,
  type SemanticFreshness,
  type SemanticSearchMatch,
  type SemanticSearchRequest,
  type SemanticSearchResult,
} from '../contracts/semanticSearch.js';
import type { SemanticSearchDeps } from './semanticSearchShared.js';
import type { SemanticSearchSourceIndex } from './semanticSearchBranchScope.js';
import { uniqueReasons } from './semanticSearchPolicy.js';
import { buildSemanticSearchSuggestions } from './semanticSearchSuggestions.js';

export function filterMaskedMatches<
  T extends { readonly metadata: Record<string, string | number | boolean> },
>(
  matches: readonly T[],
  maskedPaths: ReadonlySet<string>,
): T[] {
  if (maskedPaths.size === 0) return [...matches];
  return matches.filter((match) => {
    const path = match.metadata.path;
    return typeof path !== 'string' || !maskedPaths.has(path);
  });
}

export function validateSemanticSearchResult(
  deps: SemanticSearchDeps,
  request: SemanticSearchRequest,
  result: Omit<
    SemanticSearchResult,
    'correlationId' | 'projectId' | 'advisory' | 'topK'
  >,
): SemanticSearchResult {
  const value = {
    correlationId: request.correlationId,
    projectId: request.projectId,
    advisory: true,
    topK: request.topK,
    ...result,
  };
  const validated = SemanticSearchResultSchema.safeParse(value);
  if (!validated.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: request.correlationId,
        cause: validated.error,
      },
      `semanticSearch: produced invalid result: ${validated.error.message}`,
    );
  }
  return validated.data;
}

export function finalizeSemanticSearchResult(args: {
  readonly deps: SemanticSearchDeps;
  readonly request: SemanticSearchRequest;
  readonly sourceIndex: SemanticSearchSourceIndex;
  readonly matches: readonly SemanticSearchMatch[];
  readonly reasons: readonly SemanticDegradationReason[];
  readonly lexicalOnly: boolean;
  readonly overlayPresent: boolean;
  readonly resultFreshness: SemanticFreshness;
  readonly staleBranchIncluded: boolean;
}): SemanticSearchResult {
  const degraded = args.reasons.length > 0 || args.lexicalOnly;
  if (degraded && args.request.allowDegraded === false) {
    return validateSemanticSearchResult(args.deps, args.request, {
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: true,
      resultCount: 0,
      freshness: args.resultFreshness,
      degradationReasons: uniqueReasons([
        ...args.reasons,
        args.lexicalOnly ? 'lexical_only_profile' : null,
      ]),
      matches: [],
    });
  }
  const status =
    args.matches.length === 0
      ? degraded
        ? 'DEGRADED'
        : 'EMPTY'
      : degraded
        ? 'DEGRADED'
        : 'AVAILABLE';
  const suggestions = buildSemanticSearchSuggestions({
    request: args.request,
    sourceIndex: args.sourceIndex,
    resultCount: args.matches.length,
    staleIncluded: args.staleBranchIncluded,
  });
  return validateSemanticSearchResult(args.deps, args.request, {
    status,
    providerStatus: status,
    providerAvailable: true,
    resultCount: args.matches.length,
    freshness: args.overlayPresent ? 'live_session' : args.resultFreshness,
    degradationReasons: uniqueReasons([
      ...args.reasons,
      args.lexicalOnly ? 'lexical_only_profile' : null,
    ]),
    matches: [...args.matches],
    ...(suggestions.length === 0 ? {} : { suggestions }),
  });
}
