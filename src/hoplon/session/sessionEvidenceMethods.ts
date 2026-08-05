import type { CloseoutProofBundle } from '../contracts/closeoutProofBundle.js';
import type { ProofVerbosity } from '../contracts/proofVerbosity.js';
import { composeCloseoutProofBundle } from './closeoutProofBundle.js';
import { SessionError } from './errors.js';
import { getReviewPayload } from './sessionReviewMethods.js';
import {
  buildRuntimeSnapshot,
} from './sessionRuntime.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { composeSnapshotEvidence } from './snapshotEvidence.js';
import type {
  SnapshotEvidenceRequest,
  SnapshotEvidenceResult,
} from './snapshotEvidenceTypes.js';

export async function getSnapshotEvidence(
  runtime: SessionRuntime,
  request: SnapshotEvidenceRequest,
): Promise<SnapshotEvidenceResult> {
  if (
    runtime.state === 'created' ||
    runtime.state === 'preflighted_pass' ||
    runtime.state === 'preflighted_block'
  ) {
    throw new SessionError({
      kind: 'invalid_state_transition',
      from: runtime.state,
      attempted: 'getSnapshotEvidence',
      detail:
        'getSnapshotEvidence is legal only after createSnapshot (states: snapshotted, edited, audited_pass, audited_block, reverted, rollback_extracted, closed)',
      details: {
        recoveryClass: 'inspect_state',
        allowedStates: [
          'snapshotted',
          'edited',
          'audited_pass',
          'audited_block',
          'reverted',
          'rollback_extracted',
          'closed',
        ],
      },
    });
  }
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getSnapshotEvidence',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }
  if (!runtime.versioningAdapter) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getSnapshotEvidence',
      detail: 'versioning adapter not wired on the session',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'versioning',
      },
    });
  }
  if (!runtime.snapshotStoreAdapter) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getSnapshotEvidence',
      detail: 'snapshotStore not wired on the session',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotStore',
      },
    });
  }
  if (runtime.gitRepoDir === null) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getSnapshotEvidence',
      detail: 'gitRepoDir not wired on the session',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'gitRepoDir',
      },
    });
  }
  return composeSnapshotEvidence({
    versioning: runtime.versioningAdapter,
    snapshotStore: runtime.snapshotStoreAdapter,
    fs: runtime.fs,
    gitRepoDir: runtime.gitRepoDir,
    sessionId: runtime.sessionId,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
    engineId: snapshotRef.engineId,
    now: runtime.now,
    request,
    sessionSnapshotRefId: snapshotRef.id,
  });
}

export async function getCloseoutProofBundle(
  runtime: SessionRuntime,
  opts?: {
    includeReview?: boolean;
    includeBehaviorVerification?: boolean;
    proofVerbosity?: ProofVerbosity;
  },
): Promise<CloseoutProofBundle> {
  const review = opts?.includeReview === true
    ? await getReviewPayload(runtime, { includeRelevantTests: true })
    : undefined;
  const behaviorVerification =
    opts?.includeBehaviorVerification === true &&
    runtime.lastVerifyBehaviorResult !== null
      ? runtime.lastVerifyBehaviorResult
      : undefined;
  return composeCloseoutProofBundle({
    snapshot: buildRuntimeSnapshot(runtime),
    generatedAtIso: new Date(runtime.now()).toISOString(),
    ...(opts?.proofVerbosity !== undefined
      ? { proofVerbosity: opts.proofVerbosity }
      : {}),
    ...(review !== undefined ? { review } : {}),
    ...(behaviorVerification !== undefined
      ? { behaviorVerification }
      : {}),
  });
}
