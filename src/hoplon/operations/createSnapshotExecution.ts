import type { WritableManifest } from '../contracts/manifest.js';
import type { SnapshotResult } from '../contracts/snapshot.js';
import { AdapterError } from '../contracts/errors.js';
import {
  DEFAULT_DLP_POLICY_MODE,
  type DlpPolicyMode,
} from '../contracts/dlp.js';
import { hashManifestWithContent } from '../util/hashManifest.js';
import type { CreateSnapshotDeps } from './createSnapshot.js';
import { appendSnapshotSuccessAudit } from './createSnapshotAudit.js';
import { commitSnapshotTree } from './createSnapshotCommit.js';
import { createSnapshotAbortError, createSnapshotErrorMessage } from './createSnapshotErrors.js';
import {
  assertCommittedSnapshotIdentity,
  contentHashesForReads,
  readManifestEntryBytesOnce,
} from './createSnapshotIdentity.js';
import { writePendingSnapshot } from './createSnapshotPending.js';
import { scanSnapshotContent } from './createSnapshotScan.js';

export async function runSnapshot(
  deps: CreateSnapshotDeps,
  manifest: WritableManifest,
  signal: AbortSignal | undefined,
  startMs: number,
): Promise<SnapshotResult> {
  const {
    fs,
    versioning,
    snapshotStore,
    lockProvider,
    emitter,
    secretScanner,
    dlp,
    engineId,
    config,
  } = deps;
  const dlpMode: DlpPolicyMode =
    config.dlpPolicyMode ?? DEFAULT_DLP_POLICY_MODE;
  const release = await lockProvider.acquire(`project:${manifest.projectId}`);

  try {
    const reads = await readManifestEntryBytesOnce({
      fs,
      entries: manifest.entries,
      engineId,
      correlationId: manifest.correlationId,
    });
    const id = hashManifestWithContent(
      manifest,
      contentHashesForReads(reads),
    );
    const existing = await snapshotStore.get(id);
    if (existing !== null && existing.status === 'committed') {
      assertCommittedSnapshotIdentity({
        existing,
        manifest,
        snapshotRefId: id,
        engineId,
      });
      emitter.emit({
        op: 'createSnapshot',
        phase: 'end',
        engineId,
        projectId: manifest.projectId,
        runId: manifest.runId,
        correlationId: manifest.correlationId,
        durationMs: Date.now() - startMs,
        classification: 'PASS',
      });
      return {
        snapshotRef: {
          id,
          engineId,
          runId: existing.runId,
          createdAt: existing.createdAt,
        },
        warnings: [],
      };
    }

    const { createdAt, gitRepoDirRelative } = await writePendingSnapshot({
      fs,
      snapshotStore,
      manifest,
      id,
      engineId,
      config,
    });
    if (signal?.aborted) throw createSnapshotAbortError(signal);

    const { warnings, metrics } = await scanSnapshotContent({
      manifest,
      reads,
      secretScanner,
      dlp,
      dlpMode,
      snapshotStore,
      snapshotId: id,
      engineId,
      signal,
    });
    if (signal?.aborted) {
      try {
        await snapshotStore.updateStatus(
          id,
          'failed',
          'aborted before git commit',
        );
      } catch {
        // Leave pending for reconcile.
      }
      throw createSnapshotAbortError(signal);
    }

    const commitSha = await commitSnapshotTree({
      fs,
      versioning,
      snapshotStore,
      manifest,
      reads,
      snapshotId: id,
      engineId,
      gitRepoDir: config.gitRepoDir,
      gitRepoDirRelative,
    });
    if (snapshotStore.recordPendingGitRef !== undefined) {
      try {
        await snapshotStore.recordPendingGitRef(id, commitSha);
      } catch {
        // Evidence-only write.
      }
    }
    if (signal?.aborted) throw createSnapshotAbortError(signal);

    try {
      await snapshotStore.updateStatus(id, 'committed', undefined, commitSha);
    } catch (cause) {
      throw new AdapterError(
        {
          kind: 'snapshot_store_write_failed',
          engineId,
          correlationId: manifest.correlationId,
          cause,
        },
        `createSnapshot: Phase C (committed status update) failed: ${createSnapshotErrorMessage(cause)}`,
      );
    }

    const durationMs = Date.now() - startMs;
    emitter.emit({
      op: 'createSnapshot',
      phase: 'end',
      engineId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      correlationId: manifest.correlationId,
      durationMs,
      classification: 'PASS',
    });
    await appendSnapshotSuccessAudit({
      snapshotStore,
      emitter,
      manifest,
      snapshotId: id,
      engineId,
      durationMs,
      metrics,
    });
    return {
      snapshotRef: { id, engineId, runId: manifest.runId, createdAt },
      warnings,
    };
  } finally {
    release();
  }
}
