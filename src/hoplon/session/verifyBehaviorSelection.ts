import type { TestOracleResult } from '../contracts/getRelevantTests.js';
import type {
  VerifyBehaviorNote,
  VerifyBehaviorOptions,
} from '../contracts/verifyBehavior.js';
import type { HoplonEngine } from '../engine/types.js';

type SelectionNote = VerifyBehaviorNote;

export type SelectionResult =
  | {
      kind: 'run';
      strategy: 'oracle' | 'override' | 'full_suite_fallback';
      testsExecuted: string[];
      runFullSuite: boolean;
      oracleResult: TestOracleResult | null;
      coverageConfidence: 'exact' | 'conservative' | 'override' | 'full_suite';
      modifiedFilesSource: 'session_changed_files' | 'caller_supplied' | 'none';
      notes: SelectionNote[];
    }
  | {
      kind: 'not_run';
      unavailabilityReason:
        | 'selection_empty_exact'
        | 'selection_empty_conservative';
      reasonDetail: string;
      note: SelectionNote;
      oracleResult: TestOracleResult | null;
      coverageConfidence: 'exact' | 'conservative' | 'not_applicable';
      modifiedFilesSource: 'session_changed_files' | 'caller_supplied' | 'none';
    }
  | {
      kind: 'oracle_failure';
      reasonDetail: string;
      modifiedFilesSource: 'session_changed_files' | 'caller_supplied' | 'none';
    };

interface BuildSelectionArgs {
  readonly engine: HoplonEngine | null;
  readonly options: VerifyBehaviorOptions;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly sessionChangedFiles: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly notes: Set<VerifyBehaviorNote>;
}

export async function buildSelection(
  args: BuildSelectionArgs,
): Promise<SelectionResult> {
  const hasOverride =
    args.options.testsOverride !== undefined &&
    args.options.testsOverride.length > 0;

  const modifiedFiles =
    args.options.modifiedFilesOverride !== undefined
      ? args.options.modifiedFilesOverride
      : args.sessionChangedFiles;
  const modifiedFilesSource: 'session_changed_files' | 'caller_supplied' | 'none' =
    args.options.modifiedFilesOverride !== undefined
      ? 'caller_supplied'
      : args.sessionChangedFiles.length > 0
        ? 'session_changed_files'
        : 'none';

  let oracleResult: TestOracleResult | null = null;
  if (args.engine && modifiedFiles.length > 0) {
    try {
      oracleResult = await args.engine.getRelevantTests(
        {
          projectId: args.projectId,
          runId: args.runId,
          correlationId: args.correlationId,
          modifiedFiles: [...modifiedFiles],
          testPatterns:
            args.options.testPatterns !== undefined
              ? [...args.options.testPatterns]
              : ['.test.', '.spec.', '/tests/'],
          maxDepth:
            args.options.maxDepth !== undefined ? args.options.maxDepth : 2,
        },
        args.signal,
      );
    } catch (err) {
      if (!hasOverride) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          kind: 'oracle_failure',
          reasonDetail: detail,
          modifiedFilesSource,
        };
      }
      oracleResult = null;
    }
  }

  if (hasOverride) {
    const sorted = [...(args.options.testsOverride ?? [])].sort();
    return {
      kind: 'run',
      strategy: 'override',
      testsExecuted: sorted,
      runFullSuite: false,
      oracleResult,
      coverageConfidence: 'override',
      modifiedFilesSource,
      notes: ['selection_override'],
    };
  }

  if (oracleResult === null) {
    return {
      kind: 'not_run',
      unavailabilityReason: 'selection_empty_exact',
      reasonDetail: 'oracle not consulted (no engine or empty modifiedFiles)',
      note: 'no_selected_tests',
      oracleResult: null,
      coverageConfidence: 'not_applicable',
      modifiedFilesSource,
    };
  }

  const onConservative = args.options.onConservativeCoverage ?? 'not_run';
  if (oracleResult.coverageConfidence === 'conservative') {
    if (onConservative === 'full_suite') {
      return {
        kind: 'run',
        strategy: 'full_suite_fallback',
        testsExecuted: [],
        runFullSuite: true,
        oracleResult,
        coverageConfidence: 'full_suite',
        modifiedFilesSource,
        notes: ['selection_conservative', 'full_suite_fallback'],
      };
    }
    if (onConservative === 'run_anyway') {
      if (oracleResult.relevantTests.length === 0) {
        return {
          kind: 'not_run',
          unavailabilityReason: 'selection_empty_conservative',
          reasonDetail:
            'oracle returned conservative coverage with zero relevant tests',
          note: 'selection_conservative',
          oracleResult,
          coverageConfidence: 'conservative',
          modifiedFilesSource,
        };
      }
      return {
        kind: 'run',
        strategy: 'oracle',
        testsExecuted: [...oracleResult.relevantTests],
        runFullSuite: false,
        oracleResult,
        coverageConfidence: 'conservative',
        modifiedFilesSource,
        notes: ['selection_conservative', 'selection_oracle'],
      };
    }
    return {
      kind: 'not_run',
      unavailabilityReason: 'selection_empty_conservative',
      reasonDetail:
        'oracle returned conservative coverage; caller did not opt into full-suite fallback',
      note: 'selection_conservative',
      oracleResult,
      coverageConfidence: 'conservative',
      modifiedFilesSource,
    };
  }

  if (oracleResult.relevantTests.length === 0) {
    return {
      kind: 'not_run',
      unavailabilityReason: 'selection_empty_exact',
      reasonDetail:
        'oracle returned exact coverage with zero relevant tests for the modified files',
      note: 'no_selected_tests',
      oracleResult,
      coverageConfidence: 'exact',
      modifiedFilesSource,
    };
  }

  return {
    kind: 'run',
    strategy: 'oracle',
    testsExecuted: [...oracleResult.relevantTests],
    runFullSuite: false,
    oracleResult,
    coverageConfidence: 'exact',
    modifiedFilesSource,
    notes: ['selection_oracle'],
  };
}
