/**
 * session/applyEditsRollback.ts — hcr-005 guarded rollback for the
 * supervised write path.
 *
 * The write path's rollback previously restored every file it had flushed
 * UNCONDITIONALLY, so a legitimate concurrent writer that landed between our
 * flush and the rollback was silently overwritten with pre-batch bytes.
 *
 * `restoreWrittenFilesGuarded` restores a file ONLY when the session can
 * prove it is still the last writer: the live content hash must equal the
 * hash of the bytes this batch wrote (captured at write time). Files whose
 * live state diverged — mutated or deleted by an external actor, or left in
 * an indeterminate state by a mid-write adapter failure — are left untouched
 * and reported as typed conflicts so the host can decide. Files already back
 * at their captured base need no restore and report no conflict.
 *
 * Conflicts ride on the ORIGINAL thrown error (the write path rethrows it
 * unchanged, preserving the existing error contract) via an in-process
 * WeakMap; hosts read them with `readApplyEditsRollbackConflicts(err)`.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import { AdapterError } from '../contracts/errors.js';
import { gitBlobSha1, type GitBlobSha1 } from './gitBlobHash.js';
import type { OriginalFileState } from './applyEditsFileState.js';

/** One skipped restore: the live file no longer carries this batch's bytes. */
export interface ApplyEditsRollbackConflict {
  readonly path: string;
  readonly reason: 'diverged_since_write';
  /** Hash of the bytes this batch wrote (captured at write time). */
  readonly writtenSha1: GitBlobSha1;
  /** Live blob hash at rollback time; null = the file was deleted. */
  readonly liveSha1: GitBlobSha1 | null;
}

const conflictsByError = new WeakMap<object, readonly ApplyEditsRollbackConflict[]>();

/** Attach rollback conflicts to the error the write path is about to rethrow. */
export function attachRollbackConflicts(
  err: unknown,
  conflicts: readonly ApplyEditsRollbackConflict[],
): void {
  if (conflicts.length === 0) return;
  if (typeof err !== 'object' || err === null) return;
  conflictsByError.set(err, conflicts);
}

/**
 * Read the typed rollback conflicts carried by a failed `applyEdits` error.
 * Null when the rollback restored everything it wrote (no divergence).
 * In-process only — transport-serialized errors do not carry conflicts.
 */
export function readApplyEditsRollbackConflicts(
  err: unknown,
): readonly ApplyEditsRollbackConflict[] | null {
  if (typeof err !== 'object' || err === null) return null;
  return conflictsByError.get(err) ?? null;
}

export interface RestoreWrittenFilesGuardedOptions {
  readonly fs: HoplonFsAdapter;
  /** Files this batch attempted to flush, in flush order. */
  readonly writtenFiles: readonly string[];
  /** Captured pre-batch state per touched file. */
  readonly originals: ReadonlyMap<string, OriginalFileState>;
  /** Hash of the final bytes this batch wrote, per flushed file. */
  readonly writtenHashes: ReadonlyMap<string, GitBlobSha1>;
}

/**
 * Restore flushed files to their captured originals, in reverse flush order,
 * skipping (and reporting) any file whose live content diverged from what
 * this batch wrote. Adapter throws while probing/restoring are aggregated
 * into a single `AdapterError({ kind: 'fs_write_failed' })`, matching the
 * pre-existing rollback error surface.
 */
export async function restoreWrittenFilesGuarded(
  opts: RestoreWrittenFilesGuardedOptions,
): Promise<readonly ApplyEditsRollbackConflict[]> {
  const { fs, writtenFiles, originals, writtenHashes } = opts;
  const conflicts: ApplyEditsRollbackConflict[] = [];
  const rollbackFailures: unknown[] = [];
  for (const path of [...writtenFiles].reverse()) {
    const original = originals.get(path);
    const writtenSha1 = writtenHashes.get(path);
    if (original === undefined || writtenSha1 === undefined) {
      // Unreachable: both maps are populated before a file enters
      // `writtenFiles`. Defensive narrowing for TS strict.
      continue;
    }
    try {
      const stat = await fs.stat(path);
      if (!stat.exists) {
        // Already absent. If it originally existed, an external actor deleted
        // it after our flush — do not resurrect it; report the divergence.
        if (original.existed) {
          conflicts.push({ path, reason: 'diverged_since_write', writtenSha1, liveSha1: null });
        }
        continue;
      }
      const liveSha1 = gitBlobSha1(await fs.read(path));
      if (liveSha1 === writtenSha1) {
        // This batch is still the last writer — safe to restore the original.
        if (original.existed) {
          await fs.write(path, original.bytes ?? new Uint8Array());
        } else {
          await fs.remove(path);
        }
        continue;
      }
      if (original.existed && liveSha1 === original.liveBaseHash) {
        // Already back at the captured base (e.g. the failing write never
        // landed). Nothing to restore, nothing to report.
        continue;
      }
      conflicts.push({ path, reason: 'diverged_since_write', writtenSha1, liveSha1 });
    } catch (err) {
      rollbackFailures.push(err);
    }
  }
  if (rollbackFailures.length > 0) {
    throw new AdapterError(
      {
        kind: 'fs_write_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: rollbackFailures,
      },
      'Failed to restore original files after applyEdits error',
    );
  }
  return conflicts;
}
