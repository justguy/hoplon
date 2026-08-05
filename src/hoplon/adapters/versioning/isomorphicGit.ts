import type { HttpClient } from 'isomorphic-git';
import type { HoplonFsAdapter } from '../fs.js';
import type { VersioningAdapter } from '../versioning.js';
import { createFsShim } from './fsShim.js';
import { createLocalGitOperations } from './isomorphicGitLocal.js';
import { createRemoteGitOperations } from './isomorphicGitRemote.js';
import { readLineProvenanceImpl } from './lineProvenance.js';
import {
  diffSnapshotFilesImpl,
  readCommitInfoImpl,
} from './snapshotEvidence.js';
import {
  listFilesAtRefImpl,
  listLocalBranchesImpl,
  listRemoteTrackingBranchesImpl,
  readBlobAtRefImpl,
  resolveCurrentBranchImpl,
  resolveDefaultBranchImpl,
} from './sourceRefInventory.js';
import { changedFilesBetweenRefsImpl } from './treeDiff.js';

export type { HttpClient as IsomorphicGitHttpClient };

/** Compose local, remote, inventory, and snapshot-evidence git operations. */
export function createIsomorphicGitVersioning(opts: {
  fs: HoplonFsAdapter;
  http?: HttpClient;
  disableRemote?: boolean;
}): VersioningAdapter {
  const shim = createFsShim(opts.fs);
  const local = createLocalGitOperations(shim, opts.fs);
  const remote = createRemoteGitOperations(shim, {
    ...(opts.http !== undefined ? { http: opts.http } : {}),
    ...(opts.disableRemote !== undefined ? { disableRemote: opts.disableRemote } : {}),
  });
  return {
    ...local,
    ...remote,
    async listLocalBranches(dir: string) {
      return listLocalBranchesImpl(shim, dir);
    },
    async listRemoteTrackingBranches(dir: string) {
      return listRemoteTrackingBranchesImpl(shim, dir);
    },
    async resolveCurrentBranch(dir: string) {
      return resolveCurrentBranchImpl(shim, dir);
    },
    async resolveDefaultBranch(dir: string) {
      return resolveDefaultBranchImpl(shim, dir);
    },
    async listFilesAtRef(dir: string, ref: string) {
      return listFilesAtRefImpl(shim, dir, ref);
    },
    async readBlobAtRef(dir: string, ref: string, filepath: string) {
      return readBlobAtRefImpl(shim, dir, ref, filepath);
    },
    async diffSnapshotFiles(diffOpts) {
      return diffSnapshotFilesImpl(shim, diffOpts);
    },
    async changedFilesBetweenRefs(treeDiffOpts) {
      return changedFilesBetweenRefsImpl(shim, treeDiffOpts);
    },
    async readCommitInfo(infoOpts) {
      return readCommitInfoImpl(shim, infoOpts);
    },
    async readLineProvenance(lineOpts) {
      return readLineProvenanceImpl(shim, lineOpts);
    },
  };
}
