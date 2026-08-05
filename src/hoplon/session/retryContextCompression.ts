import { createHash } from 'node:crypto';

import type { AuditResult, AuditViolation } from '../contracts/audit.js';
import type {
  RetryContextCompression,
  RetryContextCompressionDegradedReason,
  RetryContextFocusedDiagnostic,
  RetryContextPrimaryFailure,
  RetryContextRawLogPointer,
} from '../contracts/retryContextCompression.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';

export function composeRetryContextCompression(input: {
  readonly auditResult: AuditResult;
  readonly behaviorVerification?: VerifyBehaviorResult | undefined;
}): RetryContextCompression {
  const primaryFailure = derivePrimaryFailure(input.auditResult, input.behaviorVerification);
  const focusedDiagnostics = [
    ...deriveAuditDiagnostics(input.auditResult),
    ...deriveBehaviorDiagnostics(input.behaviorVerification),
  ];
  const rawLogPointer = deriveRawLogPointer(input.behaviorVerification);
  const runnerStatus = input.behaviorVerification
    ? {
        status: input.behaviorVerification.status,
        outcome: input.behaviorVerification.outcome,
        exitKind: input.behaviorVerification.execution.exitStatus.kind,
      }
    : { status: null, outcome: null, exitKind: null };
  const degradedReasons = deriveDegradedReasons({
    focusedDiagnostics,
    behaviorVerification: input.behaviorVerification,
    rawLogPointer,
  });

  return {
    version: 1,
    status: degradedReasons.length === 0 ? 'AVAILABLE' : 'DEGRADED',
    degradedReasons,
    primaryFailure,
    focusedDiagnostics,
    runnerStatus,
    rawLogPointer,
    decisiveEvidence: {
      primaryFailurePreserved: true,
      runnerStatusPreserved: input.behaviorVerification !== undefined,
      editedNodeProvenancePreserved: focusedDiagnostics.some(
        (diagnostic) => diagnostic.nodeProvenance !== null,
      ),
      rawLogPointerPreserved: rawLogPointer.kind !== 'not_provided',
    },
  };
}

function derivePrimaryFailure(
  auditResult: AuditResult,
  behaviorVerification: VerifyBehaviorResult | undefined,
): RetryContextPrimaryFailure {
  if (auditResult.status === 'BLOCK') {
    const first = auditResult.violations[0]!;
    return {
      source: 'audit',
      kind: first.kind,
      path: first.path,
      message: first.message,
      correction: first.correction,
    };
  }
  const failingTest = behaviorVerification?.evidence.failingTests[0];
  if (failingTest) {
    return {
      source: 'behavior',
      kind: 'failing_test',
      path: failingTest.file,
      message: failingTest.failureMessage,
      correction: null,
    };
  }
  return {
    source: 'audit',
    kind: 'no_audit_violation',
    path: null,
    message: 'No BLOCK audit violation was supplied for retry compression.',
    correction: null,
  };
}

function deriveAuditDiagnostics(auditResult: AuditResult): RetryContextFocusedDiagnostic[] {
  if (auditResult.status !== 'BLOCK') return [];
  return auditResult.violations.map((violation) => ({
    source: 'audit',
    kind: violation.kind,
    path: violation.path,
    message: violation.message,
    nodeProvenance: nodeProvenanceFromViolation(violation),
  }));
}

function deriveBehaviorDiagnostics(
  verification: VerifyBehaviorResult | undefined,
): RetryContextFocusedDiagnostic[] {
  if (verification === undefined || verification.outcome !== 'FAIL') return [];
  return verification.evidence.failingTests.map((test) => ({
    source: 'behavior',
    kind: 'failing_test',
    path: test.file,
    message: test.failureMessage,
    nodeProvenance: null,
  }));
}

function nodeProvenanceFromViolation(violation: AuditViolation) {
  if (violation.kind !== 'out_of_scope_symbol') return null;
  if (violation.truncated === true) return null;
  return {
    file: violation.path,
    symbolPath: [violation.symbolName],
    nodeKind: violation.nodeKind,
    byteRange: violation.byteRange,
    sourceHash: `sha256:${createHash('sha256').update(violation.sourceSlice).digest('hex')}`,
    provenanceKind: 'tree_sitter_ast_node' as const,
  };
}

function deriveRawLogPointer(
  verification: VerifyBehaviorResult | undefined,
): RetryContextRawLogPointer {
  if (verification === undefined) {
    return {
      kind: 'not_provided',
      reason: 'behavior_verification_not_supplied',
    };
  }
  if (
    verification.outcome === 'NOT_RUN' &&
    verification.unavailabilityReason === 'selection_empty_conservative'
  ) {
    return {
      kind: 'selection_not_run_policy',
      reason: 'selection_empty_conservative',
      runnerId: verification.execution.runnerId,
      generatedAt: verification.generatedAt,
    };
  }
  const evidenceFields: Array<'stdout' | 'stderr' | 'structured'> = [];
  if (verification.evidence.stdout !== null) evidenceFields.push('stdout');
  if (verification.evidence.stderr !== null) evidenceFields.push('stderr');
  if (verification.evidence.structured !== null) evidenceFields.push('structured');
  return {
    kind: 'verify_behavior_evidence',
    runnerId: verification.execution.runnerId,
    generatedAt: verification.generatedAt,
    evidenceFields,
    truncated: verification.evidence.truncated,
  };
}

function deriveDegradedReasons(input: {
  readonly focusedDiagnostics: readonly RetryContextFocusedDiagnostic[];
  readonly behaviorVerification?: VerifyBehaviorResult | undefined;
  readonly rawLogPointer: RetryContextRawLogPointer;
}): RetryContextCompressionDegradedReason[] {
  const reasons = new Set<RetryContextCompressionDegradedReason>();
  if (!input.focusedDiagnostics.some((diagnostic) => diagnostic.nodeProvenance !== null)) {
    reasons.add('no_ast_node_provenance');
  }
  if (input.behaviorVerification === undefined) reasons.add('no_behavior_verification');
  if (input.rawLogPointer.kind === 'not_provided') {
    reasons.add('no_raw_log_pointer');
  }
  if (
    input.rawLogPointer.kind === 'verify_behavior_evidence' &&
    input.rawLogPointer.evidenceFields.length === 0
  ) {
    reasons.add('no_raw_log_pointer');
  }
  return [...reasons].sort();
}
