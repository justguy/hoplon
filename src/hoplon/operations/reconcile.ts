/**
 * operations/reconcile.ts — E1 reconcile operation.
 *
 * Detects orphaned snapshot records (pending rows from a crashed prior process)
 * and resolves them. Auto-called at engine construction; idempotent.
 *
 * ## H10 — Atomicity Recovery
 *   createSnapshot uses a two-phase write (pending → committed/failed).
 *   A process crash between Phase A (pending row written) and Phase C (row
 *   committed) leaves a hanging pending row. reconcile() detects these rows
 *   by age (older than pendingOrphanThresholdMs) and resolves them so the
 *   snapshot store does not accumulate ghost rows.
 *
 * ## hcr-001 — Ref-verified completion
 *   createSnapshot records the git commit SHA on the pending row as soon as
 *   Phase B succeeds (SnapshotStore.recordPendingGitRef). When reconcile()
 *   is given the OPTIONAL versioning adapter + gitRepoDir, an orphan whose
 *   gitRef resolves to a real commit is COMPLETED to 'committed' — the crash
 *   happened between Phase B and Phase C and the data is safe in git.
 *   The packaged engine factory wires this recovery path by default. Direct
 *   operation callers may still omit versioning for compatibility; rows
 *   without a gitRef or with an unverifiable/mismatched commit are marked
 *   failed exactly as before.
 *
 * ## Idempotency
 *   Running reconcile() twice in succession is safe: the first run resolves
 *   all eligible pending rows (completed or failed); the second run finds no
 *   new eligible rows and returns reconciled=0.
 *
 * ## Phase 1 limitation — git objects
 *   Phase 1 cannot cheaply enumerate git objects with no registry entry.
 *   orphans.gitObjects is always 0 in Phase 1. Phase 2 will add a proper GC
 *   pass that walks the git object store and cross-references the snapshot
 *   registry to find dangling objects.
 *
 * ## AbortSignal (H12)
 *   Checked at entry only. The underlying snapshotStore calls are coarse-grained
 *   (WASM-backed SQLite) and cannot be interrupted mid-call; signal is checked
 *   before work begins.
 *
 * ## HoplonEvent schema (H13)
 *   Uses .strict() schema — no count fields added to events.
 *
 * ## Import wall
 *   Imports only from ../adapters/*, ../contracts/*, ../util/*.
 *   Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { ReconcileReport } from '../contracts/reconcile.js';
import { EngineError } from '../contracts/errors.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  /** SQLite snapshot store (C1). */
  snapshotStore: SnapshotStore;
  /**
   * Versioning adapter (C4) for ref-verified completion. The packaged factory
   * always provides it; the property remains optional only for direct legacy
   * operation callers. When provided together with config.gitRepoDir, pending rows
   * whose gitRef resolves to a real commit are completed to 'committed'
   * instead of being marked failed. Omit for the pre-hcr-001 behavior.
   */
  versioning?: VersioningAdapter;
  /** Operational event emitter (C5). */
  emitter: HoplonEmitter;
  /** Engine identity (H5). */
  engineId: string;
  config: {
    /**
     * Pending rows older than this many milliseconds are treated as orphans
     * (left behind by a crashed process). Default: 60_000 (1 minute).
     */
    pendingOrphanThresholdMs: number;
    /**
     * Snapshot git repository dir — required for hcr-001 ref-verified
     * completion (ignored unless `versioning` is also provided).
     */
    gitRepoDir?: string;
  };
}

// ---------------------------------------------------------------------------
// reconcile — main entry point
// ---------------------------------------------------------------------------

/**
 * Detect and reconcile orphaned snapshot records.
 *
 * Idempotent: running twice in succession yields the same state.
 * Auto-called at engine construction; callable externally at any time.
 *
 * @throws {DOMException} name 'AbortError' — signal aborted before any work
 * @throws {EngineError} kind 'reconcile_failed' — snapshotStore.listPending threw
 */
export async function reconcile(
  deps: ReconcileDeps,
  signal?: AbortSignal,
): Promise<ReconcileReport> {
  const { snapshotStore, versioning, emitter, engineId, config } = deps;
  const startMs = Date.now();

  // -------------------------------------------------------------------------
  // Step 1: Check abort before any work (H12)
  // -------------------------------------------------------------------------
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error
      ? reason
      : new DOMException(
          typeof reason === 'string' ? reason : 'Operation aborted',
          'AbortError',
        );
  }

  // -------------------------------------------------------------------------
  // Step 2: Emit start event (H11)
  // -------------------------------------------------------------------------
  try {
    emitter.emit({
      op: 'reconcile',
      phase: 'start',
      engineId,
      correlationId: 'reconcile',
    });
  } catch {
    // Emitter errors must never propagate (H13 — emitter is fire-and-forget)
  }

  // -------------------------------------------------------------------------
  // Step 3: List pending orphans
  // -------------------------------------------------------------------------
  let orphans: Awaited<ReturnType<SnapshotStore['listPending']>>;
  try {
    orphans = await snapshotStore.listPending(config.pendingOrphanThresholdMs);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    try {
      emitter.emit({
        op: 'reconcile',
        phase: 'error',
        engineId,
        correlationId: 'reconcile',
        durationMs,
        errorCategory: 'adapter',
        errorKind: 'snapshot_store_read_failed',
      });
    } catch {
      // suppress emitter error
    }
    throw new EngineError(
      {
        kind: 'reconcile_failed',
        engineId,
        correlationId: 'reconcile',
        cause: err,
      },
      `reconcile: snapshotStore.listPending threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pendingRowCount = orphans.length;
  let reconciled = 0;
  let failed = 0;

  // -------------------------------------------------------------------------
  // Step 4: Resolve each orphan — complete when the git ref verifies (hcr-001),
  // otherwise mark failed as before.
  // -------------------------------------------------------------------------
  for (const orphan of orphans) {
    // hcr-001: a pending row carrying a gitRef crashed between Phase B and
    // Phase C — the commit may exist. With the optional versioning seam
    // wired, verify the commit object and complete the row instead of
    // failing it. Verification failure (or no seam) falls through to the
    // pre-existing mark-failed path.
    if (
      orphan.gitRef !== null &&
      versioning !== undefined &&
      config.gitRepoDir !== undefined
    ) {
      let refVerified = false;
      try {
        const commit = await versioning.readCommitInfo({
          dir: config.gitRepoDir,
          ref: orphan.gitRef,
        });
        // Existence alone is not enough: another snapshot's valid commit must
        // never complete this row. createSnapshot binds every internal commit
        // to its content-addressed row id in the first-line message.
        refVerified =
          commit.oid === orphan.gitRef &&
          commit.messageFirstLine === `hoplon-snapshot ${orphan.id}`;
      } catch {
        // Commit missing or ref malformed — not recoverable; mark failed below.
      }
      if (refVerified) {
        try {
          await snapshotStore.updateStatus(
            orphan.id,
            'committed',
            undefined,
            orphan.gitRef,
          );
          reconciled++; // completed, NOT counted under failed
          continue;
        } catch {
          // Best-effort: leave pending; retried next startup.
          continue;
        }
      }
    }

    try {
      await snapshotStore.updateStatus(
        orphan.id,
        'failed',
        'pending row older than threshold on startup reconcile',
      );
      reconciled++;
      failed++; // failed = count of rows marked failed
    } catch {
      // Best-effort: if we cannot update a single row, skip it.
      // Do not throw — reconcile is best-effort and should not block engine startup
      // for a single bad row. The row remains pending and will be retried next startup.
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Emit end event
  // -------------------------------------------------------------------------
  const durationMs = Date.now() - startMs;
  try {
    emitter.emit({
      op: 'reconcile',
      phase: 'end',
      engineId,
      correlationId: 'reconcile',
      durationMs,
      classification: 'PASS',
    });
  } catch {
    // suppress emitter error
  }

  // -------------------------------------------------------------------------
  // Step 6: Return ReconcileReport
  // -------------------------------------------------------------------------
  return {
    reconciled,
    failed,
    orphans: {
      // TODO(Phase 2): walk git object store + cross-reference registry for dangling objects
      gitObjects: 0,
      pendingRows: pendingRowCount,
    },
  };
}
