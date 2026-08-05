/**
 * Restore manifest paths and remove proven post-snapshot creations.
 * NOT IDEMPOTENT: this operation fails on the first error and must not be
 * retried blindly after a partial restore.
 */

import { randomUUID } from 'node:crypto';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { LockProvider } from '../adapters/lock.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { RevertResult } from '../contracts/revert.js';
import { RevertRequestSchema } from '../contracts/requests.js';
import type { RevertRequest } from '../contracts/requests.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { classifyRevertError, revertAbortError } from './revertErrors.js';
import { runRevert } from './revertExecution.js';

export { pathMatchesAllowlist } from './revertAllowlist.js';

export interface RevertUncontractedDeps {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  lockProvider: LockProvider;
  emitter: HoplonEmitter;
  engineId: string;
  config: {
    gitRepoDir: string;
    fsRoot: string;
    revertAllowlist: string[];
  };
}

export async function revertUncontracted(
  deps: RevertUncontractedDeps,
  req: RevertRequest,
  signal?: AbortSignal,
): Promise<RevertResult> {
  const { snapshotStore, emitter, engineId } = deps;
  if (signal?.aborted) throw revertAbortError(signal);

  const parseResult = RevertRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const correlationId =
      typeof (req as Record<string, unknown>)?.['correlationId'] === 'string' &&
      String((req as Record<string, unknown>)?.['correlationId']).length > 0
        ? String((req as Record<string, unknown>)?.['correlationId'])
        : 'unvalidated';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: parseResult.error,
      },
      `revertUncontracted: invalid request: ${parseResult.error.message}`,
    );
  }

  const validated = parseResult.data;
  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);
  const startMs = Date.now();
  emitter.emit({
    op: 'revertUncontracted',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  try {
    return await runRevert(deps, validated, signal, startMs);
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const [errorCategory, errorKind] = classifyRevertError(error);
    emitter.emit({
      op: 'revertUncontracted',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    });
    const errorAuditLog: AuditLogRecord = {
      id: randomUUID(),
      snapshotId: validated.snapshotRefId,
      projectId: validated.projectId,
      runId: validated.runId,
      engineId,
      correlationId: validated.correlationId,
      operation: 'REVERT',
      result: 'ERROR',
      violationCount: 0,
      violationKinds: [],
      durationMs,
      createdAt: new Date().toISOString(),
    };
    try {
      await snapshotStore.appendAuditLog(errorAuditLog);
    } catch {
      // Preserve the original failure; audit logging is best-effort here.
    }
    throw error;
  }
}
