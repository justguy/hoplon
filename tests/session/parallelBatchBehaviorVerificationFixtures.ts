import type {
  BehaviorTestRunOutcome,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

export function fakeEngineWithOracle(result: TestOracleResult): HoplonEngine {
  return {
    getRelevantTests: async () => result,
  } as unknown as HoplonEngine;
}

export const BASE = {
  projectId: 'proj-t091',
  runId: 'run-1',
  correlationId: 'corr-batch-1',
  projectRoot: '/ws',
  now: () => 1_737_999_000_000,
} as const;

export function passOutcome(testFiles: readonly string[]): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-pass',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:01Z',
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

export function failingOutcome(failingFile: string): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-fail',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:02Z',
    durationMs: 2_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
    failingTests: [
      {
        testId: `${failingFile} > integration > respects shared interface`,
        name: 'respects shared interface',
        file: failingFile,
        failureMessage: 'AssertionError: producer/consumer drift',
        stack: `Error: ...\n    at ${failingFile}:7:3`,
        durationMs: 7,
        assertions: [{ expected: 'consumed', actual: 'TypeError' }],
      },
    ],
    passingTestCount: 1,
    skippedTestCount: 0,
    stdout: `RUN\nFAIL ${failingFile}\n`,
    stderr: null,
    structured: { total: 2, failed: 1 },
    truncated: false,
  };
}

export function failingWithoutStructuredFailuresOutcome(): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-compiler-fail',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:02Z',
    durationMs: 2_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 2, signal: null, reason: null },
    failingTests: [],
    passingTestCount: 0,
    skippedTestCount: 0,
    stdout: 'tsc --noEmit',
    stderr: 'src/consumer.ts(7,3): error TS2322',
    structured: null,
    truncated: false,
  };
}

export function unattributedFailingOutcome(): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-fail-unattr',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:02Z',
    durationMs: 2_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
    failingTests: [
      {
        testId: 'global setup > before all',
        name: 'before all',
        file: null,
        failureMessage: 'beforeAll hook threw',
        stack: 'Error: beforeAll',
        durationMs: 1,
        assertions: null,
      },
    ],
    passingTestCount: 0,
    skippedTestCount: 0,
    stdout: 'FAIL global setup',
    stderr: null,
    structured: null,
    truncated: false,
  };
}
