import { describe, expect, it } from 'vitest';

import {
  createNoopBehaviorTestRunner,
  createStubBehaviorTestRunner,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import { BatchBehaviorVerificationResultSchema } from '../../src/hoplon/contracts/parallelBatchBehaviorVerification.js';
import { composeParallelBatchBehaviorVerification } from '../../src/hoplon/session/parallelBatchBehaviorVerification.js';
import {
  BASE,
  failingOutcome,
  fakeEngineWithOracle,
  passOutcome,
} from './parallelBatchBehaviorVerificationFixtures.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';

describe('parallel batch behavior verification macro', () => {
  it('unions changedFiles, runs the relevant test, and mirrors PASS', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
    const runner = createStubBehaviorTestRunner({
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/integration.test.ts'] },
          outcome: passOutcome(['tests/integration.test.ts']),
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
          attemptNumber: null,
        },
        {
          sessionId: 'sess-B',
          changedFiles: ['src/consumer.ts'],
          snapshotRefId: 'sha256:bbb',
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(BatchBehaviorVerificationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('PASS');
    expect(result.verifyBehavior.outcome).toBe('PASS');
    expect(result.selection.unionedChangedFiles).toEqual([
      'src/consumer.ts',
      'src/producer.ts',
    ]);
    expect(result.selection.sessionIdsInOrder).toEqual(['sess-A', 'sess-B']);
    expect(result.selection.perFileContributingSessions).toEqual({
      'src/consumer.ts': ['sess-B'],
      'src/producer.ts': ['sess-A'],
    });
    expect(result.failureLinkage.entries).toEqual([]);
    expect(result.failureLinkage.unattributedFailureIds).toEqual([]);
    expect(result.advisory).toBe(true);
  });

  it('mirrors FAIL and links an attributed failing test to candidate sessions', async () => {
    const oracle: TestOracleResult = {
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    };
    const engine = fakeEngineWithOracle(oracle);
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
        {
          sessionId: 'sess-B',
          changedFiles: ['src/consumer.ts'],
          snapshotRefId: 'sha256:bbb',
          attemptNumber: 1,
        },
      ],
      options: {},
    });

    expect(BatchBehaviorVerificationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.verifyBehavior.outcome).toBe('FAIL');
    expect(result.verifyBehavior.evidence.failingTests[0]?.failureMessage).toBe(
      'AssertionError: producer/consumer drift',
    );
    expect(result.verifyBehavior.execution.exitStatus.code).toBe(1);
    expect(result.failureLinkage.entries).toEqual([
      {
        testFile: 'tests/integration.test.ts',
        candidateSessionIds: ['sess-A', 'sess-B'],
      },
    ]);
  });

  it('mirrors NOT_RUN/no_runner and never fabricates PASS', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner: null,
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/foo.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(BatchBehaviorVerificationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.verifyBehavior.unavailabilityReason).toBe('no_runner');
    expect(result.failureLinkage.entries).toEqual([]);
  });

  it('mirrors NOT_RUN/runner_unavailable for a noop runner', async () => {
    const engine = fakeEngineWithOracle({
      relevantTests: ['tests/integration.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });

    const result = await composeParallelBatchBehaviorVerification({
      ...BASE,
      engine,
      runner: createNoopBehaviorTestRunner(),
      sessions: [
        {
          sessionId: 'sess-A',
          changedFiles: ['src/foo.ts'],
          snapshotRefId: null,
          attemptNumber: null,
        },
      ],
      options: {},
    });

    expect(result.outcome).toBe('NOT_RUN');
    expect(result.verifyBehavior.outcome).toBe('NOT_RUN');
    expect(result.verifyBehavior.unavailabilityReason).toBe('runner_unavailable');
  });
});
