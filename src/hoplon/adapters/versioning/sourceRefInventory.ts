/**
 * adapters/versioning/sourceRefInventory.ts - source repository ref and
 * tree-file inventory helpers for the isomorphic-git VersioningAdapter.
 */

import * as git from 'isomorphic-git';
import type { FsClient } from 'isomorphic-git';
import {
  AdapterError,
  ValidationError,
} from '../../contracts/errors.js';
import type {
  VersioningBlobAtRef,
  VersioningBranchResolution,
  VersioningFileAtRef,
  VersioningSourceRef,
} from '../versioning.js';

const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

export async function listLocalBranchesImpl(
  shim: FsClient,
  dir: string,
): Promise<ReadonlyArray<VersioningSourceRef>> {
  try {
    const branches = await git.listBranches({ fs: shim, dir });
    const rows: VersioningSourceRef[] = [];
    for (const name of branches.sort(compareStrings)) {
      const fullRef = `refs/heads/${name}`;
      const oid = await git.resolveRef({ fs: shim, dir, ref: fullRef });
      rows.push({ kind: 'local_branch', name, fullRef, oid });
    }
    return rows;
  } catch (err) {
    throw wrapGitReadError(err, `git local branch inventory failed at '${dir}'`);
  }
}

export async function listRemoteTrackingBranchesImpl(
  shim: FsClient,
  dir: string,
): Promise<ReadonlyArray<VersioningSourceRef>> {
  try {
    const remotes = await git.listRemotes({ fs: shim, dir });
    const rows: VersioningSourceRef[] = [];
    for (const remote of remotes.sort((a, b) => compareStrings(a.remote, b.remote))) {
      const branches = await git.listBranches({ fs: shim, dir, remote: remote.remote });
      for (const branch of branches.sort(compareStrings)) {
        const fullRef = `refs/remotes/${remote.remote}/${branch}`;
        const oid = await git.resolveRef({ fs: shim, dir, ref: fullRef });
        rows.push({
          kind: 'remote_tracking_branch',
          name: `${remote.remote}/${branch}`,
          fullRef,
          oid,
          remote: remote.remote,
        });
      }
    }
    return rows;
  } catch (err) {
    throw wrapGitReadError(
      err,
      `git remote-tracking branch inventory failed at '${dir}'`,
    );
  }
}

export async function resolveCurrentBranchImpl(
  shim: FsClient,
  dir: string,
): Promise<VersioningBranchResolution | null> {
  return resolveHeadBranch(shim, dir);
}

export async function resolveDefaultBranchImpl(
  shim: FsClient,
  dir: string,
): Promise<VersioningBranchResolution | null> {
  try {
    const branches = await git.listBranches({ fs: shim, dir });
    for (const branch of ['main', 'master']) {
      if (branches.includes(branch)) {
        return resolveNamedLocalBranch(shim, dir, branch);
      }
    }
    return resolveHeadBranch(shim, dir);
  } catch (err) {
    const gitErr = err as { code?: unknown; name?: unknown };
    if (
      gitErr.code === 'NotFoundError' ||
      gitErr.name === 'NotFoundError' ||
      gitErr.code === 'DetachedHeadError' ||
      gitErr.name === 'DetachedHeadError'
    ) {
      return null;
    }
    throw wrapGitReadError(err, `git default branch resolution failed at '${dir}'`);
  }
}

export async function listFilesAtRefImpl(
  shim: FsClient,
  dir: string,
  ref: string,
): Promise<ReadonlyArray<VersioningFileAtRef>> {
  try {
    const commitOid = await git.resolveRef({ fs: shim, dir, ref });
    const filepaths = await git.listFiles({ fs: shim, dir, ref: commitOid });
    const rows: VersioningFileAtRef[] = [];
    for (const filepath of filepaths.sort(compareStrings)) {
      assertRepoRelativeFilepath(filepath);
      const blob = await git.readBlob({ fs: shim, dir, oid: commitOid, filepath });
      rows.push({ filepath, oid: blob.oid });
    }
    return rows;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw wrapGitReadError(err, `git file inventory failed at '${dir}' ref='${ref}'`);
  }
}

export async function readBlobAtRefImpl(
  shim: FsClient,
  dir: string,
  ref: string,
  filepath: string,
): Promise<VersioningBlobAtRef> {
  assertRepoRelativeFilepath(filepath);
  try {
    const commitOid = await git.resolveRef({ fs: shim, dir, ref });
    const result = await git.readBlob({ fs: shim, dir, oid: commitOid, filepath });
    return { oid: result.oid, bytes: new Uint8Array(result.blob) };
  } catch (err) {
    throw wrapGitReadError(
      err,
      `git.readBlob failed at '${dir}' ref='${ref}' filepath='${filepath}'`,
    );
  }
}

async function resolveHeadBranch(
  shim: FsClient,
  dir: string,
): Promise<VersioningBranchResolution | null> {
  try {
    const branch = await git.currentBranch({ fs: shim, dir, fullname: false });
    if (branch === undefined) return null;
    const fullRef = `refs/heads/${branch}`;
    const oid = await git.resolveRef({ fs: shim, dir, ref: fullRef });
    return { name: branch, fullRef, oid };
  } catch (err) {
    const gitErr = err as { code?: unknown; name?: unknown };
    if (
      gitErr.code === 'NotFoundError' ||
      gitErr.name === 'NotFoundError' ||
      gitErr.code === 'DetachedHeadError' ||
      gitErr.name === 'DetachedHeadError'
    ) {
      return null;
    }
    throw wrapGitReadError(err, `git current branch resolution failed at '${dir}'`);
  }
}

async function resolveNamedLocalBranch(
  shim: FsClient,
  dir: string,
  branch: string,
): Promise<VersioningBranchResolution> {
  const fullRef = `refs/heads/${branch}`;
  const oid = await git.resolveRef({ fs: shim, dir, ref: fullRef });
  return { name: branch, fullRef, oid };
}

function assertRepoRelativeFilepath(filepath: string): void {
  if (filepath.length === 0 || filepath.startsWith('/')) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { filepath },
      },
      'versioning adapter: filepath must be relative to the repo root',
    );
  }
  for (const segment of filepath.split('/')) {
    if (segment === '' || segment === '..') {
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: { filepath },
        },
        "versioning adapter: filepath contains a forbidden segment ('..' or empty)",
      );
    }
  }
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function wrapGitReadError(err: unknown, message: string): AdapterError {
  if (err instanceof AdapterError) return err;
  return new AdapterError(
    {
      kind: 'git_read_failed',
      engineId: ADAPTER_ENGINE_ID,
      correlationId: ADAPTER_CORRELATION_ID,
      cause: err,
    },
    message,
  );
}
