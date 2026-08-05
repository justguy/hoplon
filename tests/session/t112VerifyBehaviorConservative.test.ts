import { describe, expect, it } from 'vitest';

import { composeVerifyBehaviorResult } from '../../src/hoplon/session/verifyBehavior.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import {
  createStubBehaviorTestRunner,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { BehaviorTestRunOutcome } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';
import { RepairContextSchema } from '../../src/hoplon/contracts/repairContext.js';
import { BLOCK_AUDIT, MANIFEST, makeMockEngine } from './helpers.js';

function fakeEngineWithOracle(result: TestOracleResult): HoplonEngine {
  return {
    getRelevantTests: async () => result,
  } as unknown as HoplonEngine;
}

const BASE_INPUT = {
  projectId: 'proj-t112',
  runId: 'run-t112',
  correlationId: 'corr-t112',
  projectRoot: '/ws',
  sessionId: 'sess-t112',
  snapshotRefId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  changedFiles: ['src/foo.ts'],
  attemptNumber: null,
  now: () => 1_737_000_000_111,
} as const;

function makeExitNonZeroOutcome(
  stderr: string,
  structured: unknown,
): BehaviorTestRunOutcome {
  return {
    runnerId: 'local-failing-runner',
    startedAt: '2026-04-21T00:00:00Z',
    completedAt: '2026-04-21T00:00:01Z',
    durationMs: 321,
    workingDirectory: '/ws',
    exitStatus: {
      kind: 'exit_code',
      code: 1,
      signal: null,
      reason: null,
    },
    failingTests: [],
    passingTestCount: 0,
    skippedTestCount: 0,
    stdout: 'suite skipped due to process problem',
    stderr,
    structured,
    truncated: false,
  };
}

describe('composeVerifyBehaviorResult — conservative default', () => {
  it('does not run tests and returns UNAVAILABLE/NOT_RUN when coverage is conservative by default', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'conservative',
      unusedModifiedFiles: [],
    };

    let runCalls = 0;
    const runner = {
      id: 'conservative-runner',
      async describeAvailability() {
        return { available: true };
      },
      async run() {
        runCalls += 1;
        throw new Error('should not run');
      },
    };

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine: fakeEngineWithOracle(oracle),
      runner,
      options: {},
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.unavailabilityReason).toBe('selection_empty_conservative');
    expect(result.selection.strategy).toBe('none');
    expect(result.selection.coverageConfidence).toBe('conservative');
    expect(result.selection.oracleResult).toEqual({
      ...oracle,
    });
    expect(result.notes).toContain('selection_conservative');
    expect(runCalls).toBe(0);
  });
});

describe('composeVerifyBehaviorResult — exact run with nonzero exit and no failures', () => {
  it('returns DEGRADED/FAIL with preserved exit status, stderr, and structured output', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/math.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: ['unused-one.ts'],
    };
    const structured = { kind: 'runner-json', tests: ['tests/math.test.ts'] };

    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: {
            kind: 'testFiles',
            testFiles: ['tests/math.test.ts'],
          },
          outcome: makeExitNonZeroOutcome(
            'runner command returned exit 1 with no failing tests',
            structured,
          ),
        },
      ],
    });

    const result = await composeVerifyBehaviorResult({
      ...BASE_INPUT,
      engine: fakeEngineWithOracle(oracle),
      runner,
      options: {},
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.outcome).toBe('FAIL');
    expect(result.unavailabilityReason).toBeNull();
    expect(result.notes).toContain('runner_exit_nonzero_no_failing_tests');
    expect(result.selection.strategy).toBe('oracle');
    expect(result.selection.coverageConfidence).toBe('exact');
    expect(result.selection.testsExecuted).toEqual(['tests/math.test.ts']);
    expect(result.execution.exitStatus).toEqual({
      kind: 'exit_code',
      code: 1,
      signal: null,
      reason: null,
    });
    expect(result.evidence.stderr).toBe(
      'runner command returned exit 1 with no failing tests',
    );
    expect(result.evidence.structured).toEqual(structured);
  });
});

describe('RepairContext — behavior verification carry-through', () => {
  it('preserves conservative NOT_RUN selection evidence when repair context is packaged', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/config.test.ts'],
      coverageConfidence: 'conservative',
      unusedModifiedFiles: ['package.json'],
    };
    let runCalls = 0;
    const runner = {
      id: 'repair-conservative-runner',
      async describeAvailability() {
        return { available: true };
      },
      async run() {
        runCalls += 1;
        throw new Error('should not run');
      },
    };
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        getRelevantTests: async () => oracle,
        auditDiff: async () => BLOCK_AUDIT,
      }),
      manifest: MANIFEST,
      behaviorTestRunner: runner,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['package.json']);
    const verification = await session.verifyBehavior();
    await session.audit();
    await session.revert();
    await session.extractRollbackTemplate();

    const repair = await session.getRepairContext();

    expect(RepairContextSchema.safeParse(repair).success).toBe(true);
    expect(runCalls).toBe(0);
    expect(verification.status).toBe('UNAVAILABLE');
    expect(repair.behaviorVerification?.unavailabilityReason).toBe(
      'selection_empty_conservative',
    );
    expect(repair.behaviorVerification?.selection.oracleResult).toEqual(oracle);
    expect(repair.behaviorVerification?.execution.exitStatus.kind).toBe(
      'not_run',
    );
  });

  it('preserves raw runner status and evidence in repair context after an exact run fails', async () => {
    const structured = { kind: 'runner-json', total: 1 };
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: {
            kind: 'testFiles',
            testFiles: ['tests/math.test.ts'],
          },
          outcome: makeExitNonZeroOutcome(
            'runner command returned exit 1 with no failing tests',
            structured,
          ),
        },
      ],
    });
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        getRelevantTests: async () => ({
          relevantTests: ['tests/math.test.ts'],
          coverageConfidence: 'exact',
          unusedModifiedFiles: [],
        }),
        auditDiff: async () => BLOCK_AUDIT,
      }),
      manifest: MANIFEST,
      behaviorTestRunner: runner,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.verifyBehavior();
    await session.audit();
    await session.revert();
    await session.extractRollbackTemplate();

    const repair = await session.getRepairContext();

    expect(RepairContextSchema.safeParse(repair).success).toBe(true);
    expect(repair.behaviorVerification?.status).toBe('DEGRADED');
    expect(repair.behaviorVerification?.outcome).toBe('FAIL');
    expect(repair.behaviorVerification?.execution.exitStatus).toEqual({
      kind: 'exit_code',
      code: 1,
      signal: null,
      reason: null,
    });
    expect(repair.behaviorVerification?.evidence.stderr).toBe(
      'runner command returned exit 1 with no failing tests',
    );
    expect(repair.behaviorVerification?.evidence.structured).toEqual(structured);
  });
});
