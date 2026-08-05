import type { CloseoutProofBundle } from '../contracts/closeoutProofBundle.js';
import type { SessionReviewPayload } from '../contracts/reviewPayload.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';
import type { ProofVerbosity } from '../contracts/proofVerbosity.js';
import type { SessionSnapshot } from './types.js';

export function composeCloseoutProofBundle(input: {
  snapshot: SessionSnapshot;
  generatedAtIso: string;
  proofVerbosity?: ProofVerbosity;
  review?: SessionReviewPayload;
  behaviorVerification?: VerifyBehaviorResult;
}): CloseoutProofBundle {
  const auditResult = input.snapshot.lastAuditResult;
  const violationCount = auditResult?.status === 'BLOCK'
    ? auditResult.violations.length
    : 0;
  return {
    closeoutProofBundleSchemaVersion: 1,
    sessionId: input.snapshot.sessionId,
    projectId: input.snapshot.projectId,
    runId: input.snapshot.runId,
    correlationId: input.snapshot.correlationId,
    state: input.snapshot.state,
    generatedAt: input.generatedAtIso,
    proofVerbosity: input.proofVerbosity ?? 'normal',
    snapshotRefId: input.snapshot.snapshotRef?.id ?? null,
    changedFiles: [...input.snapshot.changedFiles],
    historyLength: input.snapshot.history.length,
    proofRefs: {
      auditRef: auditResult?.auditRef ?? null,
      snapshotRef: input.snapshot.snapshotRef?.id ?? null,
      rollbackSnapshotRef: input.snapshot.lastRollbackTemplate?.snapshotRef ?? null,
    },
    results: {
      preflightStatus: input.snapshot.lastPreflightResult?.status ?? null,
      auditStatus: auditResult?.status ?? null,
      violationCount,
      revertAvailable: input.snapshot.lastRevertResult !== null,
      rollbackTemplateAvailable: input.snapshot.lastRollbackTemplate !== null,
      behaviorVerificationOutcome:
        input.behaviorVerification?.outcome ?? null,
    },
    ...(input.review !== undefined ? { review: input.review } : {}),
    ...(input.behaviorVerification !== undefined
      ? { behaviorVerification: input.behaviorVerification }
      : {}),
    notes: [
      'Closeout bundle summarizes existing session proof; it does not certify behavior beyond attached evidence.',
    ],
  };
}
