import type { AuditLogOperation, AuditLogResult } from '../contracts/auditLog.js';
import type { PolicyAuditEvent } from '../contracts/policyAudit.js';
import type { HoplonEmitter, HoplonEvent } from '../adapters/emitter.js';
import type { PolicyAuditContext } from './policyAuditSink.js';

export interface EmitPolicyAuditTelemetryArgs {
  emitter?: HoplonEmitter;
  context: PolicyAuditContext;
  engineId: string;
  operation: AuditLogOperation;
  result: AuditLogResult;
  event: PolicyAuditEvent;
  durationMs: number;
  auditRowCount: number;
  writeFailed: boolean;
}

export function emitPolicyAuditTelemetry(
  args: EmitPolicyAuditTelemetryArgs,
): void {
  if (args.emitter === undefined) return;
  const decisionClass = policyDecisionClass(args.result, args.event);
  const phase: HoplonEvent['phase'] = args.writeFailed ? 'error' : 'end';
  try {
    args.emitter.emit({
      op: 'policyDecision',
      phase,
      engineId: args.engineId,
      projectId: args.context.projectId,
      runId: args.context.runId,
      correlationId: args.context.correlationId,
      durationMs: args.durationMs,
      classification: args.writeFailed ? 'ERROR' : classification(args.result),
      operationKind: 'policy',
      policyDecisionClass: args.writeFailed ? 'error' : decisionClass,
      auditRowCount: args.auditRowCount,
      ...(args.writeFailed
        ? {
            errorCategory: 'adapter',
            errorKind: 'policy_audit_write_failed',
          }
        : {}),
    });
  } catch {
    // Observability-only: policy decisions and audit writes keep their outcome.
  }
}

function classification(result: AuditLogResult): NonNullable<HoplonEvent['classification']> {
  if (result === 'DENIED' || result === 'REAUTH_REQUIRED') return 'BLOCK';
  if (result === 'ERROR') return 'ERROR';
  return 'PASS';
}

function policyDecisionClass(
  result: AuditLogResult,
  event: PolicyAuditEvent,
): NonNullable<HoplonEvent['policyDecisionClass']> {
  if (event.reasonCode === 'handshake_requires_escalation') return 'requires_escalation';
  if (event.reasonCode === 'handshake_requires_approval') return 'requires_approval';
  if (result === 'GRANTED' || result === 'PASS') return 'allow';
  if (result === 'DENIED' || result === 'BLOCK') return 'deny';
  if (result === 'REAUTH_REQUIRED') return 'reauth_required';
  if (result === 'REVOKED') return 'revoked';
  return 'error';
}
