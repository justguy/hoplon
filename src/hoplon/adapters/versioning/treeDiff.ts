/**
 * adapters/versioning/treeDiff.ts - t-128 committed-tree changed-file walk.
 */

import * as git from 'isomorphic-git';
import type { FsClient, TreeEntry } from 'isomorphic-git';
import { AdapterError, ValidationError } from '../../contracts/errors.js';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

export interface ChangedFilesBetweenRefsOpts {
  readonly dir: string;
  readonly fromRef: string;
  readonly toRef: string;
}

export interface ChangedFileEntry {
  readonly filepath: string;
  readonly changeKind: 'added' | 'deleted' | 'modified';
}

export async function changedFilesBetweenRefsImpl(
  shim: FsClient,
  opts: ChangedFilesBetweenRefsOpts,
): Promise<ReadonlyArray<ChangedFileEntry>> {
  assertCommitSha(opts.fromRef, 'fromRef');
  assertCommitSha(opts.toRef, 'toRef');

  try {
    const before = await collectCommitFiles(shim, opts.dir, opts.fromRef);
    const after = await collectCommitFiles(shim, opts.dir, opts.toRef);
    const rows: ChangedFileEntry[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const filepath of paths) {
      const beforeOid = before.get(filepath);
      const afterOid = after.get(filepath);
      if (beforeOid === undefined && afterOid !== undefined) {
        rows.push({ filepath, changeKind: 'added' });
      } else if (beforeOid !== undefined && afterOid === undefined) {
        rows.push({ filepath, changeKind: 'deleted' });
      } else if (beforeOid !== afterOid) {
        rows.push({ filepath, changeKind: 'modified' });
      }
    }
    return rows.sort((a, b) =>
      a.filepath.localeCompare(b.filepath),
    );
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AdapterError) throw err;
    throw new AdapterError(
      {
        kind: 'git_read_failed',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: err,
      },
      `git tree diff failed at '${opts.dir}' fromRef='${opts.fromRef}' toRef='${opts.toRef}'`,
    );
  }
}

async function collectCommitFiles(
  shim: FsClient,
  dir: string,
  oid: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await collectTreeFiles(shim, dir, oid, '', out);
  return out;
}

async function collectTreeFiles(
  shim: FsClient,
  dir: string,
  oid: string,
  prefix: string,
  out: Map<string, string>,
): Promise<void> {
  const { tree } = await git.readTree({ fs: shim, dir, oid });
  for (const entry of tree) {
    const filepath = prefix.length > 0 ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'tree') {
      await collectTreeFiles(shim, dir, entry.oid, filepath, out);
      continue;
    }
    if (isComparableEntry(entry)) {
      out.set(filepath, entry.oid);
    }
  }
}

function assertCommitSha(ref: string, label: 'fromRef' | 'toRef'): void {
  if (!COMMIT_SHA_PATTERN.test(ref)) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { [label]: ref },
      },
      `versioning adapter: ${label} must be a bare 40-char lowercase commit SHA`,
    );
  }
}

function isComparableEntry(entry: TreeEntry): boolean {
  return entry.type === 'blob' || entry.type === 'commit';
}
