import type { QueryMatch } from '../contracts/queryStructure.js';
import type { TestOracleResult } from '../contracts/getRelevantTests.js';

type Diagnostics = NonNullable<TestOracleResult['diagnostics']>;
type BlindSpot = NonNullable<Diagnostics['blindSpots']>[number];

export function dynamicImportBlindSpots(
  matches: readonly QueryMatch[],
): BlindSpot[] {
  return matches
    .map((match) => ({
      source: 'static_oracle' as const,
      reason: 'dynamic_import' as const,
      path: match.path,
      message: 'Dynamic import/require can hide test dependencies from static analysis.',
    }))
    .sort((a, b) => `${a.reason}:${a.path ?? ''}`.localeCompare(`${b.reason}:${b.path ?? ''}`));
}

export function mergeRelevantTestDiagnostics(args: {
  base: TestOracleResult['diagnostics'];
  unmatchedModifiedFiles: Diagnostics['unmatchedModifiedFiles'] | undefined;
  blindSpots: readonly BlindSpot[];
  semanticRelevantTestCandidates:
    | Diagnostics['semanticRelevantTestCandidates']
    | undefined;
}): TestOracleResult['diagnostics'] | undefined {
  if (
    args.base === undefined &&
    args.unmatchedModifiedFiles === undefined &&
    args.blindSpots.length === 0 &&
    args.semanticRelevantTestCandidates === undefined
  ) {
    return undefined;
  }
  return {
    unmatchedTestPatterns: args.base?.unmatchedTestPatterns ?? [],
    ...(args.unmatchedModifiedFiles !== undefined
      ? { unmatchedModifiedFiles: args.unmatchedModifiedFiles }
      : {}),
    ...(args.blindSpots.length > 0 ? { blindSpots: [...args.blindSpots] } : {}),
    ...(args.semanticRelevantTestCandidates !== undefined
      ? { semanticRelevantTestCandidates: args.semanticRelevantTestCandidates }
      : {}),
  };
}
