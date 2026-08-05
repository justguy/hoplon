/**
 * contracts/complianceAccess.ts — SOC2 proof/export access decisions.
 *
 * These contracts are H13-safe: they record who accessed which stable ref and
 * why it was granted or denied, without carrying raw proof, source slices,
 * tokens, request bodies, or rule bodies.
 */

import { z } from 'zod';
import type { AuditLogRecord } from './auditLog.js';

export const ProofAccessClassSchema = z.enum([
  'metadata',
  'standard_trace',
  'proof_detail',
  'raw_proof',
  'source_slice',
  'export',
]);
export type ProofAccessClass = z.infer<typeof ProofAccessClassSchema>;

export const ProofAccessObjectTypeSchema = z.enum([
  'execution',
  'proof_bundle',
  'violation',
  'export_bundle',
]);
export type ProofAccessObjectType = z.infer<typeof ProofAccessObjectTypeSchema>;

export const ProofAccessOutcomeSchema = z.enum(['GRANTED', 'DENIED']);
export type ProofAccessOutcome = z.infer<typeof ProofAccessOutcomeSchema>;

export const ProofAccessReasonCodeSchema = z.enum([
  'enterprise_policy_absent',
  'access_granted',
  'missing_principal',
  'missing_role',
  'policy_denied',
  'audit_write_failed',
]);
export type ProofAccessReasonCode = z.infer<typeof ProofAccessReasonCodeSchema>;

export const ProofAccessRequestSchema = z.object({
  principalId: z.string().min(1).nullable(),
  engineId: z.string().min(1),
  accessClass: ProofAccessClassSchema,
  objectType: ProofAccessObjectTypeSchema,
  objectRef: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  requestedAt: z.string(),
}).strict();
export type ProofAccessRequest = z.infer<typeof ProofAccessRequestSchema>;

export const ProofAccessDecisionSchema = z.object({
  outcome: ProofAccessOutcomeSchema,
  reasonCode: ProofAccessReasonCodeSchema,
  detail: z.string().nullable(),
}).strict();
export type ProofAccessDecision = z.infer<typeof ProofAccessDecisionSchema>;

export const ProofAccessAuditEventSchema = ProofAccessRequestSchema.extend({
  outcome: ProofAccessOutcomeSchema,
  reasonCode: ProofAccessReasonCodeSchema,
  detail: z.string().nullable(),
}).strict();
export type ProofAccessAuditEvent = z.infer<typeof ProofAccessAuditEventSchema>;

export interface ProofAccessPolicy {
  authorize(request: ProofAccessRequest): Promise<ProofAccessDecision>;
}

export interface ProofAccessAuditSink {
  appendProofAccessAudit(event: ProofAccessAuditEvent): Promise<void>;
}

export function allowAllProofAccessPolicy(): ProofAccessPolicy {
  return {
    async authorize(): Promise<ProofAccessDecision> {
      return { outcome: 'GRANTED', reasonCode: 'access_granted', detail: null };
    },
  };
}

export function roleBasedProofAccessPolicy(
  allowed: Record<ProofAccessClass, readonly string[]>,
): ProofAccessPolicy {
  return {
    async authorize(request: ProofAccessRequest): Promise<ProofAccessDecision> {
      if (request.principalId == null) {
        return { outcome: 'DENIED', reasonCode: 'missing_principal', detail: null };
      }
      const roles = allowed[request.accessClass] ?? [];
      if (roles.includes(request.principalId)) {
        return { outcome: 'GRANTED', reasonCode: 'access_granted', detail: null };
      }
      return { outcome: 'DENIED', reasonCode: 'missing_role', detail: null };
    },
  };
}

export async function authorizeAndAuditProofAccess(
  requestInput: ProofAccessRequest,
  policy: ProofAccessPolicy,
  sink: ProofAccessAuditSink,
): Promise<ProofAccessDecision> {
  const request = ProofAccessRequestSchema.parse(requestInput);
  const decision = ProofAccessDecisionSchema.parse(await policy.authorize(request));
  const event = ProofAccessAuditEventSchema.parse({
    ...request,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    detail: decision.detail,
  });
  try {
    await sink.appendProofAccessAudit(event);
  } catch {
    const denied = {
      outcome: 'DENIED',
      reasonCode: 'audit_write_failed',
      detail: 'proof access audit sink failed',
    } as const;
    return ProofAccessDecisionSchema.parse(denied);
  }
  return decision;
}

export function proofAccessEventToAuditLogRecord(input: {
  id: string;
  event: ProofAccessAuditEvent;
  durationMs?: number;
}): AuditLogRecord {
  const event = ProofAccessAuditEventSchema.parse(input.event);
  return {
    id: input.id,
    snapshotId: null,
    projectId: event.projectId ?? 'unknown',
    runId: event.runId ?? 'unknown',
    engineId: event.engineId,
    correlationId: event.correlationId,
    operation: 'PROOF_ACCESS',
    result: event.outcome,
    violationCount: 0,
    violationKinds: [],
    durationMs: input.durationMs ?? 0,
    createdAt: event.requestedAt,
    proofAccessEvent: event,
  };
}
