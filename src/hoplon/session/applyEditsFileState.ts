/**
 * session/applyEditsFileState.ts — touched-file state helpers for the
 * supervised Hoplon-applied write path.
 *
 * Owns two responsibilities the write path used to inline (rollback
 * restoration moved to `applyEditsRollback.ts` under hcr-005, which restores
 * guarded by the written-content hash instead of unconditionally):
 *
 *   1. **Live-base capture** — for each file the batch touches, snapshot the
 *      bytes (or non-existence) that resolution will compose against. The
 *      captured shape is the *live base* used by the stale-write barrier
 *      (t-090): it is taken AFTER lock acquisition (so concurrent same-key
 *      writers serialize through us) but BEFORE the resolve loop produces
 *      output bytes. This is intentionally not the session's `snapshotRef`
 *      — drift detection cares about who-mutated-the-bytes-while-we-resolved,
 *      not about how the working tree differs from the audit baseline.
 *
 *   2. **Stale-write drift detection** — immediately before each final
 *      `fs.write`, re-stat + re-read the live disk state and compare to the
 *      captured live base. Any mismatch (bytes diverged, file removed since
 *      capture, file created since capture) raises a typed
 *      `SessionError({ kind: 'stale_write' })` with content-free recovery
 *      metadata. The caller is responsible for rolling back any earlier
 *      writes in the same batch and for keeping session state at
 *      `snapshotted` — the helper itself never mutates session state.
 *
 * No filesystem call sits outside the injected `HoplonFsAdapter`; the helper
 * is pure logic over that adapter.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import { SessionError } from './errors.js';
import { gitBlobSha1, type GitBlobSha1 } from './gitBlobHash.js';
import type { SessionState } from './types.js';

/**
 * Bytes (or non-existence) captured for one touched file at the moment the
 * supervised write path took ownership of it. The `bytes` field carries a
 * defensive copy of the live disk bytes when `existed === true`; the helper
 * never mutates this buffer in place.
 */
export interface OriginalFileState {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes: Uint8Array | null;
  readonly liveBaseHash: GitBlobSha1 | null;
}

/**
 * Capture the live base for `path`. Called once per file on first touch in
 * the resolve loop. The capture happens AFTER lock acquisition so the
 * structural / per-file lock plan has already linearized concurrent
 * Hoplon-owned writers; remaining drift can only come from external (non-
 * Hoplon) writers, and that is exactly what the stale-write barrier
 * defends against.
 */
export async function captureOriginalFileState(
  fs: HoplonFsAdapter,
  path: string,
): Promise<OriginalFileState> {
  const stat = await fs.stat(path);
  if (!stat.exists) {
    return { path, existed: false, bytes: null, liveBaseHash: null };
  }
  const bytes = await fs.read(path);
  const copied = new Uint8Array(bytes);
  return {
    path,
    existed: true,
    bytes: copied,
    liveBaseHash: gitBlobSha1(copied),
  };
}

export interface AssertLiveBaseUnchangedOptions {
  readonly fs: HoplonFsAdapter;
  readonly original: OriginalFileState;
  readonly fromState: SessionState;
  /**
   * Best-effort change-index attribution for the failed file. The supervised
   * write path tracks the last `proposedChanges` entry that targeted each
   * touched path; surfaced through `failedChangeIndex` so retry harnesses
   * can map the drift back to the offending submission row without parsing
   * the full batch.
   */
  readonly failedChangeIndex: number;
}

/**
 * Re-check the live disk state for `original.path` against the captured
 * live base. On drift, throw a typed `SessionError({ kind: 'stale_write' })`
 * before any byte is written through the adapter for this file. The error
 * payload is content-free: only the file path, byte-length pair, and
 * sub-kind discriminator are surfaced.
 *
 * The function never compares to `snapshotRef` — drift here means "an
 * external writer mutated/created/deleted the file between live-base
 * capture and our flush attempt". Long-running sessions whose snapshotRef
 * is stale for legitimate reasons (e.g. another agent landed an audited
 * change) do not surface here; that is a separate audit-time concern.
 */
export async function assertLiveBaseUnchanged(
  opts: AssertLiveBaseUnchangedOptions,
): Promise<void> {
  const { fs, original, fromState, failedChangeIndex } = opts;
  const stat = await fs.stat(original.path);
  if (!original.existed && stat.exists) {
    throw new SessionError({
      kind: 'stale_write',
      from: fromState,
      attempted: 'applyEdits',
      detail: `external writer created "${original.path}" between live-base capture and flush`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        file: original.path,
        failedChangeIndex,
        driftKind: 'unexpected_creation',
        byteLengthBefore: null,
        byteLengthLive: stat.size,
      },
    });
  }
  if (original.existed && !stat.exists) {
    throw new SessionError({
      kind: 'stale_write',
      from: fromState,
      attempted: 'applyEdits',
      detail: `external writer removed "${original.path}" between live-base capture and flush`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        file: original.path,
        failedChangeIndex,
        driftKind: 'unexpected_deletion',
        byteLengthBefore: original.bytes?.byteLength ?? 0,
        byteLengthLive: null,
      },
    });
  }
  if (!original.existed && !stat.exists) {
    return;
  }
  // Both sides exist. Re-read live bytes and compare Git-compatible blob
  // hashes to the captured live base. The compare remains against the
  // post-lock live base, never against the session snapshotRef.
  const liveBytes = await fs.read(original.path);
  const liveHash = gitBlobSha1(liveBytes);
  if (original.liveBaseHash !== liveHash) {
    throw new SessionError({
      kind: 'stale_write',
      from: fromState,
      attempted: 'applyEdits',
      detail: `external writer mutated "${original.path}" between live-base capture and flush`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        file: original.path,
        failedChangeIndex,
        driftKind: 'bytes_diverged',
        byteLengthBefore: original.bytes?.byteLength ?? 0,
        byteLengthLive: liveBytes.byteLength,
      },
    });
  }
}
