import { describe, expect, it } from 'vitest';

import type { VerifyBehaviorResult } from '../../src/hoplon/contracts/verifyBehavior.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import { RepairContextSchema } from '../../src/hoplon/contracts/repairContext.js';
import { packageRepairContext } from '../../src/hoplon/session/repairContext.js';
import {
  BLOCK_AUDIT,
  PASS_AUDIT,
  ROLLBACK_TEMPLATE,
  SNAPSHOT_REF_ID,
} from '../session/helpers.ts';

function makeRepairContext() {
  return {
    repairContextSchemaVersion: 1 as const,
    correlationId: 'corr-session-1',
    projectId: 'proj-session',
    runId: 'run-session-1',
    failedAttempt: {
      sessionId: 'hoplon-session-prev',
      attemptNumber: 1,
      snapshotRef: SNAPSHOT_REF_ID,
      failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      executionId: null,
      attemptId: null,
      auditRef: null,
    },
    auditResult: BLOCK_AUDIT,
    rollbackTemplate: ROLLBACK_TEMPLATE,
    priorSessionHistory: [
      { op: 'created', fromState: 'created', toState: 'created', timestampMs: 1 },
      { op: 'audit', fromState: 'edited', toState: 'audited_block', timestampMs: 2 },
    ],
    nextAttempt: {
      attemptNumber: 2,
      baselineSnapshotRef: SNAPSHOT_REF_ID,
    },
    generatedAt: '2026-04-20T12:00:00.000Z',
  };
}

function makeFailedVerification(): VerifyBehaviorResult {
  return {
    version: 1,
    advisory: true,
    status: 'AVAILABLE',
    outcome: 'FAIL',
    unavailabilityReason: null,
    selection: {
      strategy: 'oracle',
      testsExecuted: ['tests/foo.test.ts'],
      oracleResult: {
        relevantTests: ['tests/foo.test.ts'],
        coverageConfidence: 'exact',
        unusedModifiedFiles: [],
      },
      coverageConfidence: 'exact',
      modifiedFilesSource: 'session_changed_files',
    },
    linkage: {
      sessionId: 'hoplon-session-prev',
      snapshotRefId: SNAPSHOT_REF_ID,
      changedFiles: ['src/foo.ts'],
      attemptNumber: 1,
    },
    execution: {
      runnerId: 'host-vitest',
      startedAt: '2026-04-20T12:00:01.000Z',
      completedAt: '2026-04-20T12:00:02.000Z',
      durationMs: 1_000,
      exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
      timeoutMs: null,
      workingDirectory: '/ws',
    },
    evidence: {
      failingTests: [
        {
          testId: 'tests/foo.test.ts > foo > preserves contract',
          name: 'preserves contract',
          file: 'tests/foo.test.ts',
          failureMessage: 'raw behavior failure not copied',
          stack: 'raw stack not copied',
          durationMs: 10,
          assertions: null,
        },
      ],
      passingTestCount: 0,
      skippedTestCount: 0,
      stdout: 'raw stdout not copied',
      stderr: null,
      structured: null,
      truncated: false,
    },
    correlationId: 'corr-session-1',
    generatedAt: '2026-04-20T12:00:03.000Z',
    notes: ['selection_oracle'],
  };
}

function makeOutOfScopeSymbolAudit(): AuditResult {
  return {
    status: 'BLOCK',
    correlationId: 'corr-session-1',
    auditSchemaVersion: 1,
    violations: [
      {
        kind: 'out_of_scope_symbol',
        path: 'src/foo.ts',
        symbolName: 'leaked',
        nodeKind: 'function_declaration',
        byteRange: [10, 42],
        sourceSlice: 'function leaked() { return 1; }',
        truncated: false,
        message: 'out of scope symbol mutation',
        correction: 'Revert this symbol.',
      },
    ],
  };
}

describe('RepairContextSchema', () => {
  it('accepts a BLOCK repair context whose next attempt matches the failed attempt', () => {
    const parsed = RepairContextSchema.safeParse(makeRepairContext());
    expect(parsed.success).toBe(true);
  });

  it('rejects repair contexts whose auditResult is PASS', () => {
    const parsed = RepairContextSchema.safeParse({
      ...makeRepairContext(),
      auditResult: PASS_AUDIT,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path.join('.') === 'auditResult.status')).toBe(
      true,
    );
  });

  it('rejects inconsistent next-attempt bookkeeping', () => {
    const parsed = RepairContextSchema.safeParse({
      ...makeRepairContext(),
      nextAttempt: {
        attemptNumber: 7,
        baselineSnapshotRef: 'sha256:wrong',
      },
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some((issue) => issue.path.join('.') === 'nextAttempt.attemptNumber'),
    ).toBe(true);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.path.join('.') === 'nextAttempt.baselineSnapshotRef',
      ),
    ).toBe(true);
  });

  it('accepts a repair context carrying failed behavior semantic-gap metadata', () => {
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
      priorSessionHistory: [
        {
          op: 'audit',
          fromState: 'edited',
          toState: 'audited_block',
          timestampMs: 2,
        },
      ],
      generatedAtIso: '2026-04-20T12:00:00.000Z',
      executionId: null,
      attemptId: null,
      auditRef: null,
      behaviorVerification: makeFailedVerification(),
    });

    const parsed = RepairContextSchema.safeParse(repair);
    expect(parsed.success).toBe(true);
    expect(repair.verificationSemanticGap?.payload.behavior.outcome).toBe(
      'FAIL',
    );
    expect(repair.verificationSemanticGap?.payload.relevantTests).toMatchObject({
      testsExecuted: ['tests/foo.test.ts'],
      oracleRelevantTests: ['tests/foo.test.ts'],
    });
    expect(
      repair.verificationSemanticGap?.payload.failingTests[0],
    ).not.toHaveProperty('failureMessage');
    expect(repair.verificationSemanticGap?.authority.canMutateFiles).toBe(false);
  });

  it('packages focused retry compression without copying raw runner logs', () => {
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
      priorSessionHistory: [
        {
          op: 'audit',
          fromState: 'edited',
          toState: 'audited_block',
          timestampMs: 2,
        },
      ],
      generatedAtIso: '2026-04-20T12:00:00.000Z',
      executionId: null,
      attemptId: null,
      auditRef: null,
      behaviorVerification: makeFailedVerification(),
      includeRetryContextCompression: true,
    });

    expect(RepairContextSchema.safeParse(repair).success).toBe(true);
    expect(repair.retryContextCompression?.decisiveEvidence).toMatchObject({
      primaryFailurePreserved: true,
      runnerStatusPreserved: true,
      rawLogPointerPreserved: true,
    });
    expect(repair.retryContextCompression?.runnerStatus).toMatchObject({
      status: 'AVAILABLE',
      outcome: 'FAIL',
      exitKind: 'exit_code',
    });
    expect(repair.retryContextCompression?.rawLogPointer).toMatchObject({
      kind: 'verify_behavior_evidence',
      evidenceFields: ['stdout'],
    });
    expect(JSON.stringify(repair.retryContextCompression)).not.toContain(
      'raw stdout not copied',
    );
    expect(JSON.stringify(repair.retryContextCompression)).not.toContain(
      'raw stack not copied',
    );
  });

  it('preserves AST-node provenance when audit evidence carries a node range', () => {
    const repair = packageRepairContext({
      sessionId: 'hoplon-session-prev',
      attemptNumber: 1,
      snapshotRef: SNAPSHOT_REF_ID,
      failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      correlationId: 'corr-session-1',
      projectId: 'proj-session',
      runId: 'run-session-1',
      auditResult: makeOutOfScopeSymbolAudit(),
      rollbackTemplate: ROLLBACK_TEMPLATE,
      priorSessionHistory: [],
      generatedAtIso: '2026-04-20T12:00:00.000Z',
      executionId: null,
      attemptId: null,
      auditRef: null,
      behaviorVerification: makeFailedVerification(),
      includeRetryContextCompression: true,
    });

    expect(repair.retryContextCompression?.status).toBe('AVAILABLE');
    expect(repair.retryContextCompression?.degradedReasons).toEqual([]);
    expect(repair.retryContextCompression?.focusedDiagnostics[0]?.nodeProvenance).toMatchObject({
      file: 'src/foo.ts',
      symbolPath: ['leaked'],
      nodeKind: 'function_declaration',
      byteRange: [10, 42],
      provenanceKind: 'tree_sitter_ast_node',
    });
    expect(
      repair.retryContextCompression?.decisiveEvidence.editedNodeProvenancePreserved,
    ).toBe(true);
  });

  it('marks retry compression degraded when behavior evidence is absent', () => {
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
      includeRetryContextCompression: true,
    });

    expect(repair.retryContextCompression?.status).toBe('DEGRADED');
    expect(repair.retryContextCompression?.degradedReasons).toContain(
      'no_behavior_verification',
    );
    expect(repair.retryContextCompression?.rawLogPointer).toEqual({
      kind: 'not_provided',
      reason: 'behavior_verification_not_supplied',
    });
  });

  it('packages advisory repair suggestions from blocking audit violations', () => {
    const repair = packageRepairContext({
      sessionId: 'hoplon-session-prev',
      attemptNumber: 1,
      snapshotRef: SNAPSHOT_REF_ID,
      failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      correlationId: 'corr-session-1',
      projectId: 'proj-session',
      runId: 'run-session-1',
      auditResult: makeOutOfScopeSymbolAudit(),
      rollbackTemplate: ROLLBACK_TEMPLATE,
      priorSessionHistory: [],
      generatedAtIso: '2026-04-20T12:00:00.000Z',
      executionId: null,
      attemptId: null,
      auditRef: null,
    });

    expect(repair.repairSuggestions?.[0]).toMatchObject({
      advisoryOnly: true,
      requiresConfirmation: true,
      action: 'retry_with_correction',
      path: 'src/foo.ts',
      correctionAvailable: true,
    });
  });
});
