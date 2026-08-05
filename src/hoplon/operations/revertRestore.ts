import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { WritableManifest } from '../contracts/manifest.js';
import { AdapterError } from '../contracts/errors.js';
import { withNonIdempotentRevertGuidance } from './revertRecoveryGuards.js';
import { errorMessage, revertAbortError } from './revertErrors.js';

interface RestoreManifestArgs {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  manifest: WritableManifest;
  gitRepoDir: string;
  gitRef: string;
  engineId: string;
  correlationId: string;
  signal: AbortSignal | undefined;
}

export async function restoreManifestPaths(
  args: RestoreManifestArgs,
): Promise<string[]> {
  const {
    fs,
    versioning,
    manifest,
    gitRepoDir,
    gitRef,
    engineId,
    correlationId,
    signal,
  } = args;
  const reverted: string[] = [];

  for (const entry of manifest.entries) {
    let snapshotContent: Uint8Array | null = null;
    try {
      snapshotContent = await versioning.readBlob(
        gitRepoDir,
        gitRef,
        entry.path,
      );
    } catch (cause) {
      if (!(cause instanceof AdapterError) || cause.kind !== 'git_read_failed') {
        throw new AdapterError(
          {
            kind: 'git_checkout_failed',
            engineId,
            correlationId,
            cause,
          },
          withNonIdempotentRevertGuidance(
            `revertUncontracted: snapshot read failed for '${entry.path}': ${errorMessage(cause)}`,
          ),
        );
      }
    }

    if (snapshotContent === null) {
      let statResult: Awaited<ReturnType<typeof fs.stat>>;
      try {
        statResult = await fs.stat(entry.path);
      } catch (cause) {
        throwFsWriteError(
          engineId,
          correlationId,
          cause,
          `revertUncontracted: fs.stat failed for '${entry.path}': ${errorMessage(cause)}`,
        );
      }
      if (statResult.exists) {
        try {
          await fs.remove(entry.path);
        } catch (cause) {
          throwFsWriteError(
            engineId,
            correlationId,
            cause,
            `revertUncontracted: fs.remove failed for '${entry.path}': ${errorMessage(cause)}`,
          );
        }
      }
    } else {
      try {
        await fs.write(entry.path, snapshotContent);
      } catch (cause) {
        throwFsWriteError(
          engineId,
          correlationId,
          cause,
          `revertUncontracted: fs.write to fsRoot failed for '${entry.path}': ${errorMessage(cause)}`,
        );
      }
    }

    reverted.push(entry.path);
    if (signal?.aborted) throw revertAbortError(signal);
  }
  return reverted;
}

function throwFsWriteError(
  engineId: string,
  correlationId: string,
  cause: unknown,
  message: string,
): never {
  throw new AdapterError(
    { kind: 'fs_write_failed', engineId, correlationId, cause },
    withNonIdempotentRevertGuidance(message),
  );
}
