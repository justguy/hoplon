import type {
  ApplyEditsChangeKindCounts,
  StageContentResult,
} from './types.js';
import type { SessionRegistry } from './registry.js';
import type {
  InspectSessionResponse,
  ListSessionsResponse,
  QuickEditResultData,
  SessionResponse,
  SessionSnapshotEvidenceResult,
} from './transportContracts.js';
import type { SessionReviewPayload } from '../contracts/reviewPayload.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';

export interface SessionTransportDispatcher {
  start(rawBody: unknown): Promise<SessionResponse<{ engineId: string }>>;
  preflight(rawBody: unknown): Promise<SessionResponse<{ result: unknown }>>;
  createSnapshot(rawBody: unknown): Promise<SessionResponse<{ snapshotRef: unknown }>>;
  dryRun(rawBody: unknown): Promise<SessionResponse<{ result: unknown }>>;
  applyEdits(
    rawBody: unknown,
  ): Promise<
    SessionResponse<{
      changedFiles: readonly string[];
      bytesWritten: number;
      changeKindCounts: ApplyEditsChangeKindCounts;
      overlayRefresh?: unknown;
    }>
  >;
  /**
   * t-076 — append one chunk to a session-scoped staging entry. Does not
   * advance session state; integrity/size failures throw typed
   * `SessionError` and leave no disk residue.
   */
  stageContent(rawBody: unknown): Promise<SessionResponse<StageContentResult>>;
  markEdited(rawBody: unknown): Promise<SessionResponse<{
    changedFiles: readonly string[];
    overlayRefresh: unknown;
  }>>;
  audit(rawBody: unknown): Promise<SessionResponse<{ result: unknown }>>;
  revert(rawBody: unknown): Promise<SessionResponse<{ result: unknown }>>;
  extractRollbackTemplate(
    rawBody: unknown,
  ): Promise<SessionResponse<{ template: unknown }>>;
  /**
   * Package a reusable RepairContext (t-070) from the session's
   * `audited_block` / `reverted` / `rollback_extracted` state. The
   * dispatcher adds transport envelope semantics only; every field on the
   * DTO comes straight from the session's own `getRepairContext()`.
   */
  getRepairContext(
    rawBody: unknown,
  ): Promise<SessionResponse<{ repairContext: unknown }>>;
  getCloseoutProofBundle(
    rawBody: unknown,
  ): Promise<SessionResponse<{ closeoutProofBundle: unknown }>>;
  /**
   * t-072 — package a focused review payload for the session's current state.
   * Transport-only; every field in the returned DTO comes straight from the
   * session's `getReviewPayload` method over already-shipped apply/audit
   * facts.
   */
  getReviewPayload(
    rawBody: unknown,
  ): Promise<SessionResponse<{ review: SessionReviewPayload }>>;
  /**
   * t-067 — package a host-facing behavior verification result. Transport-
   * only; the dispatcher forwards every field in the returned DTO from the
   * session's own `verifyBehavior` call, which composes `getRelevantTests`
   * (static oracle) with the host-injected `BehaviorTestRunnerAdapter`.
   * Test execution stays host-owned; no engine-side sandbox is invoked.
   */
  verifyBehavior(
    rawBody: unknown,
  ): Promise<SessionResponse<{ verification: VerifyBehaviorResult }>>;
  inspect(rawBody: unknown): Promise<InspectSessionResponse>;
  close(rawBody: unknown): Promise<SessionResponse<{ closed: true }>>;
  list(): ListSessionsResponse;
  /**
   * t-079 — single-shot quick-edit entry point. Constructs a fresh session
   * against the registry's shared engine + adapter seams, runs the full
   * supervised ordered loop, and closes the session before returning. The
   * response envelope is a flat `QuickEditResultData` (discriminated-union
   * on `outcome` / `phase`) rather than the registry-backed
   * `SessionResponse<T>` wrapper because the wrapper does not leave a
   * live session in the registry.
   */
  quickEdit(rawBody: unknown): Promise<QuickEditResultData>;
  targetFirstScopedEdit(rawBody: unknown): Promise<SessionResponse<{
    result: unknown;
  }>>;
  /**
   * t-081 — snapshot-scoped Git evidence entry point. Forwards to the
   * session's `getSnapshotEvidence(...)` method; the result is wrapped in
   * the usual `SessionResponse<T>` envelope so the caller can still see
   * the session's current state + history length. Every reachable kind is
   * snapshot-anchored: the wire contract refuses any ref that is not a
   * committed `snapshotRefId` (or the literal `'live'` sentinel for the
   * diff target).
   */
  getSnapshotEvidence(
    rawBody: unknown,
  ): Promise<SessionResponse<{ evidence: SessionSnapshotEvidenceResult }>>;
}

export interface SessionTransportDispatcherOptions {
  registry: SessionRegistry;
}
