/**
 * session/index.ts — public barrel for the Hoplon edit session contract.
 *
 * Re-exported additively from `@phalanx/hoplon` via src/index.ts.
 */

export { createHoplonEditSession } from './session.js';
export { createStagingAggregateBudget } from './stagingStore.js';
export type {
  SessionStagingOptions,
  StagingAggregateBudget,
} from './stagingStore.js';
export { SessionError } from './errors.js';
export type {
  SessionErrorDetails,
  SessionErrorKind,
  SessionErrorPayload,
  SessionErrorTransportDetails,
  SessionRecoveryClass,
} from './errors.js';
export type {
  HoplonEditSession,
  SessionState,
  SessionSnapshot,
  SessionTransition,
  CreateHoplonEditSessionOptions,
  DryRunResult,
  RepairContextOptions,
  ApplyEditsResult,
} from './types.js';
export type {
  RepairContext,
  FailedAttemptRef,
  NextAttemptPlan,
} from '../contracts/repairContext.js';
export { composeVerifyBehaviorResult } from './verifyBehavior.js';
export type { ComposeVerifyBehaviorInput } from './verifyBehavior.js';
export { composeRetryContextCompression } from './retryContextCompression.js';
export { composeParallelBatchBehaviorVerification } from './parallelBatchBehaviorVerification.js';
export type { ComposeParallelBatchBehaviorVerificationInput } from './parallelBatchBehaviorVerification.js';
export { composeSpeculativeEditSandbox } from './speculativeEditSandbox.js';
export type {
  ComposeSpeculativeEditSandboxInput,
  SpeculativeCandidateSandbox,
} from './speculativeEditSandbox.js';
export { createSessionRegistry } from './registry.js';
export type {
  SessionId,
  SessionRegistry,
  SessionRegistryOptions,
  RegisteredSessionEntry,
  RegisteredSessionInfo,
  StartSessionOptions,
} from './registry.js';
export { quickEdit } from './quickEdit.js';
export type {
  QuickEditOptions,
  QuickEditResult,
  QuickEditPassResult,
  QuickEditBlockResult,
  QuickEditPreflightBlockResult,
  QuickEditAuditBlockResult,
  QuickEditFailureResult,
  QuickEditPhase,
  QuickEditSessionTrace,
} from './quickEdit.js';
export { composeSnapshotEvidence } from './snapshotEvidence.js';
export type {
  ComposeSnapshotEvidenceInput,
  SnapshotEvidenceDiffFileEntry,
  SnapshotEvidenceDiffRequest,
  SnapshotEvidenceDiffResult,
  SnapshotEvidenceKind,
  SnapshotEvidenceProvenanceRequest,
  SnapshotEvidenceProvenanceResult,
  SnapshotEvidenceRequest,
  SnapshotEvidenceResult,
} from './snapshotEvidenceTypes.js';
export { readApplyEditsRollbackConflicts } from './applyEditsRollback.js';
export type { ApplyEditsRollbackConflict } from './applyEditsRollback.js';
