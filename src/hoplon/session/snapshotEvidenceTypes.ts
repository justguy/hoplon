/**
 * session/snapshotEvidenceTypes.ts — t-081 DTO types for the narrow
 * snapshot-scoped Git evidence surface.
 *
 * Extracted from `snapshotEvidence.ts` so that file stays under the
 * architecture size limit. The composer implementation imports every type
 * declared here.
 */

import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';

/**
 * The bounded v1 operation selector. The union is explicit so future ops
 * (e.g. 'blame', 'history') must be added deliberately — they cannot
 * silently fall through a permissive string input.
 */
export type SnapshotEvidenceKind = 'diff' | 'provenance' | 'line_provenance';

export interface SnapshotEvidenceDiffRequest {
  readonly kind: 'diff';
  /** The snapshot to anchor the diff against. Must be the session's own snapshotRefId. */
  readonly fromSnapshotRefId: string;
  /**
   * The compare target. Either another committed snapshotRefId (same
   * projectId + runId required) or the string `'live'` for a
   * snapshot-vs-live-tree comparison.
   */
  readonly to: string | 'live';
  /**
   * Optional narrow filepath filter. When omitted, every file in the
   * from-snapshot's manifest is included. When provided, each entry must
   * already be owned by the from-snapshot's manifest — foreign filepaths
   * are rejected with ValidationError.
   */
  readonly files?: readonly string[];
  /** Number of context lines around each hunk. Default: 3. */
  readonly contextLines?: number;
}

export interface SnapshotEvidenceProvenanceRequest {
  readonly kind: 'provenance';
  /** The snapshot to describe. Must be the session's own snapshotRefId. */
  readonly snapshotRefId: string;
}

export type SnapshotEvidenceLineTarget =
  | {
      readonly kind: 'line_range';
      readonly lineRange: { readonly startLine: number; readonly endLine: number };
    }
  | {
      readonly kind: 'syntax_node';
      readonly syntaxNode: {
        readonly nodeKind?: string;
        readonly byteRange?: readonly [number, number];
        readonly lineRange: { readonly startLine: number; readonly endLine: number };
      };
    };

export interface SnapshotEvidenceLineProvenanceRequest {
  readonly kind: 'line_provenance';
  /** The snapshot to investigate. Must be the session's own snapshotRefId. */
  readonly snapshotRefId: string;
  /** Repo-relative path owned by the snapshot manifest. */
  readonly file: string;
  /** Concrete line range, or a syntax-node identifier carrying its line range. */
  readonly target: SnapshotEvidenceLineTarget;
}

export type SnapshotEvidenceRequest =
  | SnapshotEvidenceDiffRequest
  | SnapshotEvidenceProvenanceRequest
  | SnapshotEvidenceLineProvenanceRequest;

export interface SnapshotEvidenceDiffFileEntry {
  readonly filepath: string;
  /** 'added' — present on to-side but not from-side. */
  readonly status: 'added' | 'removed' | 'modified' | 'unchanged';
  /** Deterministic unified-diff text for this file. May be '' when status is 'unchanged'. */
  readonly unifiedDiff: string;
  /** Number of bytes on the from-side (null when file is absent there). */
  readonly beforeByteLength: number | null;
  /** Number of bytes on the to-side (null when file is absent there). */
  readonly afterByteLength: number | null;
}

export interface SnapshotEvidenceDiffResult {
  readonly kind: 'diff';
  readonly fromSnapshotRefId: string;
  /** Either the to-side snapshotRefId, or the literal `'live'` sentinel. */
  readonly toSnapshotRefId: string | 'live';
  readonly files: readonly SnapshotEvidenceDiffFileEntry[];
  /** Generated-at ISO 8601 (wall clock at composition time). */
  readonly generatedAt: string;
}

export interface SnapshotEvidenceProvenanceResult {
  readonly kind: 'provenance';
  readonly snapshotRefId: string;
  /** The raw 40-char lowercase hex git commit SHA this snapshot points at. */
  readonly snapshotGitCommitSha: string;
  readonly engineId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly manifestSchemaVersion: number;
  readonly status: 'pending' | 'committed' | 'failed';
  readonly createdAt: string;
  readonly ttlExpires: string | null;
  readonly manifestEntryCount: number;
  /** Narrow commit-object metadata. Never includes the body past the first line. */
  readonly commit: {
    readonly treeOid: string;
    readonly parentOids: readonly string[];
    readonly committerTimestamp: number;
    readonly authorTimestamp: number;
    readonly messageFirstLine: string;
  };
  /** Generated-at ISO 8601 (wall clock at composition time). */
  readonly generatedAt: string;
}

export interface SnapshotEvidenceLineProvenanceResult {
  readonly kind: 'line_provenance';
  readonly snapshotRefId: string;
  readonly snapshotGitCommitSha: string;
  readonly file: string;
  readonly target: SnapshotEvidenceLineTarget;
  readonly lineRange: { readonly startLine: number; readonly endLine: number };
  readonly commit: {
    readonly commitId: string;
    readonly parentOids: readonly string[];
    readonly authorName: string;
    readonly authorTimestamp: number;
    readonly committerTimestamp: number;
    readonly messageFirstLine: string;
  };
  readonly provenanceKind: 'line_changed' | 'file_added_at_path';
  readonly generatedAt: string;
}

export type SnapshotEvidenceResult =
  | SnapshotEvidenceDiffResult
  | SnapshotEvidenceProvenanceResult
  | SnapshotEvidenceLineProvenanceResult;

/**
 * Composer input — the narrow contract the session method and the
 * session-adjacent helper both use. Wraps every dependency the composer
 * needs so the wiring stays explicit and testable in isolation.
 */
export interface ComposeSnapshotEvidenceInput {
  /** Read-side of the git object store (readBlob / diffSnapshotFiles / readCommitInfo). */
  readonly versioning: VersioningAdapter;
  /** Authoritative snapshot-row source — enforces project/run scoping. */
  readonly snapshotStore: SnapshotStore;
  /** Optional fs adapter — required when `to: 'live'` is requested. */
  readonly fs: HoplonFsAdapter | null;
  /** The Hoplon-internal git repo dir (matches engine config). */
  readonly gitRepoDir: string;
  /** Identity of the session composing evidence — anchors the result. */
  readonly sessionId: string;
  /** Project scope enforced on both snapshots in a cross-snapshot diff. */
  readonly projectId: string;
  readonly runId: string;
  /** correlationId forwarded to semantic errors raised by this path. */
  readonly correlationId: string;
  /** engineId forwarded to semantic errors raised by this path. */
  readonly engineId: string;
  /** Wall-clock provider for generatedAt ISO strings. */
  readonly now: () => number;
  /** The evidence request. */
  readonly request: SnapshotEvidenceRequest;
  /**
   * Explicit session snapshotRefId. Every request must anchor on this id
   * (applies to `fromSnapshotRefId` for diff and `snapshotRefId` for
   * provenance). This enforces the "snapshot-scoped" DoD: evidence can
   * never be pulled for a snapshot this session did not actually take.
   */
  readonly sessionSnapshotRefId: string;
}
