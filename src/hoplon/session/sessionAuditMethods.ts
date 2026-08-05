import type { AuditResult } from '../contracts/audit.js';
import { deriveAuditCoverage } from './auditCoverage.js';
import { SessionError } from './errors.js';
import { assertSessionState, cloneValue, recordTransition } from './internal.js';
import type { SessionRuntime } from './sessionRuntime.js';
import type { SessionState } from './types.js';

export async function audit(runtime: SessionRuntime): Promise<AuditResult> {
  assertSessionState(runtime.state, 'audit', ['edited']);
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'audit',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }
  const startedAt = new Date(runtime.now()).toISOString();
  const auditCoverage = await deriveAuditCoverage({
    fs: runtime.fs,
    snapshotStore: runtime.snapshotStoreAdapter,
    snapshotRefId: snapshotRef.id,
    declaredFiles: runtime.changedFiles,
    gitRepoDir: runtime.gitRepoDir,
    revertAllowlist: runtime.revertAllowlist,
  });
  const engineResult = await runtime.engine.auditDiff({
    snapshotRefId: snapshotRef.id,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
    files: [...auditCoverage.files],
  });
  const result: AuditResult = {
    ...engineResult,
    coverage: auditCoverage.evidence,
  };
  const completedAt = new Date(runtime.now()).toISOString();
  runtime.lastAuditResult = cloneValue(result);
  const violationCount = result.status === 'BLOCK' ? result.violations.length : 0;
  const nextState: SessionState =
    result.status === 'PASS' ? 'audited_pass' : 'audited_block';
  const advanceTimestampMs = runtime.now();
  runtime.lastAuditTimestampMs = advanceTimestampMs;
  recordTransition(runtime.history, {
    op: 'audit',
    fromState: runtime.state,
    toState: nextState,
    timestampMs: advanceTimestampMs,
    outcome: {
      kind: 'audit',
      status: result.status,
      violationCount,
    },
  });
  runtime.state = nextState;
  runtime.attemptCounter += 1;
  const traceAttempt = await runtime.traceWriter.recordAttempt({
    attemptNumber: runtime.attemptCounter,
    basedOnSnapshotRef: snapshotRef.id,
    auditResult: result,
    auditRef: result.auditRef ?? null,
    startedAt,
    completedAt,
  });
  if (traceAttempt) {
    runtime.traceExecutionId = traceAttempt.executionId;
    runtime.lastTraceAttemptId = traceAttempt.attemptId;
  } else {
    runtime.lastTraceAttemptId = null;
  }
  return result;
}
