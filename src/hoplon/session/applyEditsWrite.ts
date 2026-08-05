/**
 * session/applyEditsWrite.ts — inner resolve+flush loop for the supervised
 * Hoplon-applied write path (t-063 / t-071 / t-090).
 *
 * `performApplyEdits` (in `applyEdits.ts`) owns lock acquisition and result
 * envelope shaping; this module owns the per-batch byte mechanics:
 *
 *   1. capture each touched file's live base via `captureOriginalFileState`
 *      (post-lock, pre-resolve)
 *   2. resolve each `ProposedChange` to final UTF-8 bytes against the
 *      running intermediate state
 *   3. immediately before each `fs.write`, run the stale-write barrier
 *      (`assertLiveBaseUnchanged`) so external mutations between capture
 *      and flush refuse the write rather than silently overwriting it
 *   4. on any failure (resolution error, stale-write drift, adapter throw),
 *      roll back ONLY the files that were actually flushed in this batch
 *      so we never leave a partial write behind a non-advanced session
 *      state — and we never falsely "rollback" a file we never wrote.
 *      Rollback is guarded (hcr-005): a file is restored only when its live
 *      content still hashes to what this batch wrote; diverged files (a
 *      concurrent writer landed after our flush) are left untouched and
 *      reported as typed conflicts on the rethrown error (see
 *      `applyEditsRollback.readApplyEditsRollbackConflicts`).
 *
 * Pure logic over the injected `HoplonFsAdapter` and `CodeIntelligenceAdapter`;
 * the caller releases the lock plan in a `finally`.
 */

import type { ProposedChange } from '../contracts/requests.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import { AdapterError } from '../contracts/errors.js';
import { resolveChange, type ResolvedChangeKind } from './resolveChange.js';
import {
  assertLiveBaseUnchanged,
  captureOriginalFileState,
  type OriginalFileState,
} from './applyEditsFileState.js';
import {
  attachRollbackConflicts,
  restoreWrittenFilesGuarded,
} from './applyEditsRollback.js';
import { gitBlobSha1, type GitBlobSha1 } from './gitBlobHash.js';
import type { ApplyEditsResult, SessionState } from './types.js';

export interface WriteResolvedChangesOptions {
  fs: HoplonFsAdapter;
  proposedChanges: readonly ProposedChange[];
  fromState: SessionState;
  codeIntelligence: CodeIntelligenceAdapter | null;
}

export interface WriteResolvedChangesResult extends ApplyEditsResult {
  readonly capturedBeforeBytes: ReadonlyMap<string, Uint8Array | null>;
}

export async function writeResolvedChanges(
  opts: WriteResolvedChangesOptions,
): Promise<WriteResolvedChangesResult> {
  const { fs, proposedChanges, fromState, codeIntelligence } = opts;
  let bytesWritten = 0;
  const seen = new Set<string>();
  const written: string[] = [];
  const originals = new Map<string, OriginalFileState>();
  /**
   * Running intermediate bytes per file. Seeded from the captured original
   * on first touch and updated to each variant's resolved output in memory.
   * Subsequent changes targeting the same file compose against this running
   * state so multi-hunk patches or chained structural edits produce one
   * final file image before the adapter sees any write for that path.
   */
  const intermediates = new Map<string, Uint8Array | null>();
  /**
   * Last `proposedChanges` index that targeted each touched file. Used as
   * best-effort attribution when the stale-write barrier raises mid-batch
   * — the agent gets a single, deterministic `failedChangeIndex` for the
   * offending file even if the batch composed multiple changes against it.
   */
  const lastChangeIndex = new Map<string, number>();
  /** Tallies per variant — surfaced through the ApplyEditsResult for t-071. */
  const kindCounts: Record<ResolvedChangeKind, number> = {
    full_file: 0,
    patch: 0,
    structural: 0,
  };
  const writtenFiles: string[] = [];
  /**
   * Hash of the final bytes flushed per file, captured immediately before
   * the adapter write (hcr-005). The guarded rollback uses it to prove the
   * session is still the last writer before restoring a file's original.
   */
  const writtenHashes = new Map<string, GitBlobSha1>();
  try {
    for (const [changeIndex, change] of proposedChanges.entries()) {
      if (!originals.has(change.file)) {
        const original = await captureOriginalFileState(fs, change.file);
        originals.set(change.file, original);
        intermediates.set(change.file, original.bytes);
      }
      const currentBytes = intermediates.get(change.file) ?? null;
      const resolved = await resolveChange(change, {
        currentBytes,
        codeIntelligence,
        fromState,
        changeIndex,
      });
      intermediates.set(resolved.file, resolved.bytes);
      kindCounts[resolved.kind] += 1;
      lastChangeIndex.set(change.file, changeIndex);
      if (!seen.has(change.file)) {
        seen.add(change.file);
        written.push(change.file);
      }
    }

    for (const file of written) {
      const original = originals.get(file);
      if (!original) {
        // Unreachable: every entry in `written` was added when its
        // `original` was first captured. Defensive narrowing for TS strict.
        throw new Error(`internal: missing captured original for ${file}`);
      }
      // Stale-write TOCTOU barrier (t-090): re-check the live disk state
      // against the live base captured at first touch. Drift here means an
      // external writer mutated, created, or deleted this file between our
      // capture and the impending flush. Raising before `fs.write` keeps
      // session state at `snapshotted` and triggers the same rollback path
      // as resolution errors.
      await assertLiveBaseUnchanged({
        fs,
        original,
        fromState,
        failedChangeIndex: lastChangeIndex.get(file) ?? 0,
      });
      // Push BEFORE the adapter write begins. The semantics are
      // "files this batch attempted to flush" — if `fs.write` throws
      // mid-mutation we still need rollback to cover the path because the
      // disk may already carry partial bytes. Files that never reached
      // the write (e.g. a stale-write barrier raised before them) stay
      // out of `writtenFiles` so the rollback never restores files this
      // batch never touched.
      writtenFiles.push(file);
      const finalBytes = intermediates.get(file) ?? new Uint8Array();
      writtenHashes.set(file, gitBlobSha1(finalBytes));
      await fs.write(file, finalBytes);
      bytesWritten += finalBytes.byteLength;
    }
  } catch (err) {
    try {
      // Roll back ONLY files that were actually flushed. The captured
      // `originals` map covers every file the resolve loop touched, but
      // restoring an unwritten file is still a no-op write of its existing
      // bytes — which itself counts as a write under tests that observe
      // the adapter (and would defeat the "no partial write" property when
      // the stale-check raised before any byte landed). Restricting
      // rollback to `writtenFiles` keeps the property exact: the disk only
      // changes if we already changed it, and we always undo what we
      // changed. The restore is guarded (hcr-005): a file whose live bytes
      // no longer hash to what this batch wrote (a concurrent writer landed
      // after our flush) is NOT overwritten — it is reported as a typed
      // conflict on the rethrown error instead.
      const conflicts = await restoreWrittenFilesGuarded({
        fs,
        writtenFiles,
        originals,
        writtenHashes,
      });
      attachRollbackConflicts(err, conflicts);
    } catch (rollbackErr) {
      throw new AdapterError(
        {
          kind: 'fs_write_failed',
          engineId: 'adapter',
          correlationId: 'adapter',
          cause: { originalError: err, rollbackError: rollbackErr },
        },
        'applyEdits failed and rollback could not restore the original files',
      );
    }
    throw err;
  }
  const sorted = [...written].sort();
  const capturedBeforeBytes = new Map<string, Uint8Array | null>();
  for (const [path, original] of originals) {
    capturedBeforeBytes.set(path, original.existed ? original.bytes : null);
  }
  return {
    changedFiles: sorted,
    bytesWritten,
    changeKindCounts: { ...kindCounts },
    capturedBeforeBytes,
  };
}
