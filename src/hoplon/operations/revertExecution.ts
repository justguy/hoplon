import { randomUUID } from 'node:crypto';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type { RevertRequest } from '../contracts/requests.js';
import type { RevertResult } from '../contracts/revert.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import type { RevertUncontractedDeps } from './revertUncontracted.js';
import { cleanupUncontractedPaths } from './revertCleanup.js';
import { revertAbortError } from './revertErrors.js';
import { assertSnapshotCommitAvailable } from './revertRecoveryGuards.js';
import { restoreManifestPaths } from './revertRestore.js';
import { validateRevertSnapshot } from './revertSnapshotValidation.js';

export async function runRevert(
  deps: RevertUncontractedDeps,
  request: RevertRequest,
  signal: AbortSignal | undefined,
  startMs: number,
): Promise<RevertResult> {
  const {
    fs,
    versioning,
    snapshotStore,
    lockProvider,
    emitter,
    engineId,
    config,
  } = deps;
  const release = await lockProvider.acquire(`project:${request.projectId}`);

  try {
    const resolved = validateRevertSnapshot(
      await snapshotStore.get(request.snapshotRefId),
      request,
      engineId,
    );
    for (const entry of resolved.manifest.entries) {
      canonicalizePath({
        path: entry.path,
        root: config.fsRoot,
        engineId,
        correlationId: request.correlationId,
      });
    }
    await assertSnapshotCommitAvailable({
      versioning,
      gitRepoDir: config.gitRepoDir,
      gitRef: resolved.gitRef,
      snapshotRefId: request.snapshotRefId,
      engineId,
      correlationId: request.correlationId,
    });
    if (signal?.aborted) throw revertAbortError(signal);

    const reverted = await restoreManifestPaths({
      fs,
      versioning,
      manifest: resolved.manifest,
      gitRepoDir: config.gitRepoDir,
      gitRef: resolved.gitRef,
      engineId,
      correlationId: request.correlationId,
      signal,
    });
    const cleanup = await cleanupUncontractedPaths({
      fs,
      record: resolved.record,
      manifest: resolved.manifest,
      allowlist: config.revertAllowlist,
      engineId,
      correlationId: request.correlationId,
    });

    const durationMs = Date.now() - startMs;
    emitter.emit({
      op: 'revertUncontracted',
      phase: 'end',
      engineId,
      projectId: request.projectId,
      runId: request.runId,
      correlationId: request.correlationId,
      durationMs,
      classification: 'PASS',
    });
    const auditLogRecord: AuditLogRecord = {
      id: randomUUID(),
      snapshotId: resolved.record.id,
      projectId: request.projectId,
      runId: request.runId,
      engineId,
      correlationId: request.correlationId,
      operation: 'REVERT',
      result: 'PASS',
      violationCount: 0,
      violationKinds: [],
      durationMs,
      createdAt: new Date().toISOString(),
    };
    try {
      await snapshotStore.appendAuditLog(auditLogRecord);
    } catch {
      emitter.emit({
        op: 'revertUncontracted',
        phase: 'error',
        engineId,
        projectId: request.projectId,
        runId: request.runId,
        correlationId: request.correlationId,
        errorCategory: 'adapter',
        errorKind: 'audit_log_write_failed',
      });
    }
    return { reverted, ...cleanup };
  } finally {
    release();
  }
}
