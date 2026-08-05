/** Core state and result types for the supervised edit session. */

import type { WritableManifest } from '../contracts/manifest.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import type { AuditResult } from '../contracts/audit.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { RepairContext } from '../contracts/repairContext.js';
import type { DryRunResult as EngineDryRunResult } from '../contracts/invariantBinding.js';
import type { DependencyImpactOptions } from '../contracts/dependencyImpact.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';
import type { SemanticOverlayRefreshResult } from '../contracts/semanticSearch.js';

/**
 * `engine.dryRun()` reuses the AuditResult discriminated union — the
 * underlying mathematical core is identical to auditDiff, only its inputs
 * differ (proposedChanges vs files on disk). The session re-exports this
 * alias purely for readability of the session API surface.
 */
export type DryRunResult = EngineDryRunResult;

export type RepairContextOptions = DependencyImpactOptions & {
  readonly behaviorVerification?: VerifyBehaviorResult;
  readonly includeRetryContextCompression?: boolean;
};

/**
 * The session's primary state. `dryRun` does NOT advance state; it is an
 * optional read-only call legal only while `snapshotted`. Every other
 * method advances the state exactly once.
 */
export type SessionState =
  | 'created'
  | 'preflighted_pass'
  | 'preflighted_block'
  | 'snapshotted'
  | 'edited'
  | 'audited_pass'
  | 'audited_block'
  | 'reverted'
  | 'rollback_extracted'
  | 'closed';

/**
 * An append-only transition record. The history is the durable provenance
 * of the session; downstream slices (t-048 allowed-edit proof, t-049
 * violating-edit proof) consume it to drive retry context without
 * re-running engine operations.
 */
export interface SessionTransition {
  op:
    | 'created'
    | 'preflight'
    | 'createSnapshot'
    | 'dryRun'
    | 'applyEdits'
    | 'markEdited'
    | 'audit'
    | 'revert'
    | 'extractRollbackTemplate'
    | 'close';
  fromState: SessionState;
  toState: SessionState;
  timestampMs: number;
  /**
   * Stable summary of the outcome for this transition. Content-free: no
   * source slices, no secrets. Mirrors the H13 discipline used by
   * HoplonEmitter events.
   */
  outcome?:
    | { kind: 'preflight'; status: 'PASS' | 'BLOCK'; violationCount: number }
    | { kind: 'createSnapshot'; snapshotRefId: string }
    | { kind: 'dryRun'; status: 'PASS' | 'BLOCK'; violationCount: number }
    | {
        kind: 'applyEdits';
        changedFileCount: number;
        bytesWritten: number;
        /** Per-variant counts (t-071). Content-free tally. */
        changeKindCounts: ApplyEditsChangeKindCounts;
      }
    | { kind: 'markEdited'; changedFileCount: number }
    | { kind: 'audit'; status: 'PASS' | 'BLOCK'; violationCount: number }
    | { kind: 'revert'; revertedCount: number; deletedCount: number; allowlistSkippedCount: number }
    | { kind: 'extractRollbackTemplate'; fileCount: number };
}

/**
 * Per-variant counts for an ApplyEditsResult. Populated by the t-071 widened
 * supervised write path so hosts and proofs can see which ergonomic shape
 * actually landed without parsing the raw request. Content-free (counts
 * only, H13).
 */
export interface ApplyEditsChangeKindCounts {
  readonly full_file: number;
  readonly patch: number;
  readonly structural: number;
}

/**
 * Input to the chunked staging sub-protocol (t-076). Callers upload a large
 * non-binary body in ordered chunks keyed by `stagingKey`; the finalized
 * body is referenced from a `ProposedChange` via `stagedContent`. The
 * session resolves the reference back to inline bytes before the existing
 * supervised write path runs, so audit/revert/rollback semantics stay
 * unchanged. Never writes to disk.
 */
export interface StageContentInput {
  readonly stagingKey: string;
  /** 0-based chunk index; must match the current staged chunk count exactly. */
  readonly seq: number;
  /** Raw chunk bytes. Transports decode base64 before calling the session. */
  readonly chunkBytes: Uint8Array;
  readonly isFinal: boolean;
  /** Required when `isFinal === true`; hex lowercase sha256 of the full body. */
  readonly expectedTotalSha256?: string;
  /** Required when `isFinal === true`; finalized byte length. */
  readonly expectedTotalByteLength?: number;
}

export interface StageContentResult {
  readonly stagingKey: string;
  readonly chunks: number;
  readonly bytesStaged: number;
  readonly complete: boolean;
  readonly sha256: string | null;
}

/**
 * Result of a Hoplon-applied write step. `changedFiles` mirrors the paths
 * the session wrote through its injected `HoplonFsAdapter` (sorted, de-
 * duplicated). `bytesWritten` is the total UTF-8 byte count across those
 * writes — content-free in the H13 sense (counts only, no source slices).
 * `changeKindCounts` tallies how many changes of each t-071 variant were
 * actually applied through the supervised write path.
 */
export interface ApplyEditsResult {
  readonly changedFiles: readonly string[];
  readonly bytesWritten: number;
  readonly changeKindCounts: ApplyEditsChangeKindCounts;
  readonly overlayRefresh?: SemanticOverlayRefreshResult;
}

export interface MarkEditedResult {
  readonly changedFiles: readonly string[];
  readonly overlayRefresh: SemanticOverlayRefreshResult;
}

/**
 * Durable view of the session observable by the host. Every field is
 * written by exactly one session method; the host reads them to make
 * retry / escalation decisions without owning the state machine itself.
 */
export interface SessionSnapshot {
  /** Opaque session identity, unique per constructor call. */
  sessionId: string;
  /** Current primary state. */
  state: SessionState;
  /** The manifest the session was constructed against. Immutable. */
  manifest: WritableManifest;
  /** Correlation id threaded through every engine call. Immutable. */
  correlationId: string;
  /** projectId + runId pulled from the manifest at construction. Immutable. */
  projectId: string;
  runId: string;
  /** Engine identity observed at construction. Immutable. */
  engineId: string;
  /** Snapshot ref produced by createSnapshot; null until that step runs. */
  snapshotRef: SnapshotRef | null;
  /** Changed files declared by markEdited; empty until that step runs. */
  changedFiles: readonly string[];
  /** Last preflight/dryRun/audit/revert/rollback results, if reached. */
  lastPreflightResult: PreflightResult | null;
  lastDryRunResult: DryRunResult | null;
  lastAuditResult: AuditResult | null;
  lastRevertResult: RevertResult | null;
  lastRollbackTemplate: RollbackTemplate | null;
  /**
   * Repair-context linkage from a prior failed session (t-070). When the
   * session was constructed with `priorRepairContext`, that DTO is echoed
   * here so the host can see the cross-session linkage through the same
   * snapshot surface it already consumes. Null on first-attempt sessions.
   */
  priorRepairContext: RepairContext | null;
  /**
   * 1-based attempt counter at the current session state (t-070). Starts
   * from 1 on a fresh session, or from `priorRepairContext.nextAttempt.
   * attemptNumber` when a prior repair context was supplied. Advances by 1
   * on every audit() call. Exposed so hosts and proofs can read the
   * expected retry attempt number without re-deriving it from history.
   */
  nextAttemptNumber: number;
  /** Ordered append-only transition log. */
  history: readonly SessionTransition[];
}
