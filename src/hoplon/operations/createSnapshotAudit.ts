import { randomUUID } from 'node:crypto';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type { WritableManifest } from '../contracts/manifest.js';
import type { SnapshotScanMetrics } from './createSnapshotScan.js';

interface AppendSnapshotAuditArgs {
  snapshotStore: SnapshotStore;
  emitter: HoplonEmitter;
  manifest: WritableManifest;
  snapshotId: string;
  engineId: string;
  durationMs: number;
  metrics: SnapshotScanMetrics;
}

export async function appendSnapshotSuccessAudit(
  args: AppendSnapshotAuditArgs,
): Promise<void> {
  const {
    snapshotStore,
    emitter,
    manifest,
    snapshotId,
    engineId,
    durationMs,
    metrics,
  } = args;
  const record: AuditLogRecord = {
    id: randomUUID(),
    snapshotId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    engineId,
    correlationId: manifest.correlationId,
    operation: 'CREATE_SNAPSHOT',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs,
    createdAt: new Date().toISOString(),
    astNodeCount: null,
    fileLineCount: metrics.anyFileRead ? metrics.totalLineCount : null,
    manifestScopeRatio:
      metrics.anyFileRead && metrics.totalFileBytes > 0
        ? metrics.scopeCoveredBytes / metrics.totalFileBytes
        : null,
  };
  try {
    await snapshotStore.appendAuditLog(record);
  } catch {
    emitter.emit({
      op: 'createSnapshot',
      phase: 'error',
      engineId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      correlationId: manifest.correlationId,
      errorCategory: 'adapter',
      errorKind: 'audit_log_write_failed',
    });
  }
}
