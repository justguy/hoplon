/**
 * session/auditCoverage.ts — hcr-005 Finding 8: derived audit coverage.
 *
 * Audit coverage must be DERIVED, never merely caller-declared. Before the
 * session calls `engine.auditDiff`, the audited file set is widened to the
 * union of:
 *
 *   (a) files the session actually wrote via `applyEdits`,
 *   (b) files the host declared via `markEdited`, and
 *   (c) post-snapshot workspace files discovered through the injected fs
 *       adapter probed against the mcr-008 snapshot presence evidence
 *       (`SnapshotRecord.presencePaths`): files present in the workspace now
 *       but absent at snapshot time, excluding the revert allowlist and the
 *       Hoplon-internal `gitRepoDir` subtree.
 *
 * A session with real post-snapshot uncontracted changes and an empty
 * declared list therefore cannot reach `audited_pass` with zero checked
 * files — the discovered files flow into the audit and produce the
 * appropriate verdict.
 *
 * Fail-safe direction: when discovery is impossible (no fs adapter, no
 * snapshot store, missing record, or a legacy row without presence evidence)
 * the session falls back to declared+written coverage and MARKS the audit
 * evidence as partial (`mode: 'declared_only'` + `partialReason`) instead of
 * silently passing with fabricated full coverage. Discovery failures are
 * likewise surfaced as `partialReason: 'discovery_failed'` — never swallowed
 * into a fake 'derived'.
 *
 * H13: paths only — never file content.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { AuditCoverageEvidence } from '../contracts/audit.js';
import {
  getSnapshotPresence,
  listPostSnapshotPaths,
  listWorkspacePaths,
  normalizeWorkspacePath,
} from '../operations/snapshotPresence.js';
import { pathMatchesAllowlist } from '../operations/revertUncontracted.js';

/**
 * Default trees never audited as post-snapshot discoveries. Mirrors the
 * engine factory's DEFAULT_REVERT_ALLOWLIST: these trees are also never
 * reverted, so discovering them here would only produce unactionable noise
 * (e.g. `.hoplon` db journals written by the engine itself between snapshot
 * and audit). Used only when the session was not constructed with the
 * engine's configured `revertAllowlist` (hcr-009) — when it was, that list
 * is the single source of truth for both revert and coverage exclusion.
 */
const DEFAULT_AUDIT_COVERAGE_ALLOWLIST: readonly string[] = [
  '.git/**',
  'node_modules/**',
  '.hoplon/**',
];

/**
 * Walk-prune counterpart of the effective allowlist. Only patterns of the
 * literal shape `subtree/**` (no glob metacharacters in the prefix) can
 * prune the workspace walk: the allowlist globs are root-anchored
 * (picomatch), so skipping those subtrees discards exactly the paths the
 * post-filter would discard — while avoiding a stat-per-file walk of e.g.
 * `node_modules` on every audit. Any other pattern shape is enforced by the
 * post-filter alone. With the default allowlist this derives exactly
 * ['.git', 'node_modules', '.hoplon'].
 *
 * NOTE: operations/snapshotPresence.ts exports WORKSPACE_WALK_EXCLUDES for the
 * presence walk, which is fixed (not allowlist-derived). This module instead
 * derives its walk excludes from the *effective* revert allowlist so a host's
 * configured `revertAllowlist` stays the single source of truth for both
 * revert and coverage; the DEFAULT trio above is aligned with that constant.
 */
function walkExcludesForAllowlist(allowlist: readonly string[]): string[] {
  const excludes: string[] = [];
  for (const pattern of allowlist) {
    const literalSubtree = /^([^*?[\]{}()!]+)\/\*\*$/.exec(pattern);
    if (literalSubtree?.[1] !== undefined) excludes.push(literalSubtree[1]);
  }
  return excludes;
}

export interface DeriveAuditCoverageOptions {
  /** Session fs adapter; null = host never wired one (markEdited-only host). */
  fs: HoplonFsAdapter | null;
  /** Session snapshot store; null = evidence seam not wired. */
  snapshotStore: SnapshotStore | null;
  /** The session's snapshot ref id (audit is illegal without one). */
  snapshotRefId: string;
  /** Union of applyEdits-written and markEdited-declared files. */
  declaredFiles: readonly string[];
  /** Hoplon-internal git repo dir to exclude from the workspace walk. */
  gitRepoDir: string | null;
  /**
   * The revert allowlist the session's engine was configured with
   * (`HoplonEngineConfig.revertAllowlist`). When non-null it REPLACES the
   * default trio so coverage exclusion and `revertUncontracted` share one
   * source of truth; null = engine runs the factory default.
   */
  revertAllowlist: readonly string[] | null;
}

export interface DerivedAuditCoverage {
  /** Sorted, deduplicated file set to feed `engine.auditDiff`. */
  readonly files: readonly string[];
  /** Evidence attached to the AuditResult (contracts/audit.ts). */
  readonly evidence: AuditCoverageEvidence;
}

function declaredOnly(
  declaredFiles: readonly string[],
  partialReason: NonNullable<AuditCoverageEvidence['partialReason']>,
): DerivedAuditCoverage {
  return {
    files: [...new Set(declaredFiles)].sort(),
    evidence: {
      mode: 'declared_only',
      declaredFileCount: new Set(declaredFiles).size,
      discoveredPostSnapshotFiles: [],
      partialReason,
    },
  };
}

export async function deriveAuditCoverage(
  opts: DeriveAuditCoverageOptions,
): Promise<DerivedAuditCoverage> {
  const { fs, snapshotStore, snapshotRefId, declaredFiles, gitRepoDir } = opts;
  const allowlist = opts.revertAllowlist ?? DEFAULT_AUDIT_COVERAGE_ALLOWLIST;
  if (fs === null) return declaredOnly(declaredFiles, 'fs_not_wired');
  if (snapshotStore === null) {
    return declaredOnly(declaredFiles, 'snapshot_store_not_wired');
  }
  try {
    const record = await snapshotStore.get(snapshotRefId);
    if (record === null) {
      return declaredOnly(declaredFiles, 'snapshot_record_missing');
    }
    const presence = getSnapshotPresence(record);
    if (presence.kind === 'missing') {
      return declaredOnly(declaredFiles, 'presence_evidence_missing');
    }
    const currentPaths = await listWorkspacePaths(fs, {
      excludePrefixes: [
        ...walkExcludesForAllowlist(allowlist),
        ...(gitRepoDir !== null ? [gitRepoDir] : []),
      ],
    });
    const post = listPostSnapshotPaths(presence, currentPaths);
    if (post.status === 'unknown') {
      // Unreachable with kind === 'present' evidence; kept for the closed
      // tri-state contract so a seam change cannot silently fabricate 'derived'.
      return declaredOnly(declaredFiles, 'presence_evidence_missing');
    }
    const declared = new Set(declaredFiles.map(normalizeWorkspacePath));
    const discovered = post.postSnapshotPaths
      .filter((path) => !pathMatchesAllowlist(path, allowlist))
      .filter((path) => !declared.has(path))
      .sort();
    return {
      files: [...new Set([...declared, ...discovered])].sort(),
      evidence: {
        mode: 'derived',
        declaredFileCount: declared.size,
        discoveredPostSnapshotFiles: discovered,
        partialReason: null,
      },
    };
  } catch {
    // Adapter failure during discovery (store read / workspace walk). The
    // audit still runs on declared coverage, but the gap is surfaced as a
    // typed partial reason on the evidence — never silently absorbed.
    return declaredOnly(declaredFiles, 'discovery_failed');
  }
}
