import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { WritableManifest } from '../contracts/manifest.js';
import { AdapterError } from '../contracts/errors.js';
import type { CreateSnapshotDeps } from './createSnapshot.js';
import { createSnapshotErrorMessage } from './createSnapshotErrors.js';
import {
  listWorkspacePaths,
  WORKSPACE_WALK_EXCLUDES,
} from './snapshotPresence.js';

interface WritePendingArgs {
  fs: HoplonFsAdapter;
  snapshotStore: SnapshotStore;
  manifest: WritableManifest;
  id: string;
  engineId: string;
  config: CreateSnapshotDeps['config'];
}

export async function writePendingSnapshot(
  args: WritePendingArgs,
): Promise<{ createdAt: string; gitRepoDirRelative: string }> {
  const { fs, snapshotStore, manifest, id, engineId, config } = args;
  const gitRepoDirRelative = config.gitRepoDir.startsWith('/')
    ? config.gitRepoDir.slice(1)
    : config.gitRepoDir;
  let presencePaths: string[] | null = null;
  if (config.manifestStorageMode === 'inline') {
    try {
      presencePaths = await listWorkspacePaths(fs, {
        excludePrefixes: [
          ...WORKSPACE_WALK_EXCLUDES,
          ...(gitRepoDirRelative.length > 0 ? [gitRepoDirRelative] : []),
        ],
      });
    } catch (cause) {
      throw new AdapterError(
        {
          kind: 'fs_read_failed',
          engineId,
          correlationId: manifest.correlationId,
          cause,
        },
        `createSnapshot: presence evidence listing failed: ${createSnapshotErrorMessage(cause)}`,
      );
    }
  }

  const createdAt = new Date().toISOString();
  const ttlExpires =
    config.ttlRetentionMs != null && config.ttlRetentionMs > 0
      ? new Date(Date.now() + config.ttlRetentionMs).toISOString()
      : null;
  try {
    await snapshotStore.put({
      id,
      manifestSchemaVersion: 1,
      engineId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      correlationId: manifest.correlationId,
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: config.manifestStorageMode === 'inline' ? manifest : null,
      createdAt,
      ttlExpires,
      replicaIds: [],
      presencePaths,
    });
  } catch (cause) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_write_failed',
        engineId,
        correlationId: manifest.correlationId,
        cause,
      },
      `createSnapshot: Phase A (pending row write) failed: ${createSnapshotErrorMessage(cause)}`,
    );
  }
  return { createdAt, gitRepoDirRelative };
}
