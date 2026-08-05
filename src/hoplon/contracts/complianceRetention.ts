/**
 * contracts/complianceRetention.ts — SOC2 retention policy primitives.
 *
 * Retention planning is pure. Callers provide H13-safe evidence candidates and
 * an executor that maps actions onto existing adapter seams. The plan carries
 * audit-log checkpoints so retained rows can still be integrity-verified after
 * older rows are tombstoned or deleted.
 */

import { z } from 'zod';
import type { AuditLogRecord } from './auditLog.js';
import {
  AuditLogIntegrityCheckpointSchema,
  type AuditLogIntegrityCheckpoint,
} from './compliance.js';

export const RetentionEvidenceClassSchema = z.enum([
  'audit_log',
  'execution_trace',
  'attempt',
  'proof_bundle',
  'proof_violation',
  'decision_provenance',
]);
export type RetentionEvidenceClass = z.infer<typeof RetentionEvidenceClassSchema>;

export const RetentionDisposalModeSchema = z.enum(['keep', 'tombstone', 'delete']);
export type RetentionDisposalMode = z.infer<typeof RetentionDisposalModeSchema>;

export const RetentionReasonCodeSchema = z.enum([
  'policy_keep_mode',
  'policy_not_effective',
  'within_horizon',
  'expired_tombstone',
  'expired_delete',
]);
export type RetentionReasonCode = z.infer<typeof RetentionReasonCodeSchema>;

export const RetentionPolicySchema = z.object({
  projectId: z.string().min(1),
  evidenceClass: RetentionEvidenceClassSchema.or(z.literal('all')),
  horizonDays: z.number().int().nonnegative(),
  disposalMode: RetentionDisposalModeSchema,
  effectiveAt: z.string(),
}).strict();
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const RetentionCandidateSchema = z.object({
  evidenceClass: RetentionEvidenceClassSchema,
  objectRef: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  createdAt: z.string(),
  auditSequence: z.number().int().positive().nullable().optional(),
  chainHash: z.string().nullable().optional(),
}).strict();
export type RetentionCandidate = z.infer<typeof RetentionCandidateSchema>;

export const RetentionActionSchema = z.object({
  action: RetentionDisposalModeSchema,
  reasonCode: RetentionReasonCodeSchema,
  evidenceClass: RetentionEvidenceClassSchema,
  objectRef: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  createdAt: z.string(),
}).strict();
export type RetentionAction = z.infer<typeof RetentionActionSchema>;

export const RetentionSummarySchema = z.object({
  projectId: z.string().min(1),
  evidenceClass: RetentionEvidenceClassSchema.or(z.literal('all')),
  disposalMode: RetentionDisposalModeSchema,
  cutoff: z.string(),
  evaluated: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  tombstoned: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  checkpoints: z.array(AuditLogIntegrityCheckpointSchema),
  actions: z.array(RetentionActionSchema),
}).strict();
export type RetentionSummary = z.infer<typeof RetentionSummarySchema>;

export interface RetentionExecutor {
  keep?(action: RetentionAction): Promise<void>;
  tombstone?(action: RetentionAction): Promise<void>;
  delete?(action: RetentionAction): Promise<void>;
  checkpoint?(checkpoint: AuditLogIntegrityCheckpoint): Promise<void>;
}

export function auditLogRecordToRetentionCandidate(
  row: AuditLogRecord,
): RetentionCandidate {
  return {
    evidenceClass: 'audit_log',
    objectRef: row.id,
    projectId: row.projectId,
    runId: row.runId,
    createdAt: row.createdAt,
    auditSequence: row.auditSequence ?? null,
    chainHash: row.chainHash ?? null,
  };
}

export function planRetention(
  policyInput: RetentionPolicy,
  candidatesInput: readonly RetentionCandidate[],
  nowIso: string,
): RetentionSummary {
  const policy = RetentionPolicySchema.parse(policyInput);
  const candidates = candidatesInput.map((c) => RetentionCandidateSchema.parse(c));
  const cutoff = retentionCutoffIso(nowIso, policy.horizonDays);
  const actions = candidates
    .filter((c) => c.projectId === policy.projectId)
    .filter((c) => policy.evidenceClass === 'all' || c.evidenceClass === policy.evidenceClass)
    .map((candidate) => decideRetentionAction(policy, candidate, nowIso, cutoff));
  const checkpoints = buildAuditLogCheckpoints(actions, candidates, nowIso);
  return RetentionSummarySchema.parse({
    projectId: policy.projectId,
    evidenceClass: policy.evidenceClass,
    disposalMode: policy.disposalMode,
    cutoff,
    evaluated: actions.length,
    kept: actions.filter((a) => a.action === 'keep').length,
    tombstoned: actions.filter((a) => a.action === 'tombstone').length,
    deleted: actions.filter((a) => a.action === 'delete').length,
    checkpoints,
    actions,
  });
}

export async function enforceRetention(
  policy: RetentionPolicy,
  candidates: readonly RetentionCandidate[],
  executor: RetentionExecutor,
  nowIso: string,
): Promise<RetentionSummary> {
  const summary = planRetention(policy, candidates, nowIso);
  for (const checkpoint of summary.checkpoints) {
    await executor.checkpoint?.(checkpoint);
  }
  for (const action of summary.actions) {
    if (action.action === 'keep') await executor.keep?.(action);
    if (action.action === 'tombstone') await executor.tombstone?.(action);
    if (action.action === 'delete') await executor.delete?.(action);
  }
  return summary;
}

function decideRetentionAction(
  policy: RetentionPolicy,
  candidate: RetentionCandidate,
  nowIso: string,
  cutoff: string,
): RetentionAction {
  if (nowIso < policy.effectiveAt) {
    return actionFor(candidate, 'keep', 'policy_not_effective');
  }
  if (policy.disposalMode === 'keep') {
    return actionFor(candidate, 'keep', 'policy_keep_mode');
  }
  if (candidate.createdAt > cutoff) {
    return actionFor(candidate, 'keep', 'within_horizon');
  }
  if (policy.disposalMode === 'tombstone') {
    return actionFor(candidate, 'tombstone', 'expired_tombstone');
  }
  return actionFor(candidate, 'delete', 'expired_delete');
}

function actionFor(
  candidate: RetentionCandidate,
  action: RetentionDisposalMode,
  reasonCode: RetentionReasonCode,
): RetentionAction {
  return {
    action,
    reasonCode,
    evidenceClass: candidate.evidenceClass,
    objectRef: candidate.objectRef,
    projectId: candidate.projectId,
    runId: candidate.runId,
    createdAt: candidate.createdAt,
  };
}

function retentionCutoffIso(nowIso: string, horizonDays: number): string {
  const now = new Date(nowIso);
  return new Date(now.getTime() - horizonDays * 24 * 60 * 60 * 1000).toISOString();
}

function buildAuditLogCheckpoints(
  actions: readonly RetentionAction[],
  candidates: readonly RetentionCandidate[],
  nowIso: string,
): AuditLogIntegrityCheckpoint[] {
  const removed = new Set(
    actions
      .filter((a) => a.evidenceClass === 'audit_log' && a.action !== 'keep')
      .map((a) => a.objectRef),
  );
  const byRun = new Map<string, RetentionCandidate[]>();
  for (const candidate of candidates) {
    if (!removed.has(candidate.objectRef) || candidate.runId == null) continue;
    if (candidate.auditSequence == null || candidate.chainHash == null) continue;
    const key = `${candidate.projectId}\u0000${candidate.runId}`;
    const group = byRun.get(key);
    if (group) group.push(candidate);
    else byRun.set(key, [candidate]);
  }
  return Array.from(byRun.values()).map((rows) => {
    const sorted = rows.slice().sort((a, b) => (a.auditSequence ?? 0) - (b.auditSequence ?? 0));
    const last = sorted[sorted.length - 1]!;
    return {
      projectId: last.projectId,
      runId: last.runId!,
      coveredUntil: last.createdAt,
      lastAuditSequence: last.auditSequence!,
      terminalChainHash: last.chainHash!,
      rowCount: sorted.length,
      createdAt: nowIso,
    };
  });
}
