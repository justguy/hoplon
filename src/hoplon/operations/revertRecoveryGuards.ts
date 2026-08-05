import type { VersioningAdapter } from '../adapters/versioning.js';
import { AdapterError } from '../contracts/errors.js';

export const NON_IDEMPOTENT_REVERT_GUIDANCE =
  'revertUncontracted is not idempotent after partial failure; do not retry blindly. Fetch a fresh snapshot or escalate with the current workspace state.';

export function withNonIdempotentRevertGuidance(message: string): string {
  return `${message} ${NON_IDEMPOTENT_REVERT_GUIDANCE}`;
}

export async function assertSnapshotCommitAvailable(opts: {
  versioning: VersioningAdapter;
  gitRepoDir: string;
  gitRef: string;
  snapshotRefId: string;
  engineId: string;
  correlationId: string;
}): Promise<void> {
  try {
    await opts.versioning.readCommitInfo({
      dir: opts.gitRepoDir,
      ref: opts.gitRef,
    });
  } catch (cause) {
    throw new AdapterError(
      {
        kind: 'git_read_failed',
        engineId: opts.engineId,
        correlationId: opts.correlationId,
        cause,
      },
      `revertUncontracted: snapshot registry/git object-store split-brain for '${opts.snapshotRefId}' at '${opts.gitRef}'. Fetch a fresh snapshot or escalate before retrying.`,
    );
  }
}
