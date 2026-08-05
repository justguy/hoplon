/** Public supervised edit-session interface. */

import type { PreflightResult } from '../contracts/preflight.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import type { AuditResult } from '../contracts/audit.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { RepairContext } from '../contracts/repairContext.js';
import type { ProposedChange } from '../contracts/requests.js';
import type { DeclarativeInvariantBinding } from '../contracts/invariantBinding.js';
import type { GetReviewPayloadOptions, SessionReviewPayload } from '../contracts/reviewPayload.js';
import type { VerifyBehaviorOptions, VerifyBehaviorResult } from '../contracts/verifyBehavior.js';
import type { CloseoutProofBundle } from '../contracts/closeoutProofBundle.js';
import type { ProofVerbosity } from '../contracts/proofVerbosity.js';
import type { SnapshotEvidenceRequest, SnapshotEvidenceResult } from './snapshotEvidenceTypes.js';
import type {
  ApplyEditsResult,
  DryRunResult,
  MarkEditedResult,
  RepairContextOptions,
  SessionSnapshot,
  SessionState,
  StageContentInput,
  StageContentResult,
} from './sessionStateTypes.js';

/**
 * The public session API. Every state-advancing method is async; `state`
 * and `history` are pure readers into the observable snapshot.
 */
export interface HoplonEditSession {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly snapshot: SessionSnapshot;

  preflight(): Promise<PreflightResult>;
  createSnapshot(): Promise<SnapshotRef>;
  dryRun(
    proposedChanges: readonly ProposedChange[],
    opts?: { invariantBindings?: readonly DeclarativeInvariantBinding[] },
  ): Promise<DryRunResult>;
  /**
   * Supervised Hoplon-applied write step (t-063). Writes each proposed
   * change through the injected `HoplonFsAdapter`, derives the changed-file
   * list from the bytes actually written, and advances state to `edited`.
   * Legal only from `snapshotted`. Requires an `fs` adapter to have been
   * supplied at construction; otherwise throws SessionError with kind
   * `missing_prerequisite`.
   */
  applyEdits(proposedChanges: readonly ProposedChange[]): Promise<ApplyEditsResult>;
  /**
   * Append one chunk to a session-scoped staging entry (t-076). Does not
   * advance session state and never touches the filesystem; the staged
   * entry is an in-memory byte buffer the supervised `applyEdits` path
   * later consumes when a `ProposedChange` references it via
   * `stagedContent`. Integrity/size failures throw typed `SessionError`
   * instances with `recoveryClass: refresh_and_recompute`.
   *
   * This is NOT a second agent-facing write mechanism — bytes only land
   * on disk when `applyEdits` runs against a session whose `stagedContent`
   * refs have been resolved. Staged entries are discarded on `close`.
   */
  stageContent(input: StageContentInput): StageContentResult;
  /**
   * Host-owned compatibility write-declaration step. Declares the paths
   * the host already wrote; Hoplon never touches the filesystem in this
   * branch. Preserved for environments where Hoplon is not the writer
   * (e.g. IDE-owned editors, out-of-process hooks, missing fs injection).
   */
  markEdited(changedFiles: readonly string[]): Promise<MarkEditedResult>;
  audit(): Promise<AuditResult>;
  revert(): Promise<RevertResult>;
  extractRollbackTemplate(opts?: {
    files?: readonly string[];
    contractedChangesMap?: Readonly<Record<string, string>>;
  }): Promise<RollbackTemplate>;
  /**
   * Package the failed-audit state into a reusable host-facing RepairContext
   * (t-070). Legal only after audit() returned BLOCK AND
   * extractRollbackTemplate() has run on this session — the packaged
   * context is pointer-first over the authoritative AuditResult +
   * RollbackTemplate + ordered session history, not a re-summary.
   *
   * When the caller passes `{ includeDependencyImpact: true }` the packaged
   * context additionally carries an advisory `dependencyImpact` sidecar
   * (t-077) composed over the manifest's declared scope plus the failed
   * audit's violations. The sidecar is strictly advisory — it never alters
   * PASS/BLOCK, never widens retry policy, and falls back to an explicit
   * `UNAVAILABLE` / `DEGRADED` status whenever the `analyzeBlastRadius`
   * provider is absent or returns degraded evidence.
   *
   * This method does not automate a retry, compose a prompt, or bind an
   * LLM. Retry policy, prompt composition, and escalation ownership stay
   * with the host. The returned DTO may also be fed into a fresh retry
   * session via `createHoplonEditSession({ priorRepairContext, … })` to
   * carry attempt bookkeeping forward.
   */
  getRepairContext(opts?: RepairContextOptions): Promise<RepairContext>;
  /**
   * Package a focused review payload (t-072) over the session's already
   * shipped apply/audit facts. Phase defaults to `'post-edit'` and resolves
   * each touched file to the nearest logical boundary for a bounded unified
   * diff; `'preview'` materializes `proposedChanges` in memory before
   * composing the same DTO. Advisory only — never advances state, never
   * couples to audit PASS/BLOCK, never introduces a second review model.
   */
  getReviewPayload(
    opts?: GetReviewPayloadOptions,
  ): Promise<SessionReviewPayload>;
  /**
   * Package a host-facing behavior verification result (t-067) over the
   * session's `changedFiles`. Default test selection runs through the
   * shipped `getRelevantTests` static oracle; callers may override with
   * an explicit test list or opt into a full-suite fallback when the
   * oracle returns conservative coverage. Test execution happens on the
   * host-injected `BehaviorTestRunnerAdapter` — Hoplon's deterministic
   * kernel never spawns tests. Advisory only: never advances state,
   * never couples to PASS/BLOCK, never blocks by default. When no
   * runner is wired the method returns
   * `status: 'UNAVAILABLE', outcome: 'NOT_RUN', unavailabilityReason: 'no_runner'`
   * instead of fabricating a pass.
   */
  verifyBehavior(
    opts?: VerifyBehaviorOptions,
  ): Promise<VerifyBehaviorResult>;
  getCloseoutProofBundle(opts?: {
    includeReview?: boolean;
    includeBehaviorVerification?: boolean;
    proofVerbosity?: ProofVerbosity;
  }): Promise<CloseoutProofBundle>;
  /**
   * Package a narrow snapshot-scoped Git evidence result (t-081) anchored
   * on this session's own `snapshotRef`. Supported v1 kinds:
   *
   *   - `kind: 'diff'` — bounded unified-diff evidence between the
   *     session's snapshot and either the live tree (`to: 'live'`) or
   *     another committed snapshot of the same `projectId` + `runId`.
   *     Scope is narrowed to files owned by the from-snapshot's manifest;
   *     the optional `files` filter narrows it further but may never
   *     introduce foreign paths.
	   *   - `kind: 'provenance'` — content-free metadata for the session's
	   *     snapshot: createdAt, projectId, runId, correlationId, engineId,
	   *     manifestSchemaVersion, status, ttlExpires, plus narrow commit
	   *     metadata (tree oid, parent oids, committer/author timestamps,
	   *     and the first line of the commit message).
	   *   - `kind: 'line_provenance'` — bounded investigation metadata for
	   *     one manifest-owned file and one explicit line range or syntax-node
	   *     line range, returning the commit that introduced or last changed
	   *     that range at the session snapshot.
   *
   * Legal only after `createSnapshot()` has captured the session's
   * snapshotRef. Requires the session to have been constructed with
   * `versioning` + `snapshotStore` + `gitRepoDir`; otherwise throws
   * `SessionError({ kind: 'missing_prerequisite' })`. Never advances
   * state. Never reads out-of-scope refs — the underlying adapter
   * primitives refuse anything that isn't a bare 40-char hex commit SHA.
   * Does not touch `versioning.push` / `versioning.fetch`.
   */
  getSnapshotEvidence(
    request: SnapshotEvidenceRequest,
  ): Promise<SnapshotEvidenceResult>;
  close(): void;
}
