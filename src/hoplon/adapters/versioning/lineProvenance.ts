/**
 * Bounded line-range provenance for the isomorphic-git versioning adapter.
 *
 * The public adapter method accepts one commit SHA, one filepath, and one
 * concrete line range. It may inspect that file's history to find the commit
 * that introduced or last changed the requested range, but it never exposes a
 * commit list or unrelated repository history.
 */

import * as git from 'isomorphic-git';
import type { FsClient } from 'isomorphic-git';
import { AdapterError, ValidationError } from '../../contracts/errors.js';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

export interface ReadLineProvenanceOpts {
  readonly dir: string;
  readonly ref: string;
  readonly filepath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number };
}

export interface ReadLineProvenanceResult {
  readonly commitId: string;
  readonly parentOids: readonly string[];
  readonly authorName: string;
  readonly authorTimestamp: number;
  readonly committerTimestamp: number;
  readonly messageFirstLine: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number };
  readonly provenanceKind: 'line_changed' | 'file_added_at_path';
}

export async function readLineProvenanceImpl(
  shim: FsClient,
  opts: ReadLineProvenanceOpts,
): Promise<ReadLineProvenanceResult> {
  validateInput(opts);
  const targetLines = await readLinesAt(shim, opts.dir, opts.ref, opts.filepath);
  const targetRangeLines = selectRange(targetLines, opts.lineRange, opts.filepath);
  try {
    const commits = await git.log({
      fs: shim,
      dir: opts.dir,
      ref: opts.ref,
      filepath: opts.filepath,
      follow: false,
    });
    for (const entry of commits) {
      const commitLines = await readLinesOrNull(shim, opts.dir, entry.oid, opts.filepath);
      if (commitLines === null) continue;
      if (!containsLineBlock(commitLines, targetRangeLines)) {
        continue;
      }
      const parentOids = entry.commit.parent ?? [];
      if (parentOids.length === 0) {
        return toResult(entry, opts.lineRange, 'file_added_at_path');
      }
      for (const parentOid of parentOids) {
        const parentLines = await readLinesOrNull(shim, opts.dir, parentOid, opts.filepath);
        if (parentLines === null) {
          return toResult(entry, opts.lineRange, 'file_added_at_path');
        }
        if (!containsLineBlock(parentLines, targetRangeLines)) {
          return toResult(entry, opts.lineRange, 'line_changed');
        }
      }
    }
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
      `git.log failed at '${opts.dir}' ref='${opts.ref}' filepath='${opts.filepath}'`,
    );
  }
  throw new AdapterError(
    {
      kind: 'git_read_failed',
      engineId: ADAPTER_ENGINE_ID,
      correlationId: ADAPTER_CORRELATION_ID,
      cause: { ref: opts.ref, filepath: opts.filepath, lineRange: opts.lineRange },
    },
    `line provenance could not find history for '${opts.filepath}' at '${opts.ref}'`,
  );
}

function validateInput(opts: ReadLineProvenanceOpts): void {
  if (!COMMIT_SHA_PATTERN.test(opts.ref)) {
    throw invalidScope(`line provenance ref must be a bare 40-char lowercase hex commit SHA`, {
      ref: opts.ref,
    });
  }
  assertFilepath(opts.filepath);
  const { startLine, endLine } = opts.lineRange;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw invalidScope('line provenance requires a 1-based line range with endLine >= startLine', {
      lineRange: opts.lineRange,
    });
  }
}

function assertFilepath(filepath: string): void {
  if (filepath.length === 0 || filepath.startsWith('/')) {
    throw invalidScope('line provenance filepath must be repo-relative', { filepath });
  }
  for (const segment of filepath.split('/')) {
    if (segment === '' || segment === '..') {
      throw invalidScope("line provenance filepath contains a forbidden segment ('..' or empty)", {
        filepath,
      });
    }
  }
}

async function readLinesAt(
  shim: FsClient,
  dir: string,
  ref: string,
  filepath: string,
): Promise<readonly string[]> {
  const bytes = await readBlobOrNull(shim, dir, ref, filepath);
  if (bytes === null) {
    throw new AdapterError(
      {
        kind: 'git_read_failed',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { ref, filepath },
      },
      `line provenance file '${filepath}' is absent at '${ref}'`,
    );
  }
  return splitLines(bytes);
}

async function readLinesOrNull(
  shim: FsClient,
  dir: string,
  ref: string,
  filepath: string,
): Promise<readonly string[] | null> {
  const bytes = await readBlobOrNull(shim, dir, ref, filepath);
  return bytes === null ? null : splitLines(bytes);
}

async function readBlobOrNull(
  shim: FsClient,
  dir: string,
  ref: string,
  filepath: string,
): Promise<Uint8Array | null> {
  try {
    const result = await git.readBlob({ fs: shim, dir, oid: ref, filepath });
    return new Uint8Array(result.blob);
  } catch (err) {
    const errObj = err as { code?: unknown; name?: unknown };
    const code = typeof errObj?.code === 'string' ? errObj.code : '';
    const name = typeof errObj?.name === 'string' ? errObj.name : '';
    if (code === 'NotFoundError' || code === 'ObjectTypeError' || name === 'NotFoundError') {
      try {
        await git.readCommit({ fs: shim, dir, oid: ref });
      } catch (commitErr) {
        throw new AdapterError(
          {
            kind: 'git_read_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: commitErr,
          },
          `git.readCommit failed at '${dir}' ref='${ref}' (unknown commit)`,
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
      `git.readBlob failed at '${dir}' ref='${ref}' filepath='${filepath}'`,
    );
  }
}

function splitLines(bytes: Uint8Array): readonly string[] {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).split(/\r?\n/);
}

function selectRange(
  lines: readonly string[],
  range: { readonly startLine: number; readonly endLine: number },
  filepath: string,
): readonly string[] {
  if (range.endLine > lines.length) {
    throw invalidScope('line provenance line range is outside the file at the requested ref', {
      filepath,
      lineCount: lines.length,
      lineRange: range,
    });
  }
  const selected: string[] = [];
  for (let index = range.startLine - 1; index < range.endLine; index += 1) {
    selected.push(lines[index] ?? '');
  }
  return selected;
}

function containsLineBlock(lines: readonly string[], block: readonly string[]): boolean {
  if (block.length === 0 || block.length > lines.length) return false;
  for (let offset = 0; offset <= lines.length - block.length; offset += 1) {
    let matched = true;
    for (let index = 0; index < block.length; index += 1) {
      if (lines[offset + index] !== block[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function toResult(
  entry: Awaited<ReturnType<typeof git.log>>[number],
  lineRange: { readonly startLine: number; readonly endLine: number },
  provenanceKind: ReadLineProvenanceResult['provenanceKind'],
): ReadLineProvenanceResult {
  const messageFirstLine = entry.commit.message.split(/\r?\n/, 1)[0] ?? '';
  return {
    commitId: entry.oid,
    parentOids: [...(entry.commit.parent ?? [])],
    authorName: entry.commit.author.name,
    authorTimestamp: entry.commit.author.timestamp,
    committerTimestamp: entry.commit.committer.timestamp,
    messageFirstLine,
    lineRange,
    provenanceKind,
  };
}

function invalidScope(message: string, cause: unknown): ValidationError {
  return new ValidationError(
    {
      kind: 'invalid_scope',
      engineId: ADAPTER_ENGINE_ID,
      correlationId: ADAPTER_CORRELATION_ID,
      cause,
    },
    message,
  );
}
