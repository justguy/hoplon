import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { WritableManifest } from '../contracts/manifest.js';
import { AdapterError } from '../contracts/errors.js';
import { pathMatchesAllowlist } from './revertAllowlist.js';
import { errorMessage } from './revertErrors.js';
import { withNonIdempotentRevertGuidance } from './revertRecoveryGuards.js';
import {
  getSnapshotPresence,
  listWorkspacePaths,
  normalizeWorkspacePath,
  wasPresentAtSnapshot,
} from './snapshotPresence.js';

export interface RevertCleanupResult {
  deleted: string[];
  allowlistSkipped: string[];
  presenceUnknownSkipped: string[];
}

interface CleanupArgs {
  fs: HoplonFsAdapter;
  record: SnapshotRecord;
  manifest: WritableManifest;
  allowlist: string[];
  engineId: string;
  correlationId: string;
}

export async function cleanupUncontractedPaths(
  args: CleanupArgs,
): Promise<RevertCleanupResult> {
  const { fs, record, manifest, allowlist, engineId, correlationId } = args;
  const deleted: string[] = [];
  const allowlistSkipped: string[] = [];
  const presenceUnknownSkipped: string[] = [];
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
  const presence = getSnapshotPresence(record);

  let currentFiles: string[];
  try {
    currentFiles = await listWorkspacePaths(fs);
  } catch (cause) {
    throw new AdapterError(
      { kind: 'fs_read_failed', engineId, correlationId, cause },
      withNonIdempotentRevertGuidance(
        `revertUncontracted: filesystem listing failed during cleanup: ${errorMessage(cause)}`,
      ),
    );
  }

  for (const filePath of currentFiles) {
    const normalized = normalizeWorkspacePath(filePath);
    if (manifestPaths.has(normalized)) continue;
    if (pathMatchesAllowlist(normalized, allowlist)) {
      allowlistSkipped.push(normalized);
      continue;
    }
    const presentAtSnapshot = wasPresentAtSnapshot(presence, normalized);
    if (presentAtSnapshot === 'present') continue;
    if (presentAtSnapshot === 'unknown') {
      presenceUnknownSkipped.push(normalized);
      continue;
    }
    try {
      await fs.remove(normalized);
    } catch (cause) {
      throw new AdapterError(
        { kind: 'fs_write_failed', engineId, correlationId, cause },
        withNonIdempotentRevertGuidance(
          `revertUncontracted: fs.remove failed for '${normalized}': ${errorMessage(cause)}`,
        ),
      );
    }
    deleted.push(normalized);
  }
  return { deleted, allowlistSkipped, presenceUnknownSkipped };
}
