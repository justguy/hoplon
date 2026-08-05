import type {
  DeterministicCoverage,
  DeterministicRelevantTest,
  DeterministicTestSource,
  TestAffinityEntry,
  TestAffinityEvidence,
  TestAffinityIssue,
} from '../contracts/testAffinity.js';

export interface ComposeDeterministicAffinityInput {
  importGraphTests: readonly string[];
  affinityEntries: readonly TestAffinityEntry[];
  affinityIssues: readonly TestAffinityIssue[];
  modifiedFiles: readonly string[];
  coverageConfidence: 'exact' | 'conservative';
}

export function composeDeterministicAffinity(
  input: ComposeDeterministicAffinityInput,
): {
  relevantTests: string[];
  deterministicRelevantTests: DeterministicRelevantTest[];
  deterministicCoverage: DeterministicCoverage;
} {
  const byPath = new Map<string, DeterministicRelevantTest>();
  for (const path of input.importGraphTests) {
    addEvidence(byPath, path, 'import_graph', [{
      kind: 'import_graph',
      path,
      detail: 'test imports a modified file within maxDepth',
    }]);
  }
  for (const entry of input.affinityEntries) {
    if (!entryApplies(entry, input.modifiedFiles)) continue;
    const source = entry.source === 'manual' ? 'manual_affinity' : 'generated_affinity';
    for (const test of entry.tests) {
      addEvidence(
        byPath,
        test.path,
        source,
        test.evidence.map((e) => ({
          ...e,
          manifestPath:
            e.manifestPath ??
            (entry.source === 'manual'
              ? '.hoplon/test-affinity.json'
              : '.hoplon/test-affinity.generated.json'),
          entryId: e.entryId ?? entry.id,
          subjectId: e.subjectId ?? entry.subject.id,
        })),
      );
    }
  }
  const deterministicRelevantTests = [...byPath.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const sourceCounts = {
    importGraph: 0,
    manualAffinity: 0,
    generatedAffinity: 0,
  };
  for (const test of deterministicRelevantTests) {
    if (test.sources.includes('import_graph')) sourceCounts.importGraph += 1;
    if (test.sources.includes('manual_affinity')) sourceCounts.manualAffinity += 1;
    if (test.sources.includes('generated_affinity')) sourceCounts.generatedAffinity += 1;
  }
  return {
    relevantTests: deterministicRelevantTests.map((test) => test.path),
    deterministicRelevantTests,
    deterministicCoverage: {
      confidence: input.coverageConfidence,
      selectedTestCount: deterministicRelevantTests.length,
      sourceCounts,
      manifestStatus: manifestStatus(input),
      issues: [...input.affinityIssues],
    },
  };
}

function addEvidence(
  byPath: Map<string, DeterministicRelevantTest>,
  path: string,
  source: DeterministicTestSource,
  evidence: readonly TestAffinityEvidence[],
): void {
  const existing = byPath.get(path);
  if (existing === undefined) {
    byPath.set(path, {
      path,
      sources: [source],
      evidence: [...evidence],
    });
    return;
  }
  if (!existing.sources.includes(source)) {
    existing.sources.push(source);
    existing.sources.sort();
  }
  existing.evidence.push(...evidence);
}

function entryApplies(
  entry: TestAffinityEntry,
  modifiedFiles: readonly string[],
): boolean {
  const modified = new Set(modifiedFiles.map(normalize));
  return entry.subject.definedIn.some((definition) =>
    modified.has(normalize(definition.path)),
  );
}

function normalize(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function manifestStatus(
  input: ComposeDeterministicAffinityInput,
): DeterministicCoverage['manifestStatus'] {
  const nonMissingIssues = input.affinityIssues.filter((issue) => issue.kind !== 'missing');
  if (nonMissingIssues.length > 0 && input.affinityEntries.length > 0) return 'partial';
  if (nonMissingIssues.length > 0) return 'invalid';
  if (input.affinityEntries.length > 0) return 'loaded';
  return 'missing';
}
