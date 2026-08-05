/**
 * engine/types.ts — HoplonEngine interface, HoplonAdapters, HoplonEngineConfig.
 *
 * All public methods return Promise<T> (invariant H3 — no callbacks, no event emitters).
 * Every async method accepts an optional AbortSignal (H12).
 * The engine never owns retry or escalation policy (invariant H4).
 *
 * EXCEPTIONS (synchronous methods):
 *   compressRetryContext — pure data transform over AuditViolation arrays (recs §15.9, LC9).
 *   computeMinimalPatch  — pure byte-range arithmetic over violation data (recs §15.5, LC5).
 * Both are no-I/O, no-async functions that return values directly (not Promises).
 */

import type { PackContextRequest } from '../contracts/requests.js';
import type { PriorAttempt, CompressedRetryContext } from '../contracts/retryContext.js';
import type { ComputeMinimalPatchRequest, MinimalPatch } from '../contracts/computeMinimalPatch.js';
import type { CreateSnapshotRequest } from '../contracts/requests.js';
import type { AuditRequest } from '../contracts/requests.js';
import type { RevertRequest } from '../contracts/requests.js';
import type { DryRunRequest } from '../contracts/requests.js';
import type { PreflightRequest } from '../contracts/requests.js';
import type { QueryStructureRequest, QueryStructureResult } from '../contracts/queryStructure.js';
import type { ExtractStructuralTemplateRequest, StructuralTemplate } from '../contracts/structuralTemplate.js';
import type { SnapshotResult } from '../contracts/snapshot.js';
import type { PackedContext } from '../contracts/context.js';
import type { AuditResult } from '../contracts/audit.js';
import type { RevertResult } from '../contracts/revert.js';
import type { EngineHealth } from '../contracts/health.js';
import type { GcRequest, GcResult } from '../contracts/gc.js';
import type { DescribeCapabilitiesRequest, DescribeCapabilitiesResult } from '../contracts/capabilities.js';
import type { ReconcileReport } from '../contracts/reconcile.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { DryRunResult } from '../contracts/invariantBinding.js';

// ---------------------------------------------------------------------------

export interface HoplonEngineOperationsPart01 {
  /**
   * Capture a contracted writable scope as an isomorphic-git commit.
   * Returns a content-addressable ref (H1) and non-blocking secret-scan warnings.
   * Idempotent: same manifest → same ref, single store row.
   */
  createSnapshot(req: CreateSnapshotRequest, signal?: AbortSignal): Promise<SnapshotResult>;

  /**
   * Compare the current file tree's AST against the contracted manifest.
   * Returns PASS or BLOCK with typed violations.
   * Idempotent (read-only).
   */
  auditDiff(req: AuditRequest, signal?: AbortSignal): Promise<AuditResult>;

  /**
   * Restore the contracted files to their snapshotted state.
   * Deletes uncontracted post-snapshot files (modulo allowlist, RS-1).
   * NOT idempotent — do not retry blind on failure.
   */
  revertUncontracted(req: RevertRequest, signal?: AbortSignal): Promise<RevertResult>;

  /**
   * Return AST-bounded context slices (no substring cuts).
   * Deterministic per H7. Idempotent.
   */
  packContext(req: PackContextRequest, signal?: AbortSignal): Promise<PackedContext>;

  /**
   * Probe each adapter. Returns engine + adapter health status.
   * Idempotent.
   */
  health(signal?: AbortSignal): Promise<EngineHealth>;

  /**
   * Return the typed extension-capability catalog for the current engine.
   *
   * This is introspection only: it describes target-state capability seams,
   * version metadata expectations, side-effect posture, and failure isolation.
   * It does not execute providers and does not affect core PASS/BLOCK semantics.
   */
  describeCapabilities(
    req: DescribeCapabilitiesRequest,
    signal?: AbortSignal,
  ): Promise<DescribeCapabilitiesResult>;

  /**
   * Detect orphaned snapshot records (pending from a crashed prior process)
   * and reconcile them against the git object store.
   * Auto-runs at engine construction. Idempotent.
   */
  reconcile(signal?: AbortSignal): Promise<ReconcileReport>;

  /**
   * Evaluate proposed file changes against the contracted manifest scope
   * without touching disk.
   *
   * Same mathematical core as auditDiff (AS-1/AS-2/AS-3 + AUDITED_NODE_KINDS
   * whitelist + H8 schema check), but:
   *   - Baseline from git via readBlob (no disk read)
   *   - Proposed content from req.proposedChanges materialized in-memory
   *     against the snapshot baseline
   *   - Never writes anything to disk
   *   - Never creates an audit log entry (exploratory by design)
   *
   * Idempotent (H17): same (proposedChanges, snapshotRef) → byte-identical output.
   */
  dryRun(req: DryRunRequest, signal?: AbortSignal): Promise<DryRunResult>;

  /**
   * Run all registered Stage 1 pre-execution gates against the manifest.
   *
   * Returns PreflightResult with per-gate status and aggregated overall status.
   * PASS iff all gates pass or skip; BLOCK if any gate produces violations.
   *
   * Phase 2 PR1 default gates: [pathTraversalGate]
   * Phase 2 Stage B LC1 will add: [pathTraversalGate, checkTargetsGate]
   */
  preflight(req: PreflightRequest, signal?: AbortSignal): Promise<PreflightResult>;

  /**
   * Execute S-expression (tree-sitter Query DSL) queries against a set of files.
   *
   * Layer 3 of the three-layer code intelligence pipeline (recs §13.2).
   * Returns exact AST node captures from declarative S-expression patterns.
   *
   * Results are in sorted file order (H7 determinism).
   * Partial failures (missing file, parse error, invalid query) are collected
   * in result.failures — they do NOT throw. Structural errors throw.
   *
   * Use the standard query library (stdQueries.ts) for common extraction needs:
   * extract-function-signatures, extract-exports, extract-imports,
   * extract-class-methods.
   */
  queryStructure(req: QueryStructureRequest, signal?: AbortSignal): Promise<QueryStructureResult>;

  /**
   * Extract a deterministic structural skeleton from a set of files.
   *
   * Replaces full-file context with exports, imports, and type declarations
   * for Stage 2 LLM context injection (recs §15.4 — "Structural Template Injection").
   * Subsumes Track F1's skeleton_mode — same capability, Hoplon-internal implementation.
   *
   * When snapshotRefId is present: content is read from the git object store (no disk read).
   * When absent: content is read from the live filesystem.
   *
   * Deterministic (H7): same (files, snapshotRefId) → byte-identical StructuralTemplate.
   *
   * @param req.files         — relative paths to extract from
   * @param req.snapshotRefId — optional snapshot reference (live FS when absent)
   * @param req.queryId       — optional custom bundle ID in the result (default: 'structural-template')
   * @param req.customQueries — optional custom tree-sitter queries (replaces built-in bundle when provided)
   */
  extractStructuralTemplate(
    req: ExtractStructuralTemplateRequest,
    signal?: AbortSignal,
  ): Promise<StructuralTemplate>;

  /**
   * Delete snapshot records matching the filter. Used for right-to-erasure (privacy)
   * and TTL-based garbage collection (W3).
   *
   * Delegates to SnapshotStore.gc with identical semantics.
   *
   * At least one filter must be provided to prevent accidental full-table deletion.
   * Throws ValidationError({ kind: 'invalid_scope' }) if all filters are absent.
   *
   * @param opts.projectId     — delete only records for this project
   * @param opts.olderThan     — delete records where created_at < olderThan (ISO 8601)
   * @param opts.expiredBefore — delete records where ttl_expires IS NOT NULL AND ttl_expires < expiredBefore (ISO 8601)
   */
  gc(opts: GcRequest): Promise<GcResult>;

  /**
   * Compress a retry history into a structural delta.
   *
   * SYNCHRONOUS — the only non-Promise method on the engine facade.
   * Pure data transform over existing AuditViolation arrays. No I/O, no side effects.
   * (recs §15.9, plan § Slice LC9)
   *
   * Returns:
   *   - persistentViolations — present in EVERY attempt (agent never fixed these)
   *   - resolvedViolations   — present earlier, absent in the latest attempt (progress)
   *   - newViolations        — only in the latest attempt (regression introduced)
   *   - structuralDelta      — human-readable prose for retry prompt injection
   *   - retryDirective       — single action sentence focusing the agent on the next fix
   *
   * Empty attempts array → empty result. Single attempt → all violations are "new".
   * Identical attempts → all violations persistent, empty resolved/new, empty delta.
   */
  compressRetryContext(attempts: PriorAttempt[]): CompressedRetryContext;

  /**
   * Compute a minimal patch from a BLOCK AuditResult.
   *
   * SYNCHRONOUS — pure function over data. No I/O, no adapter calls, no async.
   * (recs §15.5, plan § Slice LC5)
   *
   * Phase 2 scope:
   *   - REMOVE_NODES (patchable === true): deterministic byte-range removal for
   *     'out_of_scope_symbol' and 'uncontracted_file' violations.
   *     correctedContent is populated — the LLM does not need to regenerate.
   *   - PATCH_NOT_COMPUTABLE (patchable === false): SCOPE_ESCAPE and
   *     STRUCTURAL_CORRUPTION cannot be fixed by removal alone. retryPrompt guides retry.
   *
   * Phase 3 will add RESTORE_NODE for SCOPE_ESCAPE (snapshot-state read + splice).
   *
   * Deterministic: same (content, violations) → byte-identical MinimalPatch (H7-style).
   */
  computeMinimalPatch(req: ComputeMinimalPatchRequest): MinimalPatch;
}
