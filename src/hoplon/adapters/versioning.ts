/**
 * adapters/versioning.ts — VersioningAdapter interface.
 *
 * Capability-focused contract (versioning, not specifically git).
 * Narrow wrapper exposing only the methods Hoplon uses.
 * Never reads .gitconfig. Never invokes a host git binary.
 * Hard-coded committer identity: hoplon-engine <noreply@hoplon.local>
 *
 * push() and fetch() accept a repoDir (the Hoplon git repo to operate on)
 * plus optional credentials for the remote. Phase 3 implements these via
 * isomorphic-git's HTTP transport with onAuth callback.
 */

import type {
  GitRemoteCredentials,
  VersioningBlobAtRef,
  VersioningBranchResolution,
  VersioningFileAtRef,
  VersioningSourceRef,
} from './versioningTypes.js';

export type {
  GitRemoteCredentials,
  VersioningBlobAtRef,
  VersioningBranchResolution,
  VersioningFileAtRef,
  VersioningSourceRef,
  VersioningSourceRefKind,
} from './versioningTypes.js';

export interface VersioningAdapter {
  /** Initialize a git repository at dir. */
  init(dir: string): Promise<void>;
  /** Stage the given paths in dir. */
  add(dir: string, paths: string[]): Promise<void>;
  /** Stage deletions of the given paths in dir. */
  remove(dir: string, paths: string[]): Promise<void>;
  /**
   * hcr-009 — Remove every entry from the staging area (index) so the next
   * commit's tree contains exactly the paths staged after this call. Clears
   * residue left by a crashed staging sequence (add() ran, commit() never
   * did) — including on a repository whose HEAD is still unborn. Committed
   * history and the working directory are untouched.
   */
  clearIndex(dir: string): Promise<void>;
  /**
   * Create a commit in dir with the given message. Returns the commit SHA.
   *
   * @param options.committer.timestamp - Unix epoch seconds for the committer
   *   timestamp. Pass `0` for Hoplon-internal snapshots to ensure identical
   *   manifests produce identical commit SHAs (CF2 — pinned epoch). Omit (or
   *   pass `undefined`) to let isomorphic-git default to `Date.now() / 1000`.
   *   The author timestamp is set to the same value when provided.
   *   Real wall-clock time is preserved separately in the snapshot registry's
   *   `created_at` column — not in the git commit object.
   */
  commit(
    dir: string,
    message: string,
    options?: { committer?: { timestamp?: number } },
  ): Promise<{ sha: string }>;
  /**
   * Checkout a ref in dir.
   * When paths is provided, only those paths are checked out (sparse checkout).
   */
  checkout(dir: string, ref: string, paths?: string[]): Promise<void>;
  /**
   * Returns the status matrix for tracked files.
   * Tuple: [path, HEAD status, workdir status, stage status]
   */
  statusMatrix(
    dir: string,
  ): Promise<Array<[path: string, head: number, workdir: number, stage: number]>>;
  /** Resolve a ref (branch name, tag, 'HEAD', etc.) to a commit SHA. */
  resolveRef(dir: string, ref: string): Promise<string>;

  /**
   * List local branch refs already present in the repository. This never
   * fetches, never shells out to host git, and never mutates checkout state.
   */
  listLocalBranches(dir: string): Promise<ReadonlyArray<VersioningSourceRef>>;

  /**
   * List locally known remote-tracking branch refs. This is an offline
   * inventory of refs/remotes data already present in the repo; fetching is
   * explicit and remains the caller's separate responsibility.
   */
  listRemoteTrackingBranches(
    dir: string,
  ): Promise<ReadonlyArray<VersioningSourceRef>>;

  /**
   * Resolve the currently checked-out branch when HEAD is symbolic. Detached
   * or unavailable branch state returns null.
   */
  resolveCurrentBranch(dir: string): Promise<VersioningBranchResolution | null>;

  /**
   * Resolve the repository default branch when it is represented by HEAD.
   * Detached or unavailable branch state returns null.
   */
  resolveDefaultBranch(dir: string): Promise<VersioningBranchResolution | null>;
  /**
   * Push the given ref from repoDir to a remote URL.
   *
   * On network or auth failure: throws AdapterError({ kind: 'remote_push_failed' }).
   *
   * @param opts.repoDir   - Path to the local Hoplon git repo.
   * @param opts.remote    - Remote URL (HTTPS or file-protocol for testing).
   * @param opts.ref       - Local branch ref to push (e.g. 'main').
   * @param opts.credentials - Optional HTTPS username/password for the remote.
   */
  push(opts: {
    repoDir: string;
    remote: string;
    ref: string;
    credentials?: GitRemoteCredentials;
  }): Promise<void>;
  /**
   * Fetch the given ref from a remote URL into repoDir.
   *
   * On network or auth failure: throws AdapterError({ kind: 'remote_fetch_failed' }).
   *
   * @param opts.repoDir   - Path to the local Hoplon git repo.
   * @param opts.remote    - Remote URL (HTTPS or file-protocol for testing).
   * @param opts.ref       - Remote ref to fetch (e.g. 'main').
   * @param opts.credentials - Optional HTTPS username/password for the remote.
   */
  fetch(opts: {
    repoDir: string;
    remote: string;
    ref: string;
    credentials?: GitRemoteCredentials;
  }): Promise<void>;
  /**
   * Read the raw bytes of a file at a specific commit SHA from the git object
   * store — without performing a checkout.
   *
   * Used by dryRun to load the baseline content for diff comparison without
   * touching the filesystem.
   *
   * @param dir - Path to the git repo directory.
   * @param ref - Commit SHA (or ref resolvable to a commit) to read from.
   * @param filepath - POSIX-style path relative to the repo root.
   * @returns Raw bytes of the file at that ref.
   * @throws {AdapterError} kind 'git_read_failed' if the file is not present at
   *   the given ref (caller interprets as "new file at snapshot time → empty baseline").
   */
  readBlob(dir: string, ref: string, filepath: string): Promise<Uint8Array>;

  /**
   * List files at a ref without checkout mutation. Refs may be branch names,
   * tags, HEAD, or commit SHAs resolvable by the underlying repository.
   */
  listFilesAtRef(
    dir: string,
    ref: string,
  ): Promise<ReadonlyArray<VersioningFileAtRef>>;

  /**
   * Read a blob and return both bytes and the blob object's oid, without
   * checkout mutation.
   */
  readBlobAtRef(
    dir: string,
    ref: string,
    filepath: string,
  ): Promise<VersioningBlobAtRef>;

  /**
   * t-081 — Read the per-file before/after byte payload for a bounded set of
   * filepaths between two snapshot commits, or between one snapshot commit
   * and `null` (meaning "absent / empty baseline" on that side).
   *
   * This is **not** a generic `git diff` porcelain. The adapter refuses
   * anything that is not a bare 40-char lowercase hex commit SHA — branch
   * names, tags, `HEAD`, `HEAD~1`, or relative refs all raise a
   * `ValidationError({ kind: 'invalid_scope' })` at the adapter boundary. The
   * caller supplies the exact set of paths to diff; the adapter never walks
   * the git tree to enumerate additional files. Snapshot-scoped evidence
   * composers render a bounded unified diff on top of the bytes returned
   * here — the adapter itself never emits diff text.
   *
   * On a ref that exists but does not contain a given filepath, that file's
   * side is reported as `null` bytes so callers can distinguish "added" from
   * "removed" vs. "both sides absent" deterministically.
   *
   * @param opts.dir        - Path to the git repo directory.
   * @param opts.fromRef    - 40-char lowercase hex commit SHA for the before-side,
   *                          or `null` to treat every filepath as absent on that side.
   * @param opts.toRef      - 40-char lowercase hex commit SHA for the after-side,
   *                          or `null` to treat every filepath as absent on that side.
   * @param opts.filepaths  - POSIX-style paths relative to the repo root. Order is
   *                          preserved in the result so the caller can anchor output.
   * @returns One entry per input filepath (same order) with the before/after bytes
   *          or `null` when that side has no entry for the path.
   * @throws {ValidationError} kind 'invalid_scope' when `fromRef` or `toRef` is not a
   *   bare 40-char lowercase hex SHA (and not `null`), or when both sides are `null`,
   *   or when `filepaths` is empty, or when any filepath is absolute / contains
   *   `..` segments / has empty segments.
   * @throws {AdapterError} kind 'git_read_failed' on an unknown ref or on an
   *   underlying git-object read failure.
   */
  diffSnapshotFiles(opts: {
    dir: string;
    fromRef: string | null;
    toRef: string | null;
    filepaths: readonly string[];
  }): Promise<
    ReadonlyArray<{
      readonly filepath: string;
      readonly beforeBytes: Uint8Array | null;
      readonly afterBytes: Uint8Array | null;
    }>
  >;

  /**
   * t-128 — Walk two committed git trees and return the bounded set of files
   * whose blob oid or presence changed. This is an optimization primitive for
   * advisory blast-radius sidecars, not a second risk authority.
   *
   * Refs follow the same strict shape as snapshot evidence: each side must be
   * a bare 40-char lowercase commit SHA. Branches, tags, HEAD, and
   * HEAD-relative refs are refused at the adapter boundary.
   */
  changedFilesBetweenRefs(opts: {
    dir: string;
    fromRef: string;
    toRef: string;
  }): Promise<
    ReadonlyArray<{
      readonly filepath: string;
      readonly changeKind: 'added' | 'deleted' | 'modified';
    }>
  >;

  /**
   * t-081 — Read the narrow set of metadata fields on a commit object. Does
   * NOT walk history, does NOT list branches, does NOT read the tree content.
   * Callers that want file bytes at this commit still go through `readBlob`
   * (single file) or `diffSnapshotFiles` (bounded set).
   *
   * Same ref-shape contract as `diffSnapshotFiles`: the ref MUST be a bare
   * 40-char lowercase hex commit SHA. Branch names / tags / `HEAD` are
   * refused at the adapter boundary with a typed `ValidationError`.
   *
   * @param opts.dir - Path to the git repo directory.
   * @param opts.ref - 40-char lowercase hex commit SHA.
   * @returns The commit's own oid (echo of the input ref), its zero-or-more
   *   parent commit oids, the root tree oid, the pinned committer timestamp
   *   (epoch seconds, as stored in the commit object — this is `0` for
   *   Hoplon-internal snapshots per CF2), and the first line of the message.
   * @throws {ValidationError} kind 'invalid_scope' when the ref is not a bare
   *   40-char lowercase hex SHA.
   * @throws {AdapterError} kind 'git_read_failed' when the commit does not exist.
   */
  readCommitInfo(opts: {
    dir: string;
    ref: string;
  }): Promise<{
    readonly oid: string;
    readonly parentOids: readonly string[];
    readonly treeOid: string;
    readonly committerTimestamp: number;
    readonly authorTimestamp: number;
    readonly messageFirstLine: string;
  }>;

  /**
   * t-125 — Return bounded line-range provenance for one file at one snapshot
   * commit. This is not a general history API: callers must provide a bare
   * commit SHA, one repo-relative filepath, and a concrete 1-based line range.
   * The adapter may inspect history for that single path to identify the commit
   * that introduced or last changed the requested range, but it returns at most
   * one bounded provenance record and never lists branches, tags, or unrelated
   * commits.
   */
  readLineProvenance(opts: {
    dir: string;
    ref: string;
    filepath: string;
    lineRange: { startLine: number; endLine: number };
  }): Promise<{
    readonly commitId: string;
    readonly parentOids: readonly string[];
    readonly authorName: string;
    readonly authorTimestamp: number;
    readonly committerTimestamp: number;
    readonly messageFirstLine: string;
    readonly lineRange: { readonly startLine: number; readonly endLine: number };
    readonly provenanceKind: 'line_changed' | 'file_added_at_path';
  }>;
}
