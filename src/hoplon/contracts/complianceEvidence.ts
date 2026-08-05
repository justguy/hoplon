/**
 * contracts/complianceEvidence.ts — per-principal SOC2 access evidence.
 *
 * Builds H13-safe reviewer evidence from existing policy audit rows and
 * proof/export access audit events. It contains no raw proof, source slices,
 * tokens, rule bodies, or request bodies.
 */

import { z } from 'zod';
import type { AuditLogRecord } from './auditLog.js';
import type { ProofAccessAuditEvent } from './complianceAccess.js';
import { ProofAccessAuditEventSchema } from './complianceAccess.js';

export const AccessEvidenceEntrySchema = z.object({
  principalId: z.string().nullable(),
  engineId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().nullable(),
  source: z.enum(['policy_audit', 'proof_access']),
  action: z.string().min(1),
  accessClass: z.string().nullable(),
  objectRef: z.string().nullable(),
  outcome: z.string().min(1),
  reasonCode: z.string().min(1),
  createdAt: z.string(),
}).strict();
export type AccessEvidenceEntry = z.infer<typeof AccessEvidenceEntrySchema>;

export const AccessEvidencePrincipalSummarySchema = z.object({
  principalId: z.string().nullable(),
  total: z.number().int().nonnegative(),
  granted: z.number().int().nonnegative(),
  denied: z.number().int().nonnegative(),
  entries: z.array(AccessEvidenceEntrySchema),
}).strict();
export type AccessEvidencePrincipalSummary = z.infer<
  typeof AccessEvidencePrincipalSummarySchema
>;

export const AccessEvidenceReportSchema = z.object({
  since: z.string(),
  until: z.string(),
  limit: z.number().int().positive(),
  totalEntries: z.number().int().nonnegative(),
  principals: z.array(AccessEvidencePrincipalSummarySchema),
}).strict();
export type AccessEvidenceReport = z.infer<typeof AccessEvidenceReportSchema>;

export function buildAccessEvidenceReport(input: {
  since: string;
  until: string;
  limit: number;
  policyAuditRows?: readonly AuditLogRecord[];
  proofAccessEvents?: readonly ProofAccessAuditEvent[];
}): AccessEvidenceReport {
  const limit = Math.max(1, Math.min(input.limit, 500));
  const entries = [
    ...(input.policyAuditRows ?? []).flatMap(policyRowToEntry),
    ...(input.proofAccessEvents ?? []).map(proofAccessEventToEntry),
  ]
    .filter((entry) => entry.createdAt >= input.since && entry.createdAt <= input.until)
    .sort(compareAccessEvidenceEntries)
    .slice(0, limit);

  const groups = new Map<string, AccessEvidenceEntry[]>();
  for (const entry of entries) {
    const key = entry.principalId ?? '__none__';
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const principals = Array.from(groups.values()).map((group) => {
    const principalId = group[0]?.principalId ?? null;
    return AccessEvidencePrincipalSummarySchema.parse({
      principalId,
      total: group.length,
      granted: group.filter((entry) => isGrant(entry.outcome)).length,
      denied: group.filter((entry) => !isGrant(entry.outcome)).length,
      entries: group,
    });
  });

  return AccessEvidenceReportSchema.parse({
    since: input.since,
    until: input.until,
    limit,
    totalEntries: entries.length,
    principals,
  });
}

function policyRowToEntry(row: AuditLogRecord): AccessEvidenceEntry[] {
  if (!row.operation.startsWith('POLICY_') || row.policyEvent == null) return [];
  return [
    AccessEvidenceEntrySchema.parse({
      principalId: row.policyEvent.principalId,
      engineId: row.engineId,
      projectId: row.projectId,
      runId: row.runId,
      source: 'policy_audit',
      action: row.policyEvent.requestedAction,
      accessClass: row.policyEvent.resolvedAccess,
      objectRef: row.policyEvent.folder,
      outcome: row.result,
      reasonCode: row.policyEvent.reasonCode,
      createdAt: row.createdAt,
    }),
  ];
}

function proofAccessEventToEntry(eventInput: ProofAccessAuditEvent): AccessEvidenceEntry {
  const event = ProofAccessAuditEventSchema.parse(eventInput);
  return AccessEvidenceEntrySchema.parse({
    principalId: event.principalId,
    engineId: event.engineId,
    projectId: event.projectId ?? 'unknown',
    runId: event.runId,
    source: 'proof_access',
    action: event.objectType,
    accessClass: event.accessClass,
    objectRef: event.objectRef,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    createdAt: event.requestedAt,
  });
}

function isGrant(outcome: string): boolean {
  return outcome === 'GRANTED' || outcome === 'PASS';
}

function compareAccessEvidenceEntries(
  a: AccessEvidenceEntry,
  b: AccessEvidenceEntry,
): number {
  return (a.principalId ?? '').localeCompare(b.principalId ?? '')
    || a.createdAt.localeCompare(b.createdAt)
    || a.source.localeCompare(b.source)
    || (a.objectRef ?? '').localeCompare(b.objectRef ?? '');
}
