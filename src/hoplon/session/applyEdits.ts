/**
 * session/applyEdits.ts — Hoplon-applied write step entry point.
 *
 * Owns lock-plan acquisition + envelope shaping for the supervised write
 * path. Delegates the per-batch resolve+flush mechanics — variant
 * resolution, the stale-write TOCTOU barrier (t-090), and rollback-on-
 * failure — to `applyEditsWrite.writeResolvedChanges`. Every filesystem
 * call sits inside the injected `HoplonFsAdapter`; the engine core stays
 * pure.
 *
 * History:
 *   - t-063 introduced the supervised Hoplon-applied write path.
 *   - t-071 widened `ProposedChange` to a `full_file` / `patch` /
 *     `structural` discriminated union.
 *   - t-066 added node-scoped + per-file lock acquisition through the
 *     injected `LockProvider`.
 *   - t-090 closed the resolve→flush TOCTOU window with a typed
 *     `stale_write` `SessionError`. Drift is raised before the stale
 *     `fs.write` lands; any earlier writes in the same batch are rolled
 *     back to the captured live base.
 *
 * The session caller asserts `state === 'snapshotted'` before invoking and
 * advances state to `edited` only on a successful return — this module
 * never advances state itself, never exposes a partial bytes-written tally
 * as success, and never compares to the session's `snapshotRef`.
 */

import type { ProposedChange } from '../contracts/requests.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { LockProvider } from '../adapters/lock.js';
import { SessionError } from './errors.js';
import {
  acquireSafeEditLocks,
  computeSafeEditLockKeys,
  fileLockKey,
  type SafeEditLockKeyCounts,
} from './safeEditLocking.js';
import { writeResolvedChanges } from './applyEditsWrite.js';
import type { ApplyEditsResult, SessionState } from './types.js';

export interface PerformApplyEditsOptions {
  fs: HoplonFsAdapter | null;
  proposedChanges: readonly ProposedChange[];
  fromState: SessionState;
  /**
   * Optional code-intelligence adapter. Required only when a `structural`
   * ProposedChange is submitted; absent for full_file / patch variants.
   */
  codeIntelligence?: CodeIntelligenceAdapter | null;
  /**
   * Optional session-owned lock provider (t-066). When supplied alongside
   * `projectId`, the supervised write path acquires an overlap-aware
   * AST-node lock set for structural variants (plus per-file locks for
   * full_file / patch variants) before any byte touches disk. Pure
   * structural files then take the same per-file key only at the final
   * commit phase so they re-resolve against the latest bytes without
   * widening the initial lock plan to whole-file serialization.
   *
   * When omitted, the write path degrades to lock-free behavior — the
   * session can still apply edits, but concurrent same-file writers do not
   * serialize. The launcher injects a shared in-process `AsyncMutex`-
   * backed provider by default so packaged MCP/HTTP sessions always get
   * node-scoped locks.
   */
  lockProvider?: LockProvider | null;
  /** Project identifier used to namespace lock keys. */
  projectId?: string;
}

/**
 * Internal extension of {@link ApplyEditsResult} that also returns the bytes
 * the supervised write path captured before overwriting each file. The
 * caller (the session) uses this map to compose a post-edit review payload
 * (t-072) without re-reading from git. The captured map is never surfaced
 * on the transport envelope; it stays in-process for review composition.
 */
export interface PerformApplyEditsResult extends ApplyEditsResult {
  readonly capturedBeforeBytes: ReadonlyMap<string, Uint8Array | null>;
  /**
   * Per-kind tally of lock keys the supervised write path acquired for
   * this batch. `nodeKeys + fileKeys === 0` when no lock provider was
   * injected (lock-free degrade) or when the batch was empty. Surfaced
   * only in-process for proofs — the transport envelope continues to
   * carry only `changeKindCounts`.
   */
  readonly lockKeyCounts: SafeEditLockKeyCounts;
}

function computeStructuralCommitKeys(
  proposedChanges: readonly ProposedChange[],
  projectId: string,
  alreadyHeldKeys: readonly string[],
): readonly string[] {
  const kindsByFile = new Map<string, { structural: boolean; other: boolean }>();
  for (const change of proposedChanges) {
    const entry = kindsByFile.get(change.file) ?? { structural: false, other: false };
    if ('kind' in change && change.kind === 'structural') {
      entry.structural = true;
    } else {
      entry.other = true;
    }
    kindsByFile.set(change.file, entry);
  }
  const held = new Set(alreadyHeldKeys);
  return Array.from(kindsByFile.entries())
    .filter(([, kinds]) => kinds.structural && !kinds.other)
    .map(([file]) => fileLockKey(projectId, file))
    .filter((key) => !held.has(key))
    .sort();
}

export async function performApplyEdits(
  opts: PerformApplyEditsOptions,
): Promise<PerformApplyEditsResult> {
  const { fs, proposedChanges, fromState } = opts;
  const codeIntelligence = opts.codeIntelligence ?? null;
  const lockProvider = opts.lockProvider ?? null;
  const projectId = opts.projectId ?? null;
  if (proposedChanges.length === 0) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: fromState,
      attempted: 'applyEdits',
      detail: 'proposedChanges must not be empty',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'proposedChanges',
      },
    });
  }
  if (!fs) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: fromState,
      attempted: 'applyEdits',
      detail: 'fs adapter not injected at session construction',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'fs',
      },
    });
  }
  let lockKeyCounts: SafeEditLockKeyCounts = { nodeKeys: 0, fileKeys: 0 };
  let releaseLocks: (() => void) | null = null;
  let releaseCommitKeys: (() => void) | null = null;
  if (lockProvider !== null && projectId !== null) {
    const plan = await computeSafeEditLockKeys({
      proposedChanges,
      fs,
      codeIntelligence,
      projectId,
    });
    lockKeyCounts = plan.counts;
    releaseLocks = await acquireSafeEditLocks(lockProvider, plan.keys);
    const commitKeys = computeStructuralCommitKeys(
      proposedChanges,
      projectId,
      plan.keys,
    );
    releaseCommitKeys = await acquireSafeEditLocks(lockProvider, commitKeys);
  }
  try {
    const result = await writeResolvedChanges({
      fs,
      proposedChanges,
      fromState,
      codeIntelligence,
    });
    return { ...result, lockKeyCounts };
  } finally {
    if (releaseCommitKeys !== null) releaseCommitKeys();
    if (releaseLocks !== null) releaseLocks();
  }
}
