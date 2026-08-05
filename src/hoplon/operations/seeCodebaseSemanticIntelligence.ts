import type {
  AdvisoryEvidenceState,
  AdvisoryIntelligenceProviderState,
  AdvisoryIntelligenceSidecarEnvelope,
} from '../contracts/advisoryIntelligence.js';
import { createAdvisoryEvidenceState } from '../contracts/advisoryIntelligence.js';
import type {
  SemanticSearchRequest,
  SemanticSearchResult,
} from '../contracts/semanticSearch.js';
import type { SeeCodebaseRequestValidated } from '../contracts/seeCodebase.js';
import {
  ReadSemanticSearchPayloadSchema,
  type ReadAstNodeIdentity,
  type ReadSemanticQueryResult,
  type ReadSemanticTwin,
} from '../contracts/seeCodebaseIntelligence.js';
import {
  degradedProvider,
  makeReadIntelligenceSidecar,
  unavailableProvider,
} from './seeCodebaseIntelligenceShared.js';
import {
  rankMatches,
  resolveSemanticOptions,
  semanticEvidence,
  semanticProvider,
  semanticProviderResultStatus,
  semanticQuery,
  type SemanticQueryRunSummary,
  type SemanticSidecarOptions,
} from './seeCodebaseSemanticIntelligenceHelpers.js';

export type SeeCodebaseSemanticSearch = (
  req: SemanticSearchRequest,
  signal?: AbortSignal,
) => Promise<SemanticSearchResult>;

export async function buildSemanticSearchSidecar({
  request,
  identities,
  semanticSearch,
  signal,
}: {
  request: SeeCodebaseRequestValidated;
  identities: readonly ReadAstNodeIdentity[];
  semanticSearch?: SeeCodebaseSemanticSearch;
  signal?: AbortSignal;
}): Promise<AdvisoryIntelligenceSidecarEnvelope> {
  const options = resolveSemanticOptions(request);
  const topK = options?.topK ?? null;

  if (semanticSearch === undefined) {
    return semanticSidecar({
      provider: unavailableProvider('semantic_search', 'semantic_search_provider_not_bound'),
      topK,
      identities,
      queries: [],
      twins: [],
      providerResultStatus: null,
      evidence: createAdvisoryEvidenceState({
        status: 'UNAVAILABLE',
        reason: 'semantic_search_provider_not_bound',
      }),
    });
  }

  if (options?.enabled === false) {
    return semanticSidecar({
      provider: degradedProvider('semantic_search', 'semantic_search_disabled'),
      topK,
      identities,
      queries: [],
      twins: [],
      providerResultStatus: null,
      evidence: createAdvisoryEvidenceState({
        status: 'NO_VERDICT',
        reason: 'semantic_search_disabled',
      }),
    });
  }

  if (
    request.intent === 'inspect_logs_or_env' &&
    request.advisoryIntelligence?.semanticSearch?.enabled !== true
  ) {
    return semanticSidecar({
      provider: degradedProvider('semantic_search', 'semantic_search_disabled_for_intent'),
      topK,
      identities,
      queries: [],
      twins: [],
      providerResultStatus: null,
      evidence: createAdvisoryEvidenceState({
        status: 'NO_VERDICT',
        reason: 'semantic_search_disabled_for_intent',
      }),
    });
  }

  if (topK === null) {
    return semanticSidecar({
      provider: degradedProvider('semantic_search', 'semantic_top_k_not_requested'),
      topK,
      identities,
      queries: identities.map((sourceAstNode) => ({
        sourceAstNode,
        query: semanticQuery(sourceAstNode),
        resultStatus: 'NOT_REQUESTED',
        rankedMatches: [],
      })),
      twins: [],
      providerResultStatus: null,
      evidence: createAdvisoryEvidenceState({
        status: 'NO_VERDICT',
        reason: 'semantic_top_k_not_requested',
      }),
    });
  }

  if (identities.length === 0) {
    return semanticSidecar({
      provider: degradedProvider('semantic_search', 'no_ast_node_identity'),
      topK,
      identities,
      queries: [],
      twins: [],
      providerResultStatus: null,
      evidence: createAdvisoryEvidenceState({
        status: 'NO_VERDICT',
        reason: 'no_ast_node_identity',
      }),
    });
  }

  const result = await runSemanticQueries({
    request,
    identities,
    semanticSearch,
    topK,
    options: options ?? { enabled: true, topK },
    ...(signal !== undefined ? { signal } : {}),
  });

  return semanticSidecar({
    provider: semanticProvider(result),
    topK,
    identities,
    queries: result.queries,
    twins: result.twins,
    providerResultStatus: semanticProviderResultStatus(result),
    evidence: semanticEvidence(result),
  });
}

async function runSemanticQueries({
  request,
  identities,
  semanticSearch,
  topK,
  options,
  signal,
}: {
  request: SeeCodebaseRequestValidated;
  identities: readonly ReadAstNodeIdentity[];
  semanticSearch: SeeCodebaseSemanticSearch;
  topK: number;
  options: SemanticSidecarOptions;
  signal?: AbortSignal;
}): Promise<SemanticQueryRunSummary> {
  const queries: ReadSemanticQueryResult[] = [];
  const twins: ReadSemanticTwin[] = [];
  let sawAvailable = false;
  let sawEmpty = false;
  let sawDegraded = false;
  let sawUnavailable = false;
  let sawFailure = false;

  for (const sourceAstNode of identities) {
    try {
      const result = await semanticSearch({
        correlationId: request.correlationId,
        projectId: request.projectId,
        query: semanticQuery(sourceAstNode),
        topK,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.freshness !== undefined ? { freshness: options.freshness } : {}),
        ...(options.allowDegraded !== undefined ? { allowDegraded: options.allowDegraded } : {}),
        ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
        ...(options.resultFields !== undefined ? { resultFields: options.resultFields } : {}),
      }, signal);
      if (result.status === 'AVAILABLE') sawAvailable = true;
      if (result.status === 'EMPTY') sawEmpty = true;
      if (result.status === 'DEGRADED') sawDegraded = true;
      if (result.status === 'UNAVAILABLE') sawUnavailable = true;
      const rankedMatches = rankMatches(result.matches);
      for (const match of rankedMatches) {
        twins.push({ sourceAstNode, match, advisoryOnly: true });
      }
      queries.push({
        sourceAstNode,
        query: semanticQuery(sourceAstNode),
        resultStatus: result.status,
        providerStatus: result.providerStatus,
        freshness: result.freshness,
        degradationReasons: result.degradationReasons,
        rankedMatches,
      });
    } catch (err) {
      sawFailure = true;
      queries.push({
        sourceAstNode,
        query: semanticQuery(sourceAstNode),
        resultStatus: 'FAILED',
        rankedMatches: [],
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    queries,
    twins,
    sawAvailable,
    sawEmpty,
    sawDegraded,
    sawUnavailable,
    sawFailure,
  };
}

function semanticSidecar({
  provider,
  topK,
  identities,
  queries,
  twins,
  providerResultStatus,
  evidence,
}: {
  provider: AdvisoryIntelligenceProviderState;
  topK: number | null;
  identities: readonly ReadAstNodeIdentity[];
  queries: readonly ReadSemanticQueryResult[];
  twins: readonly ReadSemanticTwin[];
  providerResultStatus: SemanticSearchResult['status'] | null;
  evidence: AdvisoryEvidenceState;
}): AdvisoryIntelligenceSidecarEnvelope {
  const payload = ReadSemanticSearchPayloadSchema.parse({
    source: 'seeCodebase.structural_results',
    advisoryOnly: true,
    topK,
    topKSource: topK === null ? 'not_requested' : 'request',
    providerResultStatus,
    astNodeIdentities: identities,
    queries,
    semanticTwins: twins,
    deterministicVerdictAuthority: 'structural_manifest_policy_only',
  });
  return makeReadIntelligenceSidecar(
    'read_semantic_search',
    provider,
    payload,
    evidence,
  );
}
