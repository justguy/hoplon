import { describe, expect, it } from 'vitest';

import type { VerifyBehaviorResult } from '../../src/hoplon/contracts/verifyBehavior.js';
import {
  VerificationSemanticGapSidecarSchema,
  composeVerificationSemanticGapSidecar,
} from '../../src/hoplon/contracts/verificationIntelligence.js';

function makeVerification(
  overrides: Partial<VerifyBehaviorResult> = {},
): VerifyBehaviorResult {
  return {
    version: 1,
    advisory: true,
    status: 'AVAILABLE',
    outcome: 'FAIL',
    unavailabilityReason: null,
    selection: {
      strategy: 'oracle',
      testsExecuted: ['tests/math.test.ts'],
      oracleResult: {
        relevantTests: ['tests/math.test.ts'],
        coverageConfidence: 'exact',
        unusedModifiedFiles: ['src/untested.ts'],
      },
      coverageConfidence: 'exact',
      modifiedFilesSource: 'session_changed_files',
    },
    linkage: {
      sessionId: 'sess-1',
      snapshotRefId: 'sha256:abc',
      changedFiles: ['src/foo.ts', 'src/untested.ts'],
      attemptNumber: 2,
    },
    execution: {
      runnerId: 'stub',
      startedAt: '2026-04-21T00:00:00Z',
      completedAt: '2026-04-21T00:00:01Z',
      durationMs: 1_000,
      exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
      timeoutMs: null,
      workingDirectory: '/ws',
    },
    evidence: {
      failingTests: [
        {
          testId: 'tests/math.test.ts > add > handles zero',
          name: 'handles zero',
          file: null,
          failureMessage: 'expected raw message not copied',
          stack: 'raw stack not copied',
          durationMs: 12,
          assertions: [{ expected: 0, actual: 1 }],
        },
      ],
      passingTestCount: 3,
      skippedTestCount: 0,
      stdout: 'raw stdout not copied',
      stderr: 'raw stderr not copied',
      structured: { raw: true },
      truncated: false,
    },
    correlationId: 'corr-1',
    generatedAt: '2026-04-21T00:00:02Z',
    notes: ['selection_oracle'],
    ...overrides,
  };
}

describe('composeVerificationSemanticGapSidecar', () => {
  it('returns null unless the caller opts in', () => {
    expect(
      composeVerificationSemanticGapSidecar({
        verification: makeVerification(),
      }),
    ).toBeNull();
  });

  it('packages advisory semantic-gap metadata without raw runner output', () => {
    const sidecar = composeVerificationSemanticGapSidecar({
      verification: makeVerification(),
      includeSemanticGapIntelligence: true,
    });

    expect(sidecar).not.toBeNull();
    const parsed = VerificationSemanticGapSidecarSchema.safeParse(sidecar);
    expect(parsed.success).toBe(true);
    expect(sidecar?.advisory).toBe(true);
    expect(sidecar?.evidence.status).toBe('AVAILABLE');
    expect(sidecar?.evidence.representsGreenProof).toBe(false);
    expect(sidecar?.authority.canChangeDeterministicVerdict).toBe(false);
    expect(sidecar?.strictAgentAccess.exposesFilesystemTool).toBe(false);
    expect(sidecar?.payload.observations).toEqual(
      expect.arrayContaining([
        'behavior_failed',
        'changed_files_without_oracle_match',
        'failing_tests_without_file',
      ]),
    );
    expect(sidecar?.payload.mutatedSubjects).toEqual([
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
    expect(sidecar?.payload.failingTests[0]).toMatchObject({
      testId: 'tests/math.test.ts > add > handles zero',
      hasFailureMessage: true,
      hasStack: true,
      assertionCount: 1,
    });
    expect(sidecar?.payload.failingTests[0]).not.toHaveProperty(
      'failureMessage',
    );
    expect(sidecar?.payload).not.toHaveProperty('stdout');
    expect(sidecar?.payload).not.toHaveProperty('stderr');
  });

  it('marks missing oracle intelligence as degraded advisory metadata', () => {
    const sidecar = composeVerificationSemanticGapSidecar({
      verification: makeVerification({
        selection: {
          strategy: 'override',
          testsExecuted: ['tests/caller.test.ts'],
          oracleResult: null,
          coverageConfidence: 'override',
          modifiedFilesSource: 'session_changed_files',
        },
        notes: ['selection_override'],
      }),
      includeSemanticGapIntelligence: true,
    });

    expect(sidecar?.provider.status).toBe('degraded');
    expect(sidecar?.provider.reason).toBe('oracle_unavailable');
    expect(sidecar?.evidence.status).toBe('DEGRADED');
    expect(sidecar?.payload.observations).toEqual(
      expect.arrayContaining(['oracle_unavailable', 'selection_override']),
    );
  });

  it('marks behavior NOT_RUN as no-verdict advisory evidence', () => {
    const sidecar = composeVerificationSemanticGapSidecar({
      verification: makeVerification({
        status: 'UNAVAILABLE',
        outcome: 'NOT_RUN',
        unavailabilityReason: 'no_runner',
        selection: {
          strategy: 'none',
          testsExecuted: [],
          oracleResult: null,
          coverageConfidence: 'not_applicable',
          modifiedFilesSource: 'none',
        },
        execution: {
          runnerId: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          exitStatus: {
            kind: 'not_run',
            code: null,
            signal: null,
            reason: 'no_runner',
          },
          timeoutMs: null,
          workingDirectory: null,
        },
        evidence: {
          failingTests: [],
          passingTestCount: 0,
          skippedTestCount: 0,
          stdout: null,
          stderr: null,
          structured: null,
          truncated: false,
        },
      }),
      includeSemanticGapIntelligence: true,
    });

    expect(sidecar?.evidence.status).toBe('NO_VERDICT');
    expect(sidecar?.evidence.reason).toBe('no_runner');
    expect(sidecar?.evidence.deterministicVerdict).toBeNull();
  });
});
