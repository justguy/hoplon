import type {
  AdvisoryEvidenceState,
  AdvisoryIntelligenceProviderState,
} from '../contracts/advisoryIntelligence.js';
import { createAdvisoryEvidenceState } from '../contracts/advisoryIntelligence.js';
import type { SemanticSearchResult } from '../contracts/semanticSearch.js';
import type {
  SeeCodebaseRequestValidated,
  SeeCodebaseSemanticSearchOptions,
} from '../contracts/seeCodebase.js';
import type {
  ReadAstNodeIdentity,
  ReadSemanticQueryResult,
  ReadSemanticRankedMatch,
  ReadSemanticTwin,
} from '../contracts/seeCodebaseIntelligence.js';
import {
  degradedProvider,
  unavailableProvider,
} from './seeCodebaseIntelligenceShared.js';

export interface SemanticQueryRunSummary {
  readonly queries: readonly ReadSemanticQueryResult[];
  readonly twins: readonly ReadSemanticTwin[];
  readonly sawAvailable: boolean;
  readonly sawEmpty: boolean;
  readonly sawDegraded: boolean;
  readonly sawUnavailable: boolean;
  readonly sawFailure: boolean;
}

export type SemanticSidecarOptions = Omit<
  SeeCodebaseSemanticSearchOptions,
  'topK'
> & {
  readonly topK: number | null;
};

export function resolveSemanticOptions(
  request: SeeCodebaseRequestValidated,
): SemanticSidecarOptions | null {
  const legacyTopK = request.advisoryIntelligence?.semanticTopK ?? null;
  const nested = request.advisoryIntelligence?.semanticSearch;
  if (nested === undefined) {
    return legacyTopK === null ? null : { enabled: true, topK: legacyTopK };
  }
  return {
    ...nested,
    topK: nested.topK ?? legacyTopK,
  };
}

export function semanticEvidence(
  result: SemanticQueryRunSummary,
): AdvisoryEvidenceState {
  if (
    result.sawFailure ||
    result.sawDegraded ||
    ((result.sawAvailable || result.sawEmpty) && result.sawUnavailable)
  ) {
    return createAdvisoryEvidenceState({
      status: 'DEGRADED',
      reason: 'semantic_search_partial_or_failed',
    });
  }
  if (!result.sawAvailable && !result.sawEmpty && result.sawUnavailable) {
    return createAdvisoryEvidenceState({
      status: 'UNAVAILABLE',
      reason: 'semantic_provider_unavailable',
    });
  }
  if ((result.sawAvailable || result.sawEmpty) && result.twins.length === 0) {
    return createAdvisoryEvidenceState({
      status: 'EMPTY',
      reason: 'semantic_search_no_matches',
    });
  }
  if (result.sawAvailable) {
    return createAdvisoryEvidenceState({ status: 'AVAILABLE' });
  }
  return createAdvisoryEvidenceState({
    status: 'NO_VERDICT',
    reason: 'semantic_search_not_executed',
  });
}

export function semanticProvider(
  result: SemanticQueryRunSummary,
): AdvisoryIntelligenceProviderState {
  if (
    (result.sawAvailable || result.sawEmpty) &&
    !result.sawDegraded &&
    !result.sawUnavailable &&
    !result.sawFailure
  ) {
    return {
      providerId: 'semantic_search',
      status: 'available',
      reason: null,
      detail: null,
    };
  }
  if (
    !result.sawAvailable &&
    !result.sawEmpty &&
    !result.sawDegraded &&
    result.sawUnavailable &&
    !result.sawFailure
  ) {
    return unavailableProvider('semantic_search', 'semantic_provider_unavailable');
  }
  return degradedProvider('semantic_search', 'semantic_search_partial_or_failed');
}

export function semanticProviderResultStatus(
  result: Pick<
    SemanticQueryRunSummary,
    'sawAvailable' | 'sawEmpty' | 'sawDegraded' | 'sawUnavailable'
  >,
): SemanticSearchResult['status'] | null {
  if (result.sawAvailable) return 'AVAILABLE';
  if (result.sawEmpty) return 'EMPTY';
  if (result.sawDegraded) return 'DEGRADED';
  if (result.sawUnavailable) return 'UNAVAILABLE';
  return null;
}

export function rankMatches(
  matches: readonly SemanticSearchResult['matches'][number][],
): ReadSemanticRankedMatch[] {
  const ranked: ReadSemanticRankedMatch[] = [];
  let rank = 1;
  for (const match of matches) {
    ranked.push({
      rank,
      id: match.id,
      score: match.score,
      metadata: match.metadata,
      ...(match.source !== undefined ? { source: match.source } : {}),
      ...(match.rankSource !== undefined ? { rankSource: match.rankSource } : {}),
      ...(match.freshness !== undefined ? { freshness: match.freshness } : {}),
    });
    rank += 1;
  }
  return ranked;
}

export function semanticQuery(identity: ReadAstNodeIdentity): string {
  return identity.name ?? `${identity.kind} ${identity.nodeKind} ${identity.path}`;
}
