/**
 * adapters/traceStore.ts — TraceStore interface (t-068).
 *
 * Durable, queryable store for ExecutionTrace / Attempt / ProofBundle /
 * DecisionProvenance records. This is deliberately a SEPARATE adapter from
 * SnapshotStore:
 *
 *   - SnapshotStore.hoplon_audit_log is H13-safe and content-free.
 *   - TraceStore is the explicit raw-proof layer and IS allowed to store
 *     content (violation slices, node kinds, paths, expected scope, etc.).
 *
 * The separation is load-bearing: it lets operators keep the H13 log as-is
 * for compliance-friendly retention while providing a richer, explicitly
 * raw-proof surface for the trace viewer and evidence export.
 *
 * Writer discipline:
 *   - putExecution() is idempotent on executionId — safe to retry.
 *   - updateExecution() is the ONLY mutator; it writes updatedAt + status
 *     transitions. No field besides currentStatus/updatedAt is ever mutated.
 *   - appendAttempt() is append-only. Writers supply a monotonically
 *     increasing attemptNumber per execution; the store preserves that
 *     ordering and never rewrites or hides prior attempts.
 *     Blocked attempts MUST remain visible after later success.
 *   - putProofBundle() is idempotent on proofBundleRef. Once written, the
 *     row is immutable. The bundle is the canonical authoritative copy.
 *   - appendDecisionProvenance() is append-only; categories are durable.
 *
 * Reader discipline: all list/search methods return objects sorted by
 * createdAt ascending (oldest first). Callers handle pagination / reverse
 * ordering client-side.
 */

import type { ExecutionTrace, ExecutionStatus } from '../contracts/executionTrace.js';
import type { Attempt } from '../contracts/attempt.js';
import type { ProofBundle, ProofViolation } from '../contracts/proofBundle.js';
import type { DecisionProvenance } from '../contracts/decisionProvenance.js';

export interface TraceSearchFilters {
  projectId?: string;
  runId?: string;
  status?: ExecutionStatus;
  auditRef?: string;
  snapshotRef?: string;
  /** Match ProofViolation.path exactly. */
  path?: string;
  /** Inclusive ISO 8601 lower bound on createdAt. */
  createdAfter?: string;
}

/**
 * Export bundle shape — raw JSON evidence a user can archive or hand to
 * a compliance reviewer. Contains every durable record linked to the
 * execution, not a summary.
 */
export interface TraceExportBundle {
  execution: ExecutionTrace;
  attempts: Attempt[];
  proofBundles: ProofBundle[];
  violations: ProofViolation[];
  provenance: DecisionProvenance[];
  exportedAt: string;
  schemaVersion: number;
}

export interface TraceStore {
  // -------------------------------------------------------------------------
  // ExecutionTrace
  // -------------------------------------------------------------------------
  putExecution(trace: ExecutionTrace): Promise<void>;
  updateExecution(
    executionId: string,
    patch: { currentStatus: ExecutionStatus; updatedAt: string },
  ): Promise<void>;
  getExecution(executionId: string): Promise<ExecutionTrace | null>;
  listExecutions(filters: TraceSearchFilters): Promise<ExecutionTrace[]>;

  // -------------------------------------------------------------------------
  // Attempt
  // -------------------------------------------------------------------------
  appendAttempt(attempt: Attempt): Promise<void>;
  getAttempt(attemptId: string): Promise<Attempt | null>;
  listAttempts(executionId: string): Promise<Attempt[]>;

  // -------------------------------------------------------------------------
  // ProofBundle + violations
  // -------------------------------------------------------------------------
  putProofBundle(bundle: ProofBundle, violations: ProofViolation[]): Promise<void>;
  getProofBundle(proofBundleRef: string): Promise<ProofBundle | null>;
  listProofBundles(executionId: string): Promise<ProofBundle[]>;
  getViolation(violationId: string): Promise<ProofViolation | null>;
  listViolations(proofBundleRef: string): Promise<ProofViolation[]>;

  // -------------------------------------------------------------------------
  // DecisionProvenance
  // -------------------------------------------------------------------------
  appendDecisionProvenance(record: DecisionProvenance): Promise<void>;
  listProvenance(executionId: string): Promise<DecisionProvenance[]>;

  // -------------------------------------------------------------------------
  // Search / export
  // -------------------------------------------------------------------------
  /**
   * Search attempts matching the given filters. `path` matches against the
   * denormalised ProofViolation.path index (attempts whose proof bundle has
   * any violation on that path). `status` matches Attempt.status, not the
   * parent execution's currentStatus, so a historical BLOCK remains
   * searchable after a later PASS on the same execution. Other filters
   * compose with AND.
   */
  searchAttempts(filters: TraceSearchFilters): Promise<Attempt[]>;

  /** Export one execution's full durable record set as a JSON-ready object. */
  exportExecution(executionId: string): Promise<TraceExportBundle | null>;
}
