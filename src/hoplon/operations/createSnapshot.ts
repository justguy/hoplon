/**
 * Create a content-addressed snapshot with an atomic two-phase store/commit flow.
 * The single-read pipeline feeds identity, scanning, and the committed bytes.
 */

import { randomUUID } from 'node:crypto';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { LockProvider } from '../adapters/lock.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SecretScannerAdapter } from '../adapters/secretScanner.js';
import type { DlpAdapter } from '../adapters/dlp.js';
import type { DlpPolicyMode } from '../contracts/dlp.js';
import type { SnapshotResult } from '../contracts/snapshot.js';
import { CreateSnapshotRequestSchema } from '../contracts/requests.js';
import type { CreateSnapshotRequest } from '../contracts/requests.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import {
  classifyCreateSnapshotError,
  createSnapshotAbortError,
} from './createSnapshotErrors.js';
import { runSnapshot } from './createSnapshotExecution.js';

export interface CreateSnapshotDeps {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  lockProvider: LockProvider;
  emitter: HoplonEmitter;
  secretScanner: SecretScannerAdapter;
  dlp?: DlpAdapter;
  engineId: string;
  config: {
    gitRepoDir: string;
    fsRoot: string;
    manifestStorageMode: 'inline' | 'hash_only';
    ttlRetentionMs?: number;
    dlpPolicyMode?: DlpPolicyMode;
  };
}

export async function createSnapshot(
  deps: CreateSnapshotDeps,
  req: CreateSnapshotRequest,
  signal?: AbortSignal,
): Promise<SnapshotResult> {
  const { snapshotStore, emitter, engineId, config } = deps;
  if (signal?.aborted) throw createSnapshotAbortError(signal);

  const parseResult = CreateSnapshotRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const raw = (req ?? {}) as Record<string, unknown>;
    const rawManifest =
      typeof raw['manifest'] === 'object' && raw['manifest'] !== null
        ? (raw['manifest'] as Record<string, unknown>)
        : null;
    const correlationId =
      typeof rawManifest?.['correlationId'] === 'string' &&
      rawManifest['correlationId'] !== ''
        ? String(rawManifest['correlationId'])
        : 'unvalidated';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: parseResult.error,
      },
      `createSnapshot: invalid request: ${parseResult.error.message}`,
    );
  }

  const manifest = parseResult.data.manifest;
  validateCorrelationId(manifest.correlationId);
  validateRunId(manifest.runId);
  for (const entry of manifest.entries) {
    canonicalizePath({
      path: entry.path,
      root: config.fsRoot,
      engineId,
      correlationId: manifest.correlationId,
    });
  }

  const startMs = Date.now();
  emitter.emit({
    op: 'createSnapshot',
    phase: 'start',
    engineId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    correlationId: manifest.correlationId,
  });

  try {
    return await runSnapshot(deps, manifest, signal, startMs);
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const [errorCategory, errorKind] = classifyCreateSnapshotError(error);
    emitter.emit({
      op: 'createSnapshot',
      phase: 'error',
      engineId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      correlationId: manifest.correlationId,
      durationMs,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    });
    const errorAudit: AuditLogRecord = {
      id: randomUUID(),
      snapshotId: null,
      projectId: manifest.projectId,
      runId: manifest.runId,
      engineId,
      correlationId: manifest.correlationId,
      operation: 'CREATE_SNAPSHOT',
      result: 'ERROR',
      violationCount: 0,
      violationKinds: [],
      durationMs,
      createdAt: new Date().toISOString(),
    };
    try {
      await snapshotStore.appendAuditLog(errorAudit);
    } catch {
      // Preserve the original failure; audit logging is best-effort here.
    }
    throw error;
  }
}
