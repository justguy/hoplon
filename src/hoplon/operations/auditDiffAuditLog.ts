import { randomUUID } from 'node:crypto';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { AuditResult } from '../contracts/audit.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type { AuditRequest } from '../contracts/requests.js';
import type { AuditMetrics } from './auditDiffMetrics.js';

interface AppendAuditResultArgs {
  snapshotStore: SnapshotStore;
  emitter: HoplonEmitter;
  request: AuditRequest;
  result: AuditResult;
  metrics: AuditMetrics;
  engineId: string;
  durationMs: number;
}

export async function appendAuditResultLog(
  args: AppendAuditResultArgs,
): Promise<string | null> {
  const {
    snapshotStore,
    emitter,
    request,
    result,
    metrics,
    engineId,
    durationMs,
  } = args;
  const violations = result.status === 'BLOCK' ? result.violations : [];
  const record: AuditLogRecord = {
    id: randomUUID(),
    snapshotId: request.snapshotRefId,
    projectId: request.projectId,
    runId: request.runId,
    engineId,
    correlationId: request.correlationId,
    operation: 'AUDIT_DIFF',
    result: result.status === 'PASS' ? 'PASS' : 'BLOCK',
    violationCount: violations.length,
    violationKinds: violations.map((violation) => violation.kind),
    durationMs,
    createdAt: new Date().toISOString(),
    astNodeCount: metrics.astNodeCount,
    fileLineCount: metrics.fileLineCount,
    manifestScopeRatio: metrics.manifestScopeRatio,
  };
  try {
    await snapshotStore.appendAuditLog(record);
    return record.id;
  } catch {
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      engineId,
      projectId: request.projectId,
      runId: request.runId,
      correlationId: request.correlationId,
      errorCategory: 'adapter',
      errorKind: 'audit_log_write_failed',
    });
    return null;
  }
}
