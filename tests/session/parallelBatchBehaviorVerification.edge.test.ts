import { describe, expect, it } from 'vitest';

import { createStubBehaviorTestRunner } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import { BatchBehaviorVerificationResultSchema } from '../../src/hoplon/contracts/parallelBatchBehaviorVerification.js';
import { composeParallelBatchBehaviorVerification } from '../../src/hoplon/session/parallelBatchBehaviorVerification.js';
import {
  BASE,
  failingOutcome,
  failingWithoutStructuredFailuresOutcome,
  fakeEngineWithOracle,
  passOutcome,
  unattributedFailingOutcome,
} from './parallelBatchBehaviorVerificationFixtures.js';
import type {
  BehaviorTestRunnerAdapter,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';

describe('parallel batch behavior verification edge paths', () => {
  it('does not invoke the runner on conservative coverage by default', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'conservative',
      unusedModifiedFiles: [],
    });
    let runs = 0;
    const runner: BehaviorTestRunnerAdapter = {
      id: 'should-not-run',
      async describeAvailability() {
        return { available: true };
      },
      async run() {
        runs += 1;
        return passOutcome([]);
      },
    };

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner,
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/dyn.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(result.outcome).toBe('NOT_RUN');
    expect(result.verifyBehavior.unavailabilityReason).toBe(
      'selection_empty_conservative',
    );
    expect(runs).toBe(0);
  });

  it('keeps unattributed failing-test ids visible', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner = createStubBehaviorTestRunner({
      fixtures: [{ matches: { kind: 'any' }, outcome: unattributedFailingOutcome() }],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner,
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/producer.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(BatchBehaviorVerificationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.failureLinkage.entries).toEqual([]);
    expect(result.failureLinkage.unattributedFailureIds).toEqual([
      'global setup > before all',
    ]);
  });

  it('accepts compiler-style nonzero exits with no structured failing tests', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/integration.test.ts'] },
          outcome: failingWithoutStructuredFailuresOutcome(),
        },
      ],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner,
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/producer.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(BatchBehaviorVerificationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.verifyBehavior.status).toBe('DEGRADED');
    expect(result.verifyBehavior.notes).toContain(
      'runner_exit_nonzero_no_failing_tests',
    );
    expect(result.verifyBehavior.evidence.stderr).toBe(
      'src/consumer.ts(7,3): error TS2322',
    );
    expect(result.failureLinkage).toEqual({
      entries: [],
      unattributedFailureIds: [],
    });
  });

  it('lists every contributing session for shared-file edits deterministically', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/shared.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/shared.test.ts'] },
          outcome: passOutcome(['tests/shared.test.ts']),
        },
      ],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner,
      sessions: [
        {
          sessionId: 'sess-Z',
          changedFiles: ['src/shared.ts', 'src/z-only.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
        {
          sessionId: 'sess-A',
          changedFiles: ['src/shared.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(result.selection.sessionIdsInOrder).toEqual(['sess-A', 'sess-Z']);
    expect(result.selection.unionedChangedFiles).toEqual([
      'src/shared.ts',
      'src/z-only.ts',
    ]);
    expect(result.selection.perFileContributingSessions).toEqual({
      'src/shared.ts': ['sess-A', 'sess-Z'],
      'src/z-only.ts': ['sess-Z'],
    });
  });

  it('never calls auditDiff even when behavior verification fails', async () => {
    let auditCalls = 0;
    const oracle: TestOracleResult = {
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = {
      getRelevantTests: async () => oracle,
      auditDiff: async () => {
        auditCalls += 1;
        return { status: 'PASS' as const, violations: [] };
      },
    } as unknown as HoplonEngine;
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/integration.test.ts'] },
          outcome: failingOutcome('tests/integration.test.ts'),
        },
      ],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner,
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/producer.ts'],
          snapshotRefId: 'sha256:aaa',
          attemptNumber: 1,
        },
      ],
      options: {},
    });

    expect(result.outcome).toBe('FAIL');
    expect(auditCalls).toBe(0);
  });
});
