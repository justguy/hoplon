/**
 * contracts/soc2EvidenceBundle.ts — deterministic SOC2 JSON evidence bundle.
 *
 * The bundle is a reporting layer over existing evidence primitives. It carries
 * H13-safe summaries and stable Flight Recorder refs, not raw proof payloads.
 */

import { z } from 'zod';
import {
  AuditLogIntegrityResultSchema,
  type AuditLogIntegrityResult,
} from './compliance.js';
import {
  RetentionSummarySchema,
  type RetentionSummary,
} from './complianceRetention.js';
import {
  AccessEvidenceReportSchema,
  type AccessEvidenceReport,
} from './complianceEvidence.js';
import {
  ProofAccessAuditEventSchema,
  type ProofAccessAuditEvent,
} from './complianceAccess.js';

export const Soc2ControlIdSchema = z.enum([
  'security.audit_integrity',
  'security.retention',
  'security.access_control',
  'security.proof_export_audit',
  'availability.trace_refs',
  'confidentiality.data_residency',
]);
export type Soc2ControlId = z.infer<typeof Soc2ControlIdSchema>;

export const Soc2EvidenceRefSchema = z.object({
  type: z.enum(['audit_log', 'trace_execution', 'proof_bundle', 'retention_checkpoint']),
  ref: z.string().min(1),
}).strict();
export type Soc2EvidenceRef = z.infer<typeof Soc2EvidenceRefSchema>;

export const Soc2ControlEvidenceSchema = z.object({
  controlId: Soc2ControlIdSchema,
  status: z.enum(['supported', 'partial', 'unsupported']),
  evidenceRefs: z.array(Soc2EvidenceRefSchema),
  summary: z.string().min(1),
}).strict();
export type Soc2ControlEvidence = z.infer<typeof Soc2ControlEvidenceSchema>;

export const Soc2EvidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  framework: z.literal('SOC2'),
  generatedAt: z.string(),
  since: z.string(),
  until: z.string(),
  projectId: z.string().min(1),
  auditLogIntegrity: AuditLogIntegrityResultSchema,
  retention: RetentionSummarySchema,
  accessEvidence: AccessEvidenceReportSchema,
  proofAccessAudit: z.array(ProofAccessAuditEventSchema),
  traceRefs: z.array(Soc2EvidenceRefSchema),
  controls: z.array(Soc2ControlEvidenceSchema),
  storageResidency: z.object({
    status: z.enum(['supported', 'unsupported']),
    region: z.string().nullable(),
    detail: z.string().min(1),
  }).strict(),
}).strict();
export type Soc2EvidenceBundle = z.infer<typeof Soc2EvidenceBundleSchema>;

export function exportComplianceReport(input: {
  framework: 'SOC2';
  generatedAt: string;
  since: string;
  until: string;
  projectId: string;
  auditLogIntegrity: AuditLogIntegrityResult;
  retention: RetentionSummary;
  accessEvidence: AccessEvidenceReport;
  proofAccessAudit: readonly ProofAccessAuditEvent[];
  traceRefs: readonly Soc2EvidenceRef[];
  storageRegion?: string | null;
}): Soc2EvidenceBundle {
  const traceRefs = sortRefs(input.traceRefs);
  const proofAccessAudit = [...input.proofAccessAudit].sort((a, b) =>
    a.requestedAt.localeCompare(b.requestedAt)
    || a.accessClass.localeCompare(b.accessClass)
    || a.objectRef.localeCompare(b.objectRef),
  );
  return Soc2EvidenceBundleSchema.parse({
    schemaVersion: 1,
    framework: 'SOC2',
    generatedAt: input.generatedAt,
    since: input.since,
    until: input.until,
    projectId: input.projectId,
    auditLogIntegrity: input.auditLogIntegrity,
    retention: input.retention,
    accessEvidence: input.accessEvidence,
    proofAccessAudit,
    traceRefs,
    controls: buildControls(input, traceRefs),
    storageResidency: input.storageRegion
      ? {
          status: 'supported',
          region: input.storageRegion,
          detail: 'Deployment supplied storage-region metadata.',
        }
      : {
          status: 'unsupported',
          region: null,
          detail: 'No storage-region metadata was supplied for this bundle.',
        },
  });
}

function buildControls(
  input: Parameters<typeof exportComplianceReport>[0],
  traceRefs: Soc2EvidenceRef[],
): Soc2ControlEvidence[] {
  return [
    {
      controlId: 'security.audit_integrity',
      status: input.auditLogIntegrity.status === 'PASS' ? 'supported' : 'partial',
      evidenceRefs: [{ type: 'audit_log', ref: `${input.projectId}:${input.since}:${input.until}` }],
      summary: `Audit-log integrity status: ${input.auditLogIntegrity.status}.`,
    },
    {
      controlId: 'security.retention',
      status: input.retention.deleted + input.retention.tombstoned + input.retention.kept >= 0
        ? 'supported'
        : 'partial',
      evidenceRefs: input.retention.checkpoints.map((c) => ({
        type: 'retention_checkpoint' as const,
        ref: `${c.projectId}:${c.runId}:${c.lastAuditSequence}`,
      })),
      summary: `Retention evaluated ${input.retention.evaluated} evidence records.`,
    },
    {
      controlId: 'security.access_control',
      status: input.accessEvidence.totalEntries > 0 ? 'supported' : 'partial',
      evidenceRefs: [],
      summary: `Access evidence covers ${input.accessEvidence.principals.length} principals.`,
    },
    {
      controlId: 'security.proof_export_audit',
      status: input.proofAccessAudit.length > 0 ? 'supported' : 'partial',
      evidenceRefs: input.proofAccessAudit.map((e) => ({
        type: e.objectType === 'proof_bundle' ? 'proof_bundle' : 'trace_execution',
        ref: e.objectRef,
      })),
      summary: `Proof/export audit contains ${input.proofAccessAudit.length} access events.`,
    },
    {
      controlId: 'availability.trace_refs',
      status: traceRefs.length > 0 ? 'supported' : 'partial',
      evidenceRefs: traceRefs,
      summary: `Bundle links ${traceRefs.length} stable Flight Recorder refs.`,
    },
    {
      controlId: 'confidentiality.data_residency',
      status: input.storageRegion ? 'supported' : 'unsupported',
      evidenceRefs: [],
      summary: input.storageRegion
        ? `Storage region metadata supplied: ${input.storageRegion}.`
        : 'Storage-region metadata is not available in this deployment.',
    },
  ].map((control) => Soc2ControlEvidenceSchema.parse(control));
}

function sortRefs(refs: readonly Soc2EvidenceRef[]): Soc2EvidenceRef[] {
  return refs
    .map((ref) => Soc2EvidenceRefSchema.parse(ref))
    .sort((a, b) => a.type.localeCompare(b.type) || a.ref.localeCompare(b.ref));
}
