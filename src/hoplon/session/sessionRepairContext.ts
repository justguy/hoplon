import type { DependencyImpactSidecar } from '../contracts/dependencyImpact.js';
import type { RepairContext } from '../contracts/repairContext.js';
import {
  composeDependencyImpactSidecar,
  deriveRepairSubjects,
} from './dependencyImpactSidecar.js';
import { SessionError } from './errors.js';
import { packageRepairContext } from './repairContext.js';
import type { SessionRuntime } from './sessionRuntime.js';
import type { RepairContextOptions } from './types.js';

export async function getRepairContext(
  runtime: SessionRuntime,
  opts?: RepairContextOptions,
): Promise<RepairContext> {
  if (
    runtime.state !== 'audited_block' &&
    runtime.state !== 'reverted' &&
    runtime.state !== 'rollback_extracted'
  ) {
    throw new SessionError({
      kind: 'invalid_state_transition',
      from: runtime.state,
      attempted: 'getRepairContext',
      detail:
        'repair context is only packaged after a BLOCK audit (legal states: audited_block, reverted, rollback_extracted)',
      details: {
        recoveryClass: 'inspect_state',
        allowedStates: ['audited_block', 'reverted', 'rollback_extracted'],
      },
    });
  }
  const auditResult = runtime.lastAuditResult;
  if (!auditResult || auditResult.status !== 'BLOCK') {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getRepairContext',
      detail: 'audit() must have returned BLOCK before a repair context can be packaged',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'audit_block',
      },
    });
  }
  const rollbackTemplate = runtime.lastRollbackTemplate;
  if (!rollbackTemplate) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getRepairContext',
      detail: 'extractRollbackTemplate() must have run before a repair context can be packaged',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'rollbackTemplate',
      },
    });
  }
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getRepairContext',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }

  const includeDependencyImpact = opts?.includeDependencyImpact ?? false;
  const repairSubjects = deriveRepairSubjects(runtime.manifest, auditResult);
  const dependencyImpact: DependencyImpactSidecar =
    await composeDependencyImpactSidecar({
      subjects: repairSubjects,
      includeDependencyImpact,
      engine: runtime.engine,
      correlationId: runtime.correlationId,
      projectId: runtime.manifest.projectId,
      ...(opts?.warnThreshold !== undefined
        ? { warnThreshold: opts.warnThreshold }
        : {}),
      ...(opts?.precomputedChangedFiles !== undefined
        ? { precomputedChangedFiles: [...opts.precomputedChangedFiles] }
        : {}),
    });

  return packageRepairContext({
    sessionId: runtime.sessionId,
    attemptNumber: runtime.attemptCounter,
    snapshotRef: snapshotRef.id,
    failedAtMs: runtime.lastAuditTimestampMs ?? runtime.now(),
    correlationId: runtime.correlationId,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    auditResult,
    rollbackTemplate,
    priorSessionHistory: runtime.history,
    generatedAtIso: new Date(runtime.now()).toISOString(),
    executionId: runtime.traceExecutionId,
    attemptId: runtime.lastTraceAttemptId,
    auditRef: auditResult.auditRef ?? null,
    dependencyImpact,
    ...(opts?.behaviorVerification !== undefined
      ? { behaviorVerification: opts.behaviorVerification }
      : runtime.lastVerifyBehaviorResult !== null
        ? { behaviorVerification: runtime.lastVerifyBehaviorResult }
        : {}),
    ...(opts?.includeRetryContextCompression !== undefined
      ? { includeRetryContextCompression: opts.includeRetryContextCompression }
      : {}),
  });
}
