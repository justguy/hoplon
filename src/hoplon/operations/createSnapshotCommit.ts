import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { WritableManifest } from '../contracts/manifest.js';
import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../contracts/errors.js';
import type { ManifestEntryBytes } from './createSnapshotIdentity.js';
import { createSnapshotErrorMessage } from './createSnapshotErrors.js';

interface CommitSnapshotArgs {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  manifest: WritableManifest;
  reads: ManifestEntryBytes[];
  snapshotId: string;
  engineId: string;
  gitRepoDir: string;
  gitRepoDirRelative: string;
}

export async function commitSnapshotTree(
  args: CommitSnapshotArgs,
): Promise<string> {
  const {
    fs,
    versioning,
    snapshotStore,
    manifest,
    reads,
    snapshotId,
    engineId,
    gitRepoDir,
    gitRepoDirRelative,
  } = args;
  try {
    let needsInit = false;
    try {
      await versioning.resolveRef(gitRepoDir, 'HEAD');
    } catch {
      needsInit = true;
    }
    if (needsInit) await versioning.init(gitRepoDir);
    await versioning.clearIndex(gitRepoDir);

    if (!needsInit) {
      const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
      const trackedAtHead = await versioning.listFilesAtRef(gitRepoDir, 'HEAD');
      const stalePaths = trackedAtHead
        .map((file) => file.filepath)
        .filter((path) => !manifestPaths.has(path));
      if (stalePaths.length > 0) {
        await versioning.remove(gitRepoDir, stalePaths);
      }
    }

    for (const read of reads) {
      const destination =
        gitRepoDirRelative.length > 0
          ? `${gitRepoDirRelative}/${read.path}`
          : read.path;
      if (read.bytes !== null) {
        await fs.write(destination, read.bytes);
        await versioning.add(gitRepoDir, [read.path]);
      } else {
        await versioning.remove(gitRepoDir, [read.path]);
      }
    }
    const commit = await versioning.commit(
      gitRepoDir,
      `hoplon-snapshot ${snapshotId}`,
      { committer: { timestamp: 0 } },
    );
    return commit.sha;
  } catch (cause) {
    await markCommitFailure(snapshotStore, snapshotId, cause);
    if (
      cause instanceof AdapterError ||
      cause instanceof EngineError ||
      cause instanceof SemanticError ||
      cause instanceof ValidationError
    ) {
      if (
        cause instanceof AdapterError &&
        (cause.kind === 'git_commit_failed' || cause.kind === 'fs_read_failed')
      ) {
        throw cause;
      }
      throw new AdapterError(
        {
          kind: 'git_commit_failed',
          engineId,
          correlationId: manifest.correlationId,
          cause,
        },
        `createSnapshot: Phase B (git commit) failed: ${cause.message}`,
      );
    }
    throw new AdapterError(
      {
        kind: 'git_commit_failed',
        engineId,
        correlationId: manifest.correlationId,
        cause,
      },
      `createSnapshot: Phase B (git commit) failed: ${createSnapshotErrorMessage(cause)}`,
    );
  }
}

async function markCommitFailure(
  snapshotStore: SnapshotStore,
  snapshotId: string,
  cause: unknown,
): Promise<void> {
  try {
    await snapshotStore.updateStatus(
      snapshotId,
      'failed',
      `git commit failed: ${createSnapshotErrorMessage(cause)}`,
    );
  } catch {
    // Leave pending for reconcile.
  }
}
