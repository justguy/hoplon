import { describe, expect, it } from 'vitest';

import type { VerifyBehaviorResult } from '../../src/hoplon/contracts/verifyBehavior.js';
import { RepairContextSchema } from '../../src/hoplon/contracts/repairContext.js';
import { packageRepairContext } from '../../src/hoplon/session/repairContext.js';
import {
  BLOCK_AUDIT,
  ROLLBACK_TEMPLATE,
  SNAPSHOT_REF_ID,
} from './helpers.js';

function makeConservativeNotRunVerification(): VerifyBehaviorResult {
  return {
    version: 1,
    advisory: true,
    status: 'UNAVAILABLE',
    outcome: 'NOT_RUN',
    unavailabilityReason: 'selection_empty_conservative',
    selection: {
      strategy: 'none',
      testsExecuted: [],
      oracleResult: {
        relevantTests: ['tests/config.test.ts'],
        coverageConfidence: 'conservative',
        unusedModifiedFiles: ['package.json'],
      },
      coverageConfidence: 'conservative',
      modifiedFilesSource: 'session_changed_files',
    },
    linkage: {
      sessionId: 'hoplon-session-prev',
      snapshotRefId: SNAPSHOT_REF_ID,
      changedFiles: ['package.json'],
      attemptNumber: 1,
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
        reason: 'oracle returned conservative coverage; caller did not opt into full-suite fallback',
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
    correlationId: 'corr-session-1',
    generatedAt: '2026-04-20T12:00:03.000Z',
    notes: ['selection_conservative'],
  };
}

describe('t-112 retry-context compression — conservative policy skip', () => {
  it('preserves conservative NOT_RUN as an intentional policy skip', () => {
    const repair = packageRepairContext({
      sessionId: 'hoplon-session-prev',
      attemptNumber: 1,
      snapshotRef: SNAPSHOT_REF_ID,
      failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      correlationId: 'corr-session-1',
      projectId: 'proj-session',
      runId: 'run-session-1',
      auditResult: BLOCK_AUDIT,
      rollbackTemplate: ROLLBACK_TEMPLATE,
      priorSessionHistory: [],
      generatedAtIso: '2026-04-20T12:00:00.000Z',
      executionId: null,
      attemptId: null,
      auditRef: null,
      behaviorVerification: makeConservativeNotRunVerification(),
      includeRetryContextCompression: true,
    });

    expect(RepairContextSchema.safeParse(repair).success).toBe(true);
    expect(repair.retryContextCompression?.runnerStatus).toEqual({
      status: 'UNAVAILABLE',
      outcome: 'NOT_RUN',
      exitKind: 'not_run',
    });
    expect(repair.retryContextCompression?.rawLogPointer).toEqual({
      kind: 'selection_not_run_policy',
      reason: 'selection_empty_conservative',
      runnerId: null,
      generatedAt: '2026-04-20T12:00:03.000Z',
    });
    expect(repair.retryContextCompression?.degradedReasons).not.toContain(
      'no_behavior_verification',
    );
    expect(repair.retryContextCompression?.degradedReasons).not.toContain(
      'no_raw_log_pointer',
    );
    expect(repair.retryContextCompression?.decisiveEvidence).toMatchObject({
      runnerStatusPreserved: true,
      rawLogPointerPreserved: true,
    });
  });
});
