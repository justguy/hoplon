import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type {
  GetRelevantTestsRequest,
  TestOracleResult,
} from '../contracts/getRelevantTests.js';
import { queryStructure } from './queryStructure.js';
import type { QueryStructureDeps } from './queryStructure.js';
import { STD_QUERY_IMPORTS } from './stdQueries.js';
import {
  DYNAMIC_REQUIRE_QUERIES,
  buildForwardGraph,
  bfsReachable,
  collectFiles,
  emptyResult,
  normalizePath,
} from './getRelevantTestsInternal.js';
import {
  classifyModifiedFileBlindSpots,
  modifiedFilesRequireConservativeCoverage,
} from './getRelevantTestsConservative.js';
import {
  buildTestPatternDiagnostics,
  buildUnmatchedModifiedFileDiagnostics,
} from './getRelevantTestsDiagnostics.js';
import {
  enrichDidYouMeanWithSemanticSuggestions,
  buildSemanticRelevantTestCandidates,
  type RelevantTestsSemanticSearch,
} from './getRelevantTestsSemanticAdvisory.js';
import {
  dynamicImportBlindSpots,
  mergeRelevantTestDiagnostics,
} from './getRelevantTestsResultDiagnostics.js';
import { loadTestAffinityManifests } from './testAffinityManifest.js';
import { composeDeterministicAffinity } from './testAffinityComposition.js';

export interface RunRelevantTestsArgs {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
  validated: GetRelevantTestsRequest;
  signal: AbortSignal | undefined;
  testPatternsProvided: boolean;
  semanticSearch?: RelevantTestsSemanticSearch;
}

export async function runRelevantTestsCore(
  args: RunRelevantTestsArgs,
): Promise<TestOracleResult> {
  const { fs, codeIntelligence, emitter, engineId, root, config, validated, signal } = args;
  const allFiles = await collectFiles(fs, '.');
  allFiles.sort();
  const modifiedInputsRequireConservative =
    modifiedFilesRequireConservativeCoverage(validated.modifiedFiles);
  const blindSpots = classifyModifiedFileBlindSpots(validated.modifiedFiles);

  if (signal?.aborted) throw abortError(signal);
  if (allFiles.length === 0) {
    return {
      ...emptyResult(validated.modifiedFiles),
      coverageConfidence: modifiedInputsRequireConservative ? 'conservative' : 'exact',
    };
  }

  const qsDeps: QueryStructureDeps = {
    fs, codeIntelligence, emitter, engineId, root, config,
  };
  const importResult = await queryStructure(qsDeps, {
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    files: allFiles,
    queries: [...STD_QUERY_IMPORTS],
  }, signal);

  if (signal?.aborted) throw abortError(signal);
  const dynamicResult = await queryStructure(qsDeps, {
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: `${validated.correlationId}--dyn`,
    files: allFiles,
    queries: [...DYNAMIC_REQUIRE_QUERIES],
  }, signal);

  const forwardGraph = buildForwardGraph(allFiles, importResult.matches);
  const testPatterns = validated.testPatterns;
  const testFiles = allFiles.filter((f) => testPatterns.some((pat) => f.includes(pat)));
  const diagnostics = args.testPatternsProvided
    ? buildTestPatternDiagnostics({ testPatterns, allFiles })
    : undefined;
  const unmatchedModifiedFiles = buildUnmatchedModifiedFileDiagnostics({
    modifiedFiles: validated.modifiedFiles,
    allFiles,
  });
  const result = selectRelevantTests({
    validated,
    testFiles,
    forwardGraph,
    hasDynamicRequire: dynamicResult.matches.length > 0,
    modifiedInputsRequireConservative,
  });
  const allBlindSpots = [
    ...blindSpots,
    ...dynamicImportBlindSpots(dynamicResult.matches),
  ].sort((a, b) => `${a.reason}:${a.path ?? ''}`.localeCompare(`${b.reason}:${b.path ?? ''}`));
  const enrichedDidYouMean = await enrichDidYouMeanWithSemanticSuggestions({
    request: validated,
    allFiles,
    unmatchedTestPatterns: diagnostics?.unmatchedTestPatterns ?? [],
    unmatchedModifiedFiles: unmatchedModifiedFiles ?? [],
    ...(args.semanticSearch !== undefined ? { semanticSearch: args.semanticSearch } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const semanticRelevantTestCandidates = await buildSemanticRelevantTestCandidates({
    request: validated,
    staticResult: result,
    testFiles,
    blindSpots: allBlindSpots,
    ...(args.semanticSearch !== undefined ? { semanticSearch: args.semanticSearch } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const affinity = await loadTestAffinityManifests(fs);
  const deterministic = composeDeterministicAffinity({
    importGraphTests: result.relevantTests,
    affinityEntries: affinity.entries,
    affinityIssues: affinity.issues,
    modifiedFiles: validated.modifiedFiles,
    coverageConfidence: result.coverageConfidence,
  });
  result.relevantTests = deterministic.relevantTests;
  result.deterministicRelevantTests = deterministic.deterministicRelevantTests;
  result.deterministicCoverage = deterministic.deterministicCoverage;
  result.semanticAdvisoryUsed = semanticRelevantTestCandidates !== undefined ||
    enrichedDidYouMean.unmatchedTestPatterns.some((d) =>
      d.suggestions?.some((s) => s.source === 'semantic_search'),
    ) ||
    enrichedDidYouMean.unmatchedModifiedFiles.some((d) =>
      d.suggestions.some((s) => s.source === 'semantic_search'),
    );
  result.diagnostics = mergeRelevantTestDiagnostics({
    base: enrichedDidYouMean.unmatchedTestPatterns.length > 0
      ? { unmatchedTestPatterns: enrichedDidYouMean.unmatchedTestPatterns }
      : undefined,
    unmatchedModifiedFiles: enrichedDidYouMean.unmatchedModifiedFiles.length > 0
      ? enrichedDidYouMean.unmatchedModifiedFiles
      : undefined,
    blindSpots: allBlindSpots,
    semanticRelevantTestCandidates,
  });
  return result;
}

function selectRelevantTests(args: {
  validated: GetRelevantTestsRequest;
  testFiles: readonly string[];
  forwardGraph: ReturnType<typeof buildForwardGraph>;
  hasDynamicRequire: boolean;
  modifiedInputsRequireConservative: boolean;
}): TestOracleResult {
  const modifiedSet = new Set(args.validated.modifiedFiles.map(normalizePath));
  const relevantTests: string[] = [];
  const reachedModified = new Set<string>();
  for (const testFile of args.testFiles) {
    const normTest = normalizePath(testFile);
    if (modifiedSet.has(normTest)) {
      relevantTests.push(testFile);
      reachedModified.add(normTest);
      continue;
    }
    const reached = bfsReachable(normTest, args.forwardGraph, args.validated.maxDepth);
    if ([...modifiedSet].some((modFile) => reached.has(modFile))) {
      relevantTests.push(testFile);
      for (const modFile of modifiedSet) if (reached.has(modFile)) reachedModified.add(modFile);
    }
  }
  return {
    relevantTests: relevantTests.sort(),
    coverageConfidence:
      args.hasDynamicRequire || args.modifiedInputsRequireConservative ? 'conservative' : 'exact',
    unusedModifiedFiles: args.validated.modifiedFiles
      .filter((f) => !reachedModified.has(normalizePath(f)))
      .sort(),
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}
