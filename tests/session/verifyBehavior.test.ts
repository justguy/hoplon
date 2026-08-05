/**
 * tests/session/verifyBehavior.test.ts — t-067 composer proof.
 *
 * Covers the six paths the close-out contract must settle:
 *   1. default oracle-selected run → PASS
 *   2. caller override → FAIL + actionable evidence preserved
 *   3. conservative coverage, default onConservative='not_run' → NOT_RUN
 *   4. conservative coverage + full_suite fallback → runs full suite
 *   5. no runner injected → UNAVAILABLE / no_runner
 *   6. runner throws → DEGRADED / runner_error (envelope preserved)
 *
 * The composer talks only to the shipped `getRelevantTests` seam via a mock
 * engine and a stub test runner — no filesystem, git, or real tree-sitter.
 */

import { describe, expect, it } from 'vitest';

import { composeVerifyBehaviorResult } from '../../src/hoplon/session/verifyBehavior.js';
import {
  createStubBehaviorTestRunner,
  createNoopBehaviorTestRunner,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type {
  BehaviorTestRunOutcome,
  BehaviorTestRunnerAdapter,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type {
  TestOracleResult,
} from '../../src/hoplon/contracts/getRelevantTests.js';
import { VerifyBehaviorResultSchema } from '../../src/hoplon/contracts/verifyBehavior.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeEngineWithOracle(result: TestOracleResult): HoplonEngine {
  return {
    getRelevantTests: async () => result,
  } as unknown as HoplonEngine;
}

function fakeEngineOracleThrows(err: Error): HoplonEngine {
  return {
    getRelevantTests: async () => {
      throw err;
    },
  } as unknown as HoplonEngine;
}

const BASE_INPUT = {
  projectId: 'proj-t067',
  runId: 'run-1',
  correlationId: 'corr-1',
  projectRoot: '/ws',
  sessionId: 'sess-1',
  snapshotRefId: 'sha256:abc',
  changedFiles: ['src/foo.ts'],
  attemptNumber: null,
  now: () => 1_737_000_000_000,
} as const;

function passOutcome(testFiles: readonly string[]): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-pass',
    startedAt: '2026-04-21T00:00:00Z',
    completedAt: '2026-04-21T00:00:01Z',
    durationMs: 1_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 0, signal: null, reason: null },
    failingTests: [],
    passingTestCount: testFiles.length,
    skippedTestCount: 0,
    stdout: 'OK',
    stderr: null,
    structured: { total: testFiles.length, failed: 0 },
    truncated: false,
  };
}

function failOutcome(): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-fail',
    startedAt: '2026-04-21T00:00:00Z',
    completedAt: '2026-04-21T00:00:02Z',
    durationMs: 2_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
    failingTests: [
      {
        testId: 'tests/math.test.ts > add > handles zero',
        name: 'handles zero',
        file: 'tests/math.test.ts',
        failureMessage: 'AssertionError: expected 1 to equal 0',
        stack: 'Error: ...\n    at tests/math.test.ts:4:5',
        durationMs: 12,
        assertions: [{ expected: 0, actual: 1 }],
      },
    ],
    passingTestCount: 3,
    skippedTestCount: 0,
    stdout: 'RUN\nFAIL tests/math.test.ts\n',
    stderr: null,
    structured: { total: 4, failed: 1 },
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// 1. default oracle-selected path
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — default oracle path', () => {
  it('runs the tests the oracle selected and reports AVAILABLE/PASS', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/math.test.ts'] },
          outcome: passOutcome(['tests/math.test.ts']),
        },
      ],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.outcome).toBe('PASS');
    expect(result.unavailabilityReason).toBeNull();
    expect(result.selection.strategy).toBe('oracle');
    expect(result.selection.testsExecuted).toEqual(['tests/math.test.ts']);
    expect(result.selection.coverageConfidence).toBe('exact');
    expect(result.selection.oracleResult?.relevantTests).toEqual([
      'tests/math.test.ts',
    ]);
    expect(result.evidence.passingTestCount).toBe(1);
    expect(result.evidence.stdout).toBe('OK');
    expect(result.notes).toContain('selection_oracle');
    expect(result.linkage.sessionId).toBe('sess-1');
    expect(result.linkage.snapshotRefId).toBe('sha256:abc');
    expect(result.linkage.changedFiles).toEqual(['src/foo.ts']);
    expect(result.advisory).toBe(true);
    expect(result.version).toBe(1);
    expect(result.verificationSemanticGap).toBeUndefined();
  });

  it('adds opt-in semantic-gap metadata without changing runner execution', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: ['src/untested.ts'],
    };
    const engine = fakeEngineWithOracle(oracle);
    const seenTestFiles: string[][] = [];
    const runner: BehaviorTestRunnerAdapter = {
      id: 'semantic-gap-runner',
      async describeAvailability() {
        return { available: true };
      },
      async run(req) {
        seenTestFiles.push([...req.testFiles]);
        return failOutcome();
      },
    };

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      changedFiles: ['src/foo.ts', 'src/untested.ts'],
      options: { includeSemanticGapIntelligence: true },
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.outcome).toBe('FAIL');
    expect(seenTestFiles).toEqual([['tests/math.test.ts']]);
    expect(result.verificationSemanticGap?.surface).toBe('verification');
    expect(result.verificationSemanticGap?.sidecarKind).toBe(
      'verification_semantic_gap',
    );
    expect(result.verificationSemanticGap?.provider.status).toBe('available');
    expect(result.verificationSemanticGap?.authority.canMutateFiles).toBe(false);
    expect(
      result.verificationSemanticGap?.authority.canChangeDeterministicVerdict,
    ).toBe(false);
    expect(
      result.verificationSemanticGap?.strictAgentAccess.exposesFilesystemTool,
    ).toBe(false);
    expect(result.verificationSemanticGap?.payload.relevantTests).toMatchObject({
      testsExecuted: ['tests/math.test.ts'],
      oracleRelevantTests: ['tests/math.test.ts'],
      oracleUnusedModifiedFiles: ['src/untested.ts'],
    });
    expect(result.verificationSemanticGap?.payload.mutatedSubjects).toEqual([
      {
        kind: 'file',
        path: 'src/foo.ts',
        origin: 'verify_behavior_linkage',
      },
      {
        kind: 'file',
        path: 'src/untested.ts',
        origin: 'verify_behavior_linkage',
      },
    ]);
    expect(result.verificationSemanticGap?.payload.observations).toContain(
      'behavior_failed',
    );
    expect(result.verificationSemanticGap?.payload.observations).toContain(
      'changed_files_without_oracle_match',
    );
    expect(
      result.verificationSemanticGap?.payload.failingTests[0],
    ).not.toHaveProperty('failureMessage');
    expect(result.verificationSemanticGap?.payload).not.toHaveProperty('stdout');
  });
});

// ---------------------------------------------------------------------------
// 2. caller override path with failing test
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — caller override + FAIL', () => {
  it('runs the overridden tests and preserves the failure envelope', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/irrelevant.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: {
            kind: 'testFiles',
            testFiles: ['tests/math.test.ts', 'tests/override.test.ts'],
          },
          outcome: failOutcome(),
        },
      ],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {
        testsOverride: ['tests/override.test.ts', 'tests/math.test.ts'],
      },
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.outcome).toBe('FAIL');
    expect(result.selection.strategy).toBe('override');
    expect(result.selection.coverageConfidence).toBe('override');
    // tests are sorted
    expect(result.selection.testsExecuted).toEqual([
      'tests/math.test.ts',
      'tests/override.test.ts',
    ]);
    // oracle is still echoed so reviewers see what structural selection WOULD
    // have run
    expect(result.selection.oracleResult?.relevantTests).toEqual([
      'tests/irrelevant.test.ts',
    ]);
    expect(result.evidence.failingTests).toHaveLength(1);
    expect(result.evidence.failingTests[0]?.failureMessage).toContain(
      'expected 1 to equal 0',
    );
    expect(result.evidence.failingTests[0]?.stack).toContain('math.test.ts');
    expect(result.evidence.stdout).toContain('FAIL tests/math.test.ts');
    // raw runner structured data is preserved verbatim
    expect(result.evidence.structured).toEqual({ total: 4, failed: 1 });
    expect(result.execution.exitStatus).toEqual({
      kind: 'exit_code',
      code: 1,
      signal: null,
      reason: null,
    });
    expect(result.notes).toContain('selection_override');
  });
});

// ---------------------------------------------------------------------------
// 3. conservative coverage → default NOT_RUN
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — conservative coverage, default', () => {
  it('records NOT_RUN with selection_empty_conservative and preserves the oracle', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/scanned.test.ts'],
      coverageConfidence: 'conservative',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
    // Runner exists but should NOT be called on the NOT_RUN path.
    let ranCount = 0;
    const runner: BehaviorTestRunnerAdapter = {
      id: 'should-not-run',
      async describeAvailability() {
        return { available: true };
      },
      async run() {
        ranCount += 1;
        return passOutcome([]);
      },
    };

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('selection_empty_conservative');
    expect(result.selection.strategy).toBe('none');
    expect(result.selection.testsExecuted).toEqual([]);
    expect(result.selection.oracleResult?.coverageConfidence).toBe(
      'conservative',
    );
    expect(result.selection.coverageConfidence).toBe('conservative');
    expect(result.evidence.passingTestCount).toBe(0);
    expect(result.notes).toContain('selection_conservative');
    // Critical invariant: the runner was not spawned.
    expect(ranCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. conservative coverage + full-suite fallback
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — conservative + full_suite fallback', () => {
  it('asks the runner for the full suite and marks strategy=full_suite_fallback', async () => {
    const oracle: TestOracleResult = {
      relevantTests: [],
      coverageConfidence: 'conservative',
      unusedModifiedFiles: ['src/foo.ts'],
    };
    const engine = fakeEngineWithOracle(oracle);
    const seenRequests: boolean[] = [];
    const runner: BehaviorTestRunnerAdapter = {
      id: 'full-suite-stub',
      async describeAvailability() {
        return { available: true };
      },
      async run(req) {
        seenRequests.push(req.runFullSuite);
        return passOutcome(['suite-all']);
      },
    };

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: { onConservativeCoverage: 'full_suite' },
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.outcome).toBe('PASS');
    expect(result.selection.strategy).toBe('full_suite_fallback');
    expect(result.selection.coverageConfidence).toBe('full_suite');
    expect(result.selection.testsExecuted).toEqual([]);
    expect(result.notes).toEqual(
      expect.arrayContaining(['full_suite_fallback', 'selection_conservative']),
    );
    expect(seenRequests).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// 5. no runner injected
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — no runner injected', () => {
  it('returns UNAVAILABLE / no_runner with runner_not_injected note and runs nothing', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner: null,
      options: {},
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('no_runner');
    expect(result.notes).toContain('runner_not_injected');
    expect(result.selection.strategy).toBe('none');
    expect(result.execution.runnerId).toBeNull();
    expect(result.execution.exitStatus.kind).toBe('not_run');
  });

  it('noop adapter reports runner_unavailable, not runner_not_injected', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner: createNoopBehaviorTestRunner(),
      options: {},
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('runner_unavailable');
    expect(result.execution.runnerId).toBe('noop-behavior-runner');
  });
});

// ---------------------------------------------------------------------------
// 6. runner throws → DEGRADED / runner_error
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — runner error', () => {
  it('captures the error in exitStatus.reason and surfaces DEGRADED/runner_error', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
    const runner = createStubBehaviorTestRunner({
      fixtures: [],
      throwOnRun: new Error('spawn ENOENT vitest'),
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(VerifyBehaviorResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('DEGRADED');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('runner_error');
    expect(result.execution.exitStatus).toEqual({
      kind: 'runner_error',
      code: null,
      signal: null,
      reason: 'spawn ENOENT vitest',
    });
    expect(result.execution.runnerId).toBe('stub-behavior-runner');
    expect(result.selection.strategy).toBe('oracle');
    // The runner threw, so we carried the selection truth forward, but no
    // evidence was collected — this is the difference between "we didn't run"
    // and "we ran and it passed".
    expect(result.evidence.failingTests).toEqual([]);
    expect(result.evidence.passingTestCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. oracle failure without override
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — oracle failure without override', () => {
  it('returns UNAVAILABLE / oracle_failure when no override list is available', async () => {
    const engine = fakeEngineOracleThrows(new Error('tree-sitter grammar missing'));
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        { matches: { kind: 'any' }, outcome: passOutcome(['x']) },
      ],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('oracle_failure');
    expect(result.notes).toContain('oracle_failure');
  });

  it('override path survives an oracle failure and still runs the caller list', async () => {
    const engine = fakeEngineOracleThrows(new Error('oracle exploded'));
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/caller.test.ts'] },
          outcome: passOutcome(['tests/caller.test.ts']),
        },
      ],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: { testsOverride: ['tests/caller.test.ts'] },
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.outcome).toBe('PASS');
    expect(result.selection.strategy).toBe('override');
    expect(result.selection.oracleResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. exact coverage with zero relevant tests
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — exact oracle, no relevant tests', () => {
  it('returns UNAVAILABLE / selection_empty_exact with oracle echoed', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: [],
      coverageConfidence: 'exact',
      unusedModifiedFiles: ['src/foo.ts'],
    });
    const runner = createStubBehaviorTestRunner({
      fixtures: [{ matches: { kind: 'any' }, outcome: passOutcome([]) }],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('selection_empty_exact');
    expect(result.selection.oracleResult?.unusedModifiedFiles).toEqual([
      'src/foo.ts',
    ]);
    expect(result.notes).toContain('no_selected_tests');
  });
});

// ---------------------------------------------------------------------------
// 9. schema invariants
// ---------------------------------------------------------------------------

describe('VerifyBehaviorResultSchema — status/outcome invariants', () => {
  it('rejects impossible status/outcome pairings the composer never emits', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/math.test.ts'] },
          outcome: passOutcome(['tests/math.test.ts']),
        },
      ],
    });
    const valid = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(VerifyBehaviorResultSchema.safeParse(valid).success).toBe(true);
    expect(
      VerifyBehaviorResultSchema.safeParse({
        ...valid,
        status: 'UNAVAILABLE',
      }).success,
    ).toBe(false);
    expect(
      VerifyBehaviorResultSchema.safeParse({
        ...valid,
        status: 'DEGRADED',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. availability probe abort classification
// ---------------------------------------------------------------------------

describe('composeVerifyBehaviorResult — availability probe abort', () => {
  it('surfaces aborted instead of collapsing the failure into runner_unavailable', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner: BehaviorTestRunnerAdapter = {
      id: 'availability-abort',
      async describeAvailability() {
        const err = new Error('aborted by caller');
        err.name = 'AbortError';
        throw err;
      },
      async run() {
        return passOutcome([]);
      },
    };

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine,
      runner,
      options: {},
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('aborted');
    expect(result.execution.exitStatus).toEqual({
      kind: 'not_run',
      code: null,
      signal: null,
      reason: 'aborted by caller',
    });
  });
});
