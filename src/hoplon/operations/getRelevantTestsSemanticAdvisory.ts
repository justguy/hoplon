import type {
  SemanticSearchRequest,
  SemanticSearchResult,
} from '../contracts/semanticSearch.js';
import type {
  GetRelevantTestsRequest,
  TestOracleResult,
} from '../contracts/getRelevantTests.js';
import type {
  SemanticToAffinityPromotionSuggestion,
  TestAffinityEntry,
} from '../contracts/testAffinity.js';

export type RelevantTestsSemanticSearch = (
  req: SemanticSearchRequest,
  signal?: AbortSignal,
) => Promise<SemanticSearchResult>;

type Diagnostics = NonNullable<TestOracleResult['diagnostics']>;
type BlindSpot = NonNullable<Diagnostics['blindSpots']>[number];
type TestPatternDiagnostic = Diagnostics['unmatchedTestPatterns'][number];
type UnmatchedModifiedFileDiagnostic = NonNullable<
  Diagnostics['unmatchedModifiedFiles']
>[number];
type DidYouMeanSuggestion = NonNullable<
  TestPatternDiagnostic['suggestions']
>[number];
type SemanticCandidate = NonNullable<
  Diagnostics['semanticRelevantTestCandidates']
>[number];

export async function enrichDidYouMeanWithSemanticSuggestions(args: {
  request: GetRelevantTestsRequest;
  allFiles: readonly string[];
  unmatchedTestPatterns: readonly TestPatternDiagnostic[];
  unmatchedModifiedFiles: readonly UnmatchedModifiedFileDiagnostic[];
  semanticSearch?: RelevantTestsSemanticSearch;
  signal?: AbortSignal;
}): Promise<{
  unmatchedTestPatterns: TestPatternDiagnostic[];
  unmatchedModifiedFiles: UnmatchedModifiedFileDiagnostic[];
}> {
  const options = args.request.advisoryIntelligence?.semanticSearch;
  if (args.semanticSearch === undefined || options?.enabled === false || options?.topK === undefined) {
    return {
      unmatchedTestPatterns: [...args.unmatchedTestPatterns],
      unmatchedModifiedFiles: [...args.unmatchedModifiedFiles],
    };
  }

  const resultFields = options.resultFields ?? 'path_only';
  const allFileSet = new Set(args.allFiles);
  const unmatchedTestPatterns = await Promise.all(
    args.unmatchedTestPatterns.map(async (diagnostic): Promise<TestPatternDiagnostic> => {
      const suggestions = await semanticDidYouMeanSuggestions({
        request: args.request,
        semanticSearch: args.semanticSearch!,
        query: diagnostic.pattern,
        allFileSet,
        resultFields,
        options,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      return mergeDidYouMeanSuggestions(diagnostic, suggestions);
    }),
  );
  const unmatchedModifiedFiles = await Promise.all(
    args.unmatchedModifiedFiles.map(async (diagnostic): Promise<UnmatchedModifiedFileDiagnostic> => {
      const suggestions = await semanticDidYouMeanSuggestions({
        request: args.request,
        semanticSearch: args.semanticSearch!,
        query: diagnostic.path,
        allFileSet,
        resultFields,
        options,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      return mergeDidYouMeanSuggestions(diagnostic, suggestions);
    }),
  );
  return { unmatchedTestPatterns, unmatchedModifiedFiles };
}

export async function buildSemanticRelevantTestCandidates(args: {
  request: GetRelevantTestsRequest;
  staticResult: Pick<TestOracleResult, 'coverageConfidence' | 'unusedModifiedFiles'>;
  testFiles: readonly string[];
  blindSpots: readonly BlindSpot[];
  semanticSearch?: RelevantTestsSemanticSearch;
  signal?: AbortSignal;
}): Promise<SemanticCandidate[] | undefined> {
  const options = args.request.advisoryIntelligence?.semanticSearch;
  if (args.semanticSearch === undefined) return undefined;
  if (options?.enabled === false) return undefined;
  if (options?.topK === undefined) return undefined;
  if (args.staticResult.coverageConfidence !== 'conservative' && args.blindSpots.length === 0) {
    return undefined;
  }

  const resultFields = options.resultFields ?? 'path_only';
  const result = await args.semanticSearch({
    correlationId: args.request.correlationId,
    projectId: args.request.projectId,
    query: semanticRelevantTestsQuery(args.request.modifiedFiles),
    topK: options.topK,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.freshness !== undefined ? { freshness: options.freshness } : {}),
    ...(options.allowDegraded !== undefined ? { allowDegraded: options.allowDegraded } : {}),
    ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
    resultFields,
  }, args.signal);

  if (result.status !== 'AVAILABLE' && result.status !== 'DEGRADED') return undefined;

  const testFileSet = new Set(args.testFiles);
  const blindSpotReason = firstBlindSpotReason(args.blindSpots, args.staticResult);
  const candidates: SemanticCandidate[] = [];
  const seen = new Set<string>();
  for (const match of result.matches) {
    const path = typeof match.metadata.path === 'string' ? match.metadata.path : undefined;
    if (path === undefined || !testFileSet.has(path) || seen.has(path)) continue;
    seen.add(path);
    candidates.push({
      path,
      advisoryOnly: true,
      reason: 'Static relevant-test coverage is degraded or has a named blind spot.',
      source: 'semantic_search',
      provenance: {
        blindSpotReason,
        resultFields,
        semanticSearch: {
          id: match.id,
          score: match.score,
          status: result.status,
          freshness: match.freshness ?? result.freshness,
          degradationReasons: result.degradationReasons,
        },
      },
      promotionSuggestion: buildPromotionSuggestion({
        request: args.request,
        path,
        semanticMatchId: match.id,
        blindSpotReason,
      }),
    });
  }

  return candidates.length === 0
    ? undefined
    : candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function buildPromotionSuggestion(args: {
  request: GetRelevantTestsRequest;
  path: string;
  semanticMatchId: string;
  blindSpotReason: string;
}): SemanticToAffinityPromotionSuggestion {
  const subjectPath = args.request.modifiedFiles[0] ?? args.path;
  const subjectId = `file:${subjectPath}`;
  const entry: TestAffinityEntry = {
    id: stableAffinityEntryId(subjectPath, args.path),
    source: 'manual',
    subject: {
      kind: 'file',
      id: subjectId,
      definedIn: [{ path: subjectPath }],
    },
    tests: [{
      path: args.path,
      evidence: [{
        kind: 'semantic_search',
        path: args.path,
        subjectId,
        detail:
          `candidate from ${args.semanticMatchId}; blindSpot=${args.blindSpotReason}`,
      }],
    }],
  };
  return {
    action: 'add_manual_affinity_entry',
    manifestPath: '.hoplon/test-affinity.json',
    reason:
      'Semantic retrieval cannot certify test relevance; review and add this deterministic affinity entry if correct.',
    entry,
  };
}

function stableAffinityEntryId(subjectPath: string, testPath: string): string {
  return `semantic:${sanitizeId(subjectPath)}:${sanitizeId(testPath)}`;
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/gu, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function semanticRelevantTestsQuery(modifiedFiles: readonly string[]): string {
  return `tests covering ${modifiedFiles.join(' ')}`;
}

async function semanticDidYouMeanSuggestions(args: {
  request: GetRelevantTestsRequest;
  semanticSearch: RelevantTestsSemanticSearch;
  query: string;
  allFileSet: ReadonlySet<string>;
  resultFields: NonNullable<SemanticSearchRequest['resultFields']>;
  options: NonNullable<NonNullable<GetRelevantTestsRequest['advisoryIntelligence']>['semanticSearch']>;
  signal?: AbortSignal;
}): Promise<DidYouMeanSuggestion[]> {
  const result = await args.semanticSearch({
    correlationId: args.request.correlationId,
    projectId: args.request.projectId,
    query: args.query,
    topK: args.options.topK!,
    ...(args.options.sessionId !== undefined ? { sessionId: args.options.sessionId } : {}),
    ...(args.options.freshness !== undefined ? { freshness: args.options.freshness } : {}),
    ...(args.options.allowDegraded !== undefined ? { allowDegraded: args.options.allowDegraded } : {}),
    ...(args.options.allowStale !== undefined ? { allowStale: args.options.allowStale } : {}),
    resultFields: args.resultFields,
  }, args.signal);
  if (result.status !== 'AVAILABLE' && result.status !== 'DEGRADED') return [];
  const seen = new Set<string>();
  const suggestions: DidYouMeanSuggestion[] = [];
  for (const match of result.matches) {
    const path = typeof match.metadata.path === 'string' ? match.metadata.path : undefined;
    if (path === undefined || !args.allFileSet.has(path) || seen.has(path)) continue;
    seen.add(path);
    suggestions.push({
      value: path,
      source: 'semantic_search',
      provenance: {
        kind: 'semantic_match',
        matched: match.id,
        resultFields: args.resultFields,
      },
    });
  }
  return suggestions.sort((a, b) => a.value.localeCompare(b.value));
}

function mergeDidYouMeanSuggestions<T extends {
  didYouMean: string[];
  suggestions?: DidYouMeanSuggestion[] | undefined;
}>(diagnostic: T, additions: readonly DidYouMeanSuggestion[]): T {
  if (additions.length === 0) return diagnostic;
  const byValue = new Map<string, DidYouMeanSuggestion>();
  for (const suggestion of diagnostic.suggestions ?? []) {
    byValue.set(suggestion.value, suggestion);
  }
  for (const suggestion of additions) {
    if (!byValue.has(suggestion.value)) byValue.set(suggestion.value, suggestion);
  }
  const suggestions = [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
  return {
    ...diagnostic,
    didYouMean: suggestions.map((suggestion) => suggestion.value),
    suggestions,
  };
}

function firstBlindSpotReason(
  blindSpots: readonly BlindSpot[],
  result: Pick<TestOracleResult, 'coverageConfidence' | 'unusedModifiedFiles'>,
): string {
  const first = blindSpots[0];
  if (first !== undefined) return first.reason;
  if (result.coverageConfidence === 'conservative') return 'dynamic_import';
  return 'unknown';
}
