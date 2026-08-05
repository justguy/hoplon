/**
 * operations/gates/checkTargets.ts — LC1 checkTargetsGate implementation.
 *
 * Phase 2 Stage B — Slice LC1: Dead Target Detection.
 *
 * Catches phantom-target and duplicate-target hallucinations before the LLM
 * runs, as a preflight gate registered alongside pathTraversalGate.
 *
 * ## What this gate checks
 *
 * For each manifest entry carrying an `intent` field (v2 manifests only):
 *
 *   - `intent: 'modify'` — the named symbol (or file) MUST already exist in
 *     the snapshot at the given `snapshotRefId`. If it doesn't →
 *     `TARGET_NOT_FOUND` violation.
 *
 *   - `intent: 'create'` — the named symbol (or file) must NOT exist in the
 *     snapshot. If it does → `DUPLICATE_TARGET` violation.
 *
 *   - `intent: undefined` (v1 manifests or v2 without intent) → skipped.
 *     Backward-compatible per SV1.
 *
 * ## Multiple symbols per entry (Design Decision #1)
 *
 * A `symbols` scope entry may list multiple symbols, e.g.
 * `{ kind: 'symbols', symbols: ['foo', 'bar', 'baz'] }`.
 * This gate checks **every symbol individually** and emits one violation per
 * missing/duplicate symbol. This maximises diagnostic value — if three
 * symbols are wrong, the LLM gets all three errors in one preflight run
 * rather than learning about them one at a time.
 *
 * ## AS-2 behavior in preflight (Design Decision #2)
 *
 * When `snapshot.projectId !== req.projectId` or `snapshot.runId !== req.runId`
 * or `snapshot.status !== 'committed'`, this gate returns SKIPPED rather than
 * BLOCK. Rationale: preflight is an advisory pre-execution check, not an
 * authoritative identity gate. AS-2 is ENFORCED (with SemanticError throws) in
 * `auditDiff` and `revertUncontracted`; those are the authoritative checkpoints.
 * Preflight's SKIPPED return signals to the caller that the check was deferred
 * rather than that the snapshot passed, preserving the correct distinction.
 *
 * ## File-level intent (Design Decision #3)
 *
 * A `whole_file` scope + `intent: 'modify'` means "this whole file should already
 * exist in the snapshot." A `whole_file` + `intent: 'create'` means "this whole
 * file should NOT yet exist." The gate checks file existence in the snapshot git
 * tree using readBlob: if readBlob succeeds, the file exists; if it throws
 * AdapterError { kind: 'git_read_failed' }, the file does not exist.
 *
 * ## Error categorization (Design Decision #4)
 *
 * `versioning.readBlob` throws `AdapterError { kind: 'git_read_failed' }` for
 * ALL git read failures — both "file not present at ref" and adapter/git errors.
 * To distinguish them safely, this gate catches `AdapterError { kind: 'git_read_failed' }`
 * and treats it as "file not present" (the dominant case for any reasonable git
 * object store). All other thrown errors are re-thrown as infrastructure failures.
 *
 * This matches `dryRun.ts`'s established pattern (see dryRun.ts § step (c)).
 * The risk of treating an adapter corruption error as "file not found" is
 * accepted for Phase 2 because:
 *   (a) auditDiff/revert are the hard enforcement gates;
 *   (b) preflight is advisory — a false PASS on a corrupted git store causes
 *       an unnecessary LLM call, not a security bypass;
 *   (c) Phase 3 can add finer-grained error discrimination in the adapter.
 *
 * ## Integration with pathTraversalGate
 *
 * pathTraversalGate runs first (cheaper; catches security violations before
 * any I/O). checkTargetsGate runs second (needs snapshot I/O, so it should
 * run after cheap structural checks).
 *
 * ## Import wall
 * Imports only from ../../adapters/*, ../../contracts/*, ../../util/*.
 * Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { PreflightGate, PreflightGateContext } from '../preflight.js';
import type { PreflightRequest } from '../../contracts/requests.js';
import type { PreflightGateResult } from '../../contracts/preflight.js';
import type { AuditViolation } from '../../contracts/audit.js';
import { checkFileTarget, checkSymbolTargets } from './checkTargetEntries.js';

// ---------------------------------------------------------------------------
// checkTargetsGate
// ---------------------------------------------------------------------------

export const checkTargetsGate: PreflightGate = {
  name: 'check_targets',

  async run(
    req: PreflightRequest,
    ctx: PreflightGateContext,
    signal?: AbortSignal,
  ): Promise<PreflightGateResult> {
    const startedAt = Date.now();
    const violations: AuditViolation[] = [];

    // -----------------------------------------------------------------------
    // Short-circuit: no snapshotRefId → SKIPPED
    // Some preflight callers check a manifest before any snapshot exists
    // (e.g. path_traversal gate only needs the manifest). The gate signals
    // SKIPPED rather than BLOCK so the caller knows the check was deferred.
    // -----------------------------------------------------------------------
    if (!req.snapshotRefId) {
      return {
        gateName: 'check_targets',
        status: 'SKIPPED',
        violations: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // -----------------------------------------------------------------------
    // Resolve snapshot record
    // -----------------------------------------------------------------------
    const snapshot = await ctx.snapshotStore.get(req.snapshotRefId);
    if (!snapshot) {
      violations.push({
        kind: 'snapshot_missing',
        path: '<preflight>',
        snapshotRefId: req.snapshotRefId,
        message: `Snapshot ${req.snapshotRefId} not found during preflight target check.`,
        correction: `Re-acquire a fresh snapshot before running preflight again.`,
      });
      return {
        gateName: 'check_targets',
        status: 'BLOCK',
        violations,
        durationMs: Date.now() - startedAt,
      };
    }

    // -----------------------------------------------------------------------
    // AS-2 in preflight: SKIPPED on project/run mismatch or non-committed status
    // (Design Decision #2 — see module TSDoc above)
    // -----------------------------------------------------------------------
    if (
      snapshot.projectId !== req.projectId ||
      snapshot.runId !== req.runId ||
      snapshot.status !== 'committed'
    ) {
      return {
        gateName: 'check_targets',
        status: 'SKIPPED',
        violations: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // -----------------------------------------------------------------------
    // gitRepoDir — required for readBlob; fall back to '.hoplon/repo'
    // -----------------------------------------------------------------------
    const gitRepoDir = ctx.config.gitRepoDir ?? '.hoplon/repo';

    // -----------------------------------------------------------------------
    // Walk each manifest entry, apply intent-specific checks
    // -----------------------------------------------------------------------
    for (const entry of req.manifest.entries) {
      // AbortSignal check per entry (H12)
      if (signal?.aborted) {
        throw new DOMException(
          typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
          'AbortError',
        );
      }

      // Backward-compat: entries without `intent` are skipped (SV1)
      if (entry.intent === undefined) continue;

      if (entry.scope.kind === 'whole_file') {
        // ----------------------------------------------------------------
        // File-level intent check (Design Decision #3)
        // ----------------------------------------------------------------
        await checkFileTarget(
          entry,
          snapshot.gitRef!,
          gitRepoDir,
          ctx,
          violations,
        );
      } else {
        // ----------------------------------------------------------------
        // Symbol-level intent check (Design Decision #1: all symbols)
        // ----------------------------------------------------------------
        await checkSymbolTargets(
          entry,
          snapshot.gitRef!,
          gitRepoDir,
          ctx,
          violations,
          signal,
        );
      }
    }

    return {
      gateName: 'check_targets',
      status: violations.length === 0 ? 'PASS' : 'BLOCK',
      violations,
      durationMs: Date.now() - startedAt,
    };
  },
};
