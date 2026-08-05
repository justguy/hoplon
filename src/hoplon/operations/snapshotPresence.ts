/**
 * operations/snapshotPresence.ts — mcr-008 snapshot presence evidence.
 *
 * A snapshot commit contains manifest files only, so "was this file present
 * at snapshot time" can NEVER be answered from the commit tree for
 * non-manifest files. Presence evidence is instead a paths-only workspace
 * listing captured through the fs adapter at snapshot time and stored on the
 * snapshot record (`SnapshotRecord.presencePaths`).
 *
 * Consumers:
 *   - createSnapshot captures the listing via `listWorkspacePaths` and writes
 *     it onto the Phase A pending row.
 *   - revertUncontracted probes its post-snapshot deletions against the
 *     evidence via `getSnapshotPresence` / `wasPresentAtSnapshot`.
 *   - session audit (peer workstream) discovers post-snapshot uncontracted
 *     files via `listPostSnapshotPaths` using only the snapshot store record
 *     and an fs adapter — no versioning adapter required.
 *
 * Fail-safe direction: when evidence is missing (snapshot predates mcr-008),
 * presence is 'unknown' — callers must treat unknown-presence files as
 * pre-existing and MUST NOT delete them. Deletion is the dangerous direction.
 *
 * H13: paths only — never file content, never emitted into events.
 *
 * ## Import wall
 *   Imports only from ../adapters/*, ../contracts/*, ../util/*.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';

// ---------------------------------------------------------------------------
// Walk-exclude seam (hcr-009)
// ---------------------------------------------------------------------------

/**
 * Trees pruned from presence/audit workspace walks (hcr-009). Single source
 * of truth consumed by createSnapshot's presence capture AND by
 * session/auditCoverage.ts's discovery walk. These are the same trees the
 * engine factory's DEFAULT_REVERT_ALLOWLIST protects from deletion, so
 * pruning them changes no revert or audit decision — it only avoids a
 * stat-per-entry walk of `node_modules`/`.git` on every snapshot and
 * multi-MB presence_paths rows. Consequence: files under these trees probe
 * as 'absent' in presence evidence; consumers must keep them
 * allowlist-protected rather than presence-protected.
 */
export const WORKSPACE_WALK_EXCLUDES = ['.git', 'node_modules', '.hoplon'] as const;

// ---------------------------------------------------------------------------
// Evidence types
// ---------------------------------------------------------------------------

/** Presence evidence recorded at snapshot time (paths-only, sorted). */
export interface SnapshotPresenceKnown {
  readonly kind: 'present';
  /** Workspace-relative paths of every file present at snapshot time. */
  readonly paths: ReadonlySet<string>;
}

/** Snapshot predates mcr-008 — presence of non-manifest files is unknowable. */
export interface SnapshotPresenceMissing {
  readonly kind: 'missing';
}

export type SnapshotPresence = SnapshotPresenceKnown | SnapshotPresenceMissing;

// ---------------------------------------------------------------------------
// Evidence access
// ---------------------------------------------------------------------------

/** Strip leading './' or '/' so probes match the stored relative form. */
export function normalizeWorkspacePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\//, '');
}

/**
 * Read the presence evidence off a snapshot record.
 * `presencePaths` null or absent (legacy snapshot) → `{ kind: 'missing' }`.
 */
export function getSnapshotPresence(
  record: Pick<SnapshotRecord, 'presencePaths'>,
): SnapshotPresence {
  const paths = record.presencePaths;
  if (paths == null) return { kind: 'missing' };
  return { kind: 'present', paths: new Set(paths.map(normalizeWorkspacePath)) };
}

/**
 * Was `path` present in the workspace at snapshot time?
 *
 * Closed tri-state so the fail-safe cannot be collapsed into a boolean:
 *   - 'present' — file existed at snapshot time (pre-existing; never delete)
 *   - 'absent'  — file did not exist (a post-snapshot creation)
 *   - 'unknown' — no evidence (legacy snapshot); treat as pre-existing
 */
export function wasPresentAtSnapshot(
  presence: SnapshotPresence,
  path: string,
): 'present' | 'absent' | 'unknown' {
  if (presence.kind === 'missing') return 'unknown';
  return presence.paths.has(normalizeWorkspacePath(path)) ? 'present' : 'absent';
}

/**
 * From a current workspace listing, the paths created after the snapshot.
 * Only answerable when evidence exists: `{ status: 'unknown' }` means the
 * caller must not treat any current path as post-snapshot.
 */
export function listPostSnapshotPaths(
  presence: SnapshotPresence,
  currentPaths: readonly string[],
): { status: 'known'; postSnapshotPaths: string[] } | { status: 'unknown' } {
  if (presence.kind === 'missing') return { status: 'unknown' };
  const postSnapshotPaths = currentPaths
    .map(normalizeWorkspacePath)
    .filter((path) => !presence.paths.has(path));
  return { status: 'known', postSnapshotPaths };
}

// ---------------------------------------------------------------------------
// Workspace listing (capture + audit enumeration)
// ---------------------------------------------------------------------------

/**
 * Recursively list all files under the fs adapter root as sorted
 * workspace-relative paths (e.g. 'src/foo.ts', '.git/HEAD').
 *
 * `excludePrefixes` prunes whole subtrees (prefix match on the directory
 * path) — createSnapshot uses it to keep the Hoplon-internal gitRepoDir out
 * of the recorded evidence. The listing is paths-only; no content is read.
 */
export async function listWorkspacePaths(
  fs: HoplonFsAdapter,
  opts?: { excludePrefixes?: readonly string[] },
): Promise<string[]> {
  const excludePrefixes = (opts?.excludePrefixes ?? []).map(normalizeWorkspacePath);
  const result: string[] = [];
  await _walk(fs, '', excludePrefixes, result);
  result.sort();
  return result;
}

async function _walk(
  fs: HoplonFsAdapter,
  dirPath: string,
  excludePrefixes: readonly string[],
  result: string[],
): Promise<void> {
  const entries = await fs.list(dirPath);
  for (const entry of entries) {
    const fullPath = dirPath.length > 0 ? `${dirPath}/${entry}` : entry;
    if (excludePrefixes.some((p) => fullPath === p || fullPath.startsWith(`${p}/`))) {
      continue;
    }
    const statResult = await fs.stat(fullPath);
    if (!statResult.exists) continue;
    if (statResult.isFile) {
      result.push(fullPath);
    } else {
      await _walk(fs, fullPath, excludePrefixes, result);
    }
  }
}
