import { describe, expect, it } from 'vitest';

import {
  Soc2EvidenceBundleSchema,
  exportComplianceReport,
} from '../../src/hoplon/contracts/soc2EvidenceBundle.js';
import type { AuditLogIntegrityResult } from '../../src/hoplon/contracts/compliance.js';
import type { RetentionSummary } from '../../src/hoplon/contracts/complianceRetention.js';
import type { AccessEvidenceReport } from '../../src/hoplon/contracts/complianceEvidence.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';

const integrity: AuditLogIntegrityResult = {
  status: 'PASS',
  projectId: 'proj-soc2',
  runId: null,
  checkedRows: 3,
  uncheckedRows: 0,
  failures: [],
};

const retention: RetentionSummary = {
  projectId: 'proj-soc2',
  evidenceClass: 'all',
  disposalMode: 'tombstone',
  cutoff: '2026-03-01T00:00:00.000Z',
  evaluated: 2,
  kept: 1,
  tombstoned: 1,
  deleted: 0,
  checkpoints: [
    {
      projectId: 'proj-soc2',
      runId: 'run-soc2',
      coveredUntil: '2026-02-01T00:00:00.000Z',
      lastAuditSequence: 1,
      terminalChainHash: 'hash-1',
      rowCount: 1,
      createdAt: '2026-04-01T00:00:00.000Z',
    },
  ],
  actions: [],
};

const accessEvidence: AccessEvidenceReport = {
  since: '2026-04-01T00:00:00.000Z',
  until: '2026-04-02T00:00:00.000Z',
  limit: 100,
  totalEntries: 1,
  principals: [
    {
      principalId: 'compliance',
      total: 1,
      granted: 1,
      denied: 0,
      entries: [
        {
          principalId: 'compliance',
          engineId: 'engine-soc2',
          projectId: 'proj-soc2',
          runId: 'run-soc2',
          source: 'proof_access',
          action: 'proof_bundle',
          accessClass: 'raw_proof',
          objectRef: 'proof-1',
          outcome: 'GRANTED',
          reasonCode: 'access_granted',
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      ],
    },
  ],
};

const proofAccessAudit: ProofAccessAuditEvent[] = [
  {
    principalId: 'compliance',
    engineId: 'engine-soc2',
    accessClass: 'raw_proof',
    objectType: 'proof_bundle',
    objectRef: 'proof-1',
    projectId: 'proj-soc2',
    runId: 'run-soc2',
    correlationId: 'corr-soc2',
    requestedAt: '2026-04-01T00:00:00.000Z',
    outcome: 'GRANTED',
    reasonCode: 'access_granted',
    detail: null,
  },
];

describe('SOC2 evidence bundle exporter (t-138)', () => {
  it('exports a deterministic SOC2 JSON bundle over H13-safe evidence', () => {
    const bundle = exportComplianceReport({
      framework: 'SOC2',
      generatedAt: '2026-04-02T00:00:00.000Z',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-02T00:00:00.000Z',
      projectId: 'proj-soc2',
      auditLogIntegrity: integrity,
      retention,
      accessEvidence,
      proofAccessAudit,
      traceRefs: [
        { type: 'proof_bundle', ref: 'proof-1' },
        { type: 'trace_execution', ref: 'exec-1' },
      ],
      storageRegion: 'us-west-2',
    });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.framework).toBe('SOC2');
    expect(bundle.controls.map((c) => c.controlId)).toEqual([
      'security.audit_integrity',
      'security.retention',
      'security.access_control',
      'security.proof_export_audit',
      'availability.trace_refs',
      'confidentiality.data_residency',
    ]);
    expect(bundle.storageResidency).toMatchObject({
      status: 'supported',
      region: 'us-west-2',
    });
  });

  it('emits honest unsupported residency when no region metadata exists', () => {
    const bundle = exportComplianceReport({
      framework: 'SOC2',
      generatedAt: '2026-04-02T00:00:00.000Z',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-02T00:00:00.000Z',
      projectId: 'proj-soc2',
      auditLogIntegrity: integrity,
      retention,
      accessEvidence,
      proofAccessAudit,
      traceRefs: [],
    });

    expect(bundle.storageResidency.status).toBe('unsupported');
    expect(bundle.controls.find((c) => c.controlId === 'confidentiality.data_residency')?.status)
      .toBe('unsupported');
  });

  it('does not embed raw proof content in the evidence bundle', () => {
    const bundle = exportComplianceReport({
      framework: 'SOC2',
      generatedAt: '2026-04-02T00:00:00.000Z',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-02T00:00:00.000Z',
      projectId: 'proj-soc2',
      auditLogIntegrity: integrity,
      retention,
      accessEvidence,
      proofAccessAudit,
      traceRefs: [{ type: 'proof_bundle', ref: 'proof-1' }],
    });

    const encoded = JSON.stringify(bundle);
    expect(encoded).not.toContain('auditResult');
    expect(encoded).not.toContain('sourceSlice');
    expect(encoded).not.toContain('raw proof body');
  });

  it('rejects malformed nested evidence instead of accepting arbitrary objects', () => {
    const bundle = exportComplianceReport({
      framework: 'SOC2',
      generatedAt: '2026-04-02T00:00:00.000Z',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-02T00:00:00.000Z',
      projectId: 'proj-soc2',
      auditLogIntegrity: integrity,
      retention,
      accessEvidence,
      proofAccessAudit,
      traceRefs: [{ type: 'proof_bundle', ref: 'proof-1' }],
    });

    expect(() => Soc2EvidenceBundleSchema.parse({
      ...bundle,
      auditLogIntegrity: { status: 'PASS' },
    })).toThrow();
    expect(() => Soc2EvidenceBundleSchema.parse({
      ...bundle,
      retention: {
        ...bundle.retention,
        checkpoints: [{ projectId: 'proj-soc2' }],
      },
    })).toThrow();
  });
});
