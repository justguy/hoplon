import type { TestOracleResult } from '../contracts/getRelevantTests.js';

type TestPatternDiagnostic = NonNullable<
  TestOracleResult['diagnostics']
>['unmatchedTestPatterns'][number];
type DidYouMeanSuggestion = NonNullable<TestPatternDiagnostic['suggestions']>[number];

export function buildTestPatternDiagnostics(args: {
  testPatterns: readonly string[];
  allFiles: readonly string[];
}): TestOracleResult['diagnostics'] | undefined {
  const unmatchedTestPatterns: TestPatternDiagnostic[] = [];

  for (const pattern of args.testPatterns) {
    if (args.allFiles.some((file) => file.includes(pattern))) continue;
    const didYouMean = deriveSubstringSuggestions(pattern, args.allFiles);
    unmatchedTestPatterns.push({
      pattern,
      message: 'Pattern matched no files; testPatterns use substring matching.',
      didYouMean,
      suggestions: didYouMean.map((value) => deterministicSuggestion(value)),
    });
  }

  if (unmatchedTestPatterns.length === 0) return undefined;
  return { unmatchedTestPatterns };
}

export function buildUnmatchedModifiedFileDiagnostics(args: {
  modifiedFiles: readonly string[];
  allFiles: readonly string[];
}): NonNullable<TestOracleResult['diagnostics']>['unmatchedModifiedFiles'] | undefined {
  const allFileSet = new Set(args.allFiles.map(normalizeComparablePath));
  const unmatched = args.modifiedFiles
    .filter((file) => !allFileSet.has(normalizeComparablePath(file)))
    .map((path) => {
      const didYouMean = derivePathSuggestions(path, args.allFiles);
      return {
        path,
        message: 'Modified file was not found in the scanned static import graph.',
        didYouMean,
        suggestions: didYouMean.map((value) => deterministicSuggestion(value)),
      };
    });
  return unmatched.length === 0 ? undefined : unmatched;
}

function deriveSubstringSuggestions(
  pattern: string,
  allFiles: readonly string[],
): string[] {
  const candidates = new Set<string>();
  for (const fragment of literalFragments(pattern)) {
    for (const candidate of normalizeSuggestionFragments(fragment)) {
      if (candidate.length > 0 && allFiles.some((file) => file.includes(candidate))) {
        candidates.add(candidate);
      }
    }
  }
  const sorted = [...candidates].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a.localeCompare(b);
  });
  return sorted.filter(
    (candidate) => !sorted.some((other) => other !== candidate && other.includes(candidate)),
  );
}

function derivePathSuggestions(path: string, allFiles: readonly string[]): string[] {
  const normalized = normalizeComparablePath(path);
  const tokens = normalized.split(/[/. _-]+/).filter((token) => token.length >= 3);
  const matches = new Set<string>();
  for (const candidate of allFiles) {
    const comparable = normalizeComparablePath(candidate);
    if (tokens.some((token) => comparable.includes(token))) matches.add(candidate);
  }
  return [...matches].sort();
}

function deterministicSuggestion(value: string): DidYouMeanSuggestion {
  return {
    value,
    source: 'deterministic_exact',
    provenance: { kind: 'path_token', matched: value },
  };
}

function normalizeComparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function literalFragments(pattern: string): string[] {
  return pattern.split(/[*?[\]{}()]+/).filter((part) => part.length > 0);
}

function normalizeSuggestionFragments(fragment: string): string[] {
  const normalized = fragment.replace(/\\/g, '/');
  return [
    normalized,
    normalized.replace(/^\/+/, ''),
    normalized.replace(/\/+$/, ''),
    normalized.replace(/^\/+/, '').replace(/\/+$/, ''),
  ];
}
