/**
 * adapters/versioning/snapshotEvidence.ts — t-081 snapshot-scoped evidence
 * primitives for the isomorphic-git versioning adapter.
 *
 * This module owns the adapter-side work for `diffSnapshotFiles` and
 * `readCommitInfo`. It is deliberately kept narrow:
 *
 *   - Refuses every ref that is not a bare 40-char lowercase hex commit SHA.
 *     Branch names, tags, `HEAD`, `HEAD~1`, and `sha256:<hex>` prefixes all
 *     produce a typed `ValidationError({ kind: 'invalid_scope' })` at the
 *     adapter boundary — the evidence surface never becomes a generic git
 *     porcelain.
 *   - Never emits diff text. `diffSnapshotFiles` returns per-file before /
 *     after bytes; the session-facing composer renders the unified diff on
 *     top of those bytes with the existing `renderUnifiedDiff` helper.
 *   - Never walks history, lists branches, enumerates tags, or reads tree
 *     content. `readCommitInfo` returns a hand-picked narrow subset of
 *     commit-object fields plus the first line of the message (multi-line
 *     bodies are clipped so they cannot leak through the narrow surface).
 *
 * Lives beside `isomorphicGit.ts` so the main adapter file stays under the
 * 300-line architecture limit (AGENTS.md §Architecture Laws #1). The
 * composed adapter is still a single object — callers never import this
 * file directly.
 */

import * as git from 'isomorphic-git';
import type { FsClient } from 'isomorphic-git';
import { AdapterError, ValidationError } from '../../contracts/errors.js';

/**
 * t-081 — Accept only bare 40-char lowercase hex commit SHAs at the adapter
 * boundary of the snapshot-evidence helpers. Deliberately narrower than
 * `readBlob`, which accepts any ref isomorphic-git can resolve (including
 * branches, tags, and `HEAD`).
 */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

function assertCommitSha(
  ref: string,
  label: 'fromRef' | 'toRef' | 'ref',
): void {
  if (!COMMIT_SHA_PATTERN.test(ref)) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { [label]: ref },
      },
      `versioning adapter: ${label} must be a bare 40-char lowercase hex commit SHA (refs, branches, tags, HEAD, HEAD-relative, and sha256:<hex> prefixes are not accepted here)`,
    );
  }
}

function assertFilepath(filepath: string, index: number): void {
  if (filepath.length === 0) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { index },
      },
      `versioning adapter: filepaths[${index}] is empty`,
    );
  }
  if (filepath.startsWith('/')) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { index, filepath },
      },
      `versioning adapter: filepaths[${index}] is absolute; expected a path relative to the repo root`,
    );
  }
  const segments = filepath.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '') {
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: { index, filepath },
        },
        `versioning adapter: filepaths[${index}] contains a forbidden segment ('..' or empty)`,
      );
    }
  }
}

export interface DiffSnapshotFilesOpts {
  readonly dir: string;
  readonly fromRef: string | null;
  readonly toRef: string | null;
  readonly filepaths: readonly string[];
}

export interface DiffSnapshotFilesEntry {
  readonly filepath: string;
  readonly beforeBytes: Uint8Array | null;
  readonly afterBytes: Uint8Array | null;
}

export async function diffSnapshotFilesImpl(
  shim: FsClient,
  diffOpts: DiffSnapshotFilesOpts,
): Promise<ReadonlyArray<DiffSnapshotFilesEntry>> {
  if (diffOpts.fromRef === null && diffOpts.toRef === null) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { fromRef: null, toRef: null },
      },
      'versioning adapter: diffSnapshotFiles requires at least one of fromRef or toRef to be a commit SHA',
    );
  }
  if (diffOpts.filepaths.length === 0) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { filepaths: [] },
      },
      'versioning adapter: diffSnapshotFiles requires a non-empty filepaths list',
    );
  }
  if (diffOpts.fromRef !== null) assertCommitSha(diffOpts.fromRef, 'fromRef');
  if (diffOpts.toRef !== null) assertCommitSha(diffOpts.toRef, 'toRef');
  for (let i = 0; i < diffOpts.filepaths.length; i += 1) {
    const fp = diffOpts.filepaths[i];
    if (fp === undefined) {
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: { index: i },
        },
        `versioning adapter: filepaths[${i}] is undefined`,
      );
    }
    assertFilepath(fp, i);
  }

  async function readSide(ref: string | null, filepath: string): Promise<Uint8Array | null> {
    if (ref === null) return null;
    try {
      const result = await git.readBlob({ fs: shim, dir: diffOpts.dir, oid: ref, filepath });
      return new Uint8Array(result.blob);
    } catch (err) {
      // Distinguish missing-file-at-ref (treat as null bytes → added/deleted
      // render) from "the ref itself is unknown" (the commit does not
      // exist; callers must see that as an adapter failure).
      const errObj = err as { code?: unknown; name?: unknown };
      const code = typeof errObj?.code === 'string' ? errObj.code : '';
      const name = typeof errObj?.name === 'string' ? errObj.name : '';
      if (
        code === 'NotFoundError' ||
        code === 'ObjectTypeError' ||
        name === 'NotFoundError'
      ) {
        // Probe the commit itself to tell "missing blob at a resolvable
        // tree" apart from "unknown commit SHA" deterministically.
        try {
          await git.readCommit({ fs: shim, dir: diffOpts.dir, oid: ref });
        } catch (commitErr) {
          throw new AdapterError(
            {
              kind: 'git_read_failed',
              engineId: ADAPTER_ENGINE_ID,
              correlationId: ADAPTER_CORRELATION_ID,
              cause: commitErr,
            },
            `git.readCommit failed at '${diffOpts.dir}' ref='${ref}' (unknown commit)`,
          );
        }
        return null;
      }
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(
        {
          kind: 'git_read_failed',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: err,
        },
        `git.readBlob failed at '${diffOpts.dir}' ref='${ref}' filepath='${filepath}'`,
      );
    }
  }

  const result: DiffSnapshotFilesEntry[] = [];
  for (const filepath of diffOpts.filepaths) {
    const beforeBytes = await readSide(diffOpts.fromRef, filepath);
    const afterBytes = await readSide(diffOpts.toRef, filepath);
    result.push({ filepath, beforeBytes, afterBytes });
  }
  return result;
}

export interface ReadCommitInfoOpts {
  readonly dir: string;
  readonly ref: string;
}

export interface ReadCommitInfoResult {
  readonly oid: string;
  readonly parentOids: readonly string[];
  readonly treeOid: string;
  readonly committerTimestamp: number;
  readonly authorTimestamp: number;
  readonly messageFirstLine: string;
}

export async function readCommitInfoImpl(
  shim: FsClient,
  infoOpts: ReadCommitInfoOpts,
): Promise<ReadCommitInfoResult> {
  assertCommitSha(infoOpts.ref, 'ref');
  try {
    const result = await git.readCommit({
      fs: shim,
      dir: infoOpts.dir,
      oid: infoOpts.ref,
    });
    const message = result.commit.message ?? '';
    const firstNewline = message.indexOf('\n');
    const messageFirstLine =
      firstNewline === -1 ? message : message.slice(0, firstNewline);
    return {
      oid: result.oid,
      parentOids: [...(result.commit.parent ?? [])],
      treeOid: result.commit.tree,
      committerTimestamp: result.commit.committer.timestamp,
      authorTimestamp: result.commit.author.timestamp,
      messageFirstLine,
    };
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    if (err instanceof ValidationError) throw err;
    throw new AdapterError(
      {
        kind: 'git_read_failed',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: err,
      },
      `git.readCommit failed at '${infoOpts.dir}' ref='${infoOpts.ref}'`,
    );
  }
}
