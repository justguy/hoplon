/**
 * Compare current AST state with the contracted snapshot scope.
 * Agent-facing source evidence remains complete and is never truncated.
 */

import { randomUUID } from 'node:crypto';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { AuditResult } from '../contracts/audit.js';
import { AuditRequestSchema } from '../contracts/requests.js';
import type { AuditRequest } from '../contracts/requests.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { appendAuditResultLog } from './auditDiffAuditLog.js';
import {
  auditAbortError,
  classifyAuditError,
} from './auditDiffErrors.js';
import { runAudit } from './auditDiffExecution.js';
import type { AuditMetrics } from './auditDiffMetrics.js';

export { AUDITED_NODE_KINDS } from './symbolScopeGate.js';

export interface AuditDiffDeps {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  config: {
    fsRoot: string;
    gitRepoDir: string;
    maxFileBytes: number;
    parseTimeoutMs: number;
    manifestSchemaVersion: 1;
  };
}

export async function auditDiff(
  deps: AuditDiffDeps,
  req: AuditRequest,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const {
    fs,
    versioning,
    snapshotStore,
    codeIntelligence,
    emitter,
    engineId,
    config,
  } = deps;
  const startMs = Date.now();
  if (signal?.aborted) throw auditAbortError(signal);

  const parseResult = AuditRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const correlationId =
      typeof (req as Record<string, unknown>)?.['correlationId'] === 'string' &&
      ((req as Record<string, unknown>)?.['correlationId'] as string).length > 0
        ? ((req as Record<string, unknown>)['correlationId'] as string)
        : 'unvalidated';
    const error = new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: parseResult.error,
      },
      `auditDiff: invalid request: ${parseResult.error.message}`,
    );
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      engineId,
      correlationId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_manifest',
    });
    throw error;
  }

  const validated = parseResult.data;
  try {
    validateCorrelationId(validated.correlationId);
  } catch (error) {
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId || 'unvalidated',
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_correlation_id',
    });
    throw error;
  }
  try {
    validateRunId(validated.runId);
  } catch (error) {
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_run_id',
    });
    throw error;
  }
  for (const file of validated.files) {
    try {
      canonicalizePath({
        path: file,
        root: config.fsRoot,
        engineId,
        correlationId: validated.correlationId,
      });
    } catch (error) {
      emitter.emit({
        op: 'auditDiff',
        phase: 'error',
        engineId,
        correlationId: validated.correlationId,
        durationMs: Date.now() - startMs,
        errorCategory: 'validation',
        errorKind: 'path_traversal',
      });
      throw error;
    }
  }

  emitter.emit({
    op: 'auditDiff',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: AuditResult;
  let metrics: AuditMetrics;
  try {
    const runResult = await runAudit(
      { fs, versioning, snapshotStore, codeIntelligence, engineId, config },
      validated,
      signal,
    );
    result = runResult.result;
    metrics = runResult.metrics;
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const [errorCategory, errorKind] = classifyAuditError(error);
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    });
    const errorAudit: AuditLogRecord = {
      id: randomUUID(),
      snapshotId: validated.snapshotRefId,
      projectId: validated.projectId,
      runId: validated.runId,
      engineId,
      correlationId: validated.correlationId,
      operation: 'AUDIT_DIFF',
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

  const durationMs = Date.now() - startMs;
  emitter.emit({
    op: 'auditDiff',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs,
    classification: result.status,
  });
  const auditRef = await appendAuditResultLog({
    snapshotStore,
    emitter,
    request: validated,
    result,
    metrics,
    engineId,
    durationMs,
  });
  return { ...result, auditRef };
}
