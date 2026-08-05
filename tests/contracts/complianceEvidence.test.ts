import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';
import { buildAccessEvidenceReport } from '../../src/hoplon/contracts/complianceEvidence.js';

function policyRow(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId: 'proj-access',
    runId: 'run-access',
    engineId: 'engine-access',
    correlationId: 'corr-access',
    operation: 'POLICY_ACCESS_CHECK',
    result: 'GRANTED',
    violationCount: 0,
    violationKinds: [],
    durationMs: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    policyEvent: {
      reasonCode: 'access_granted',
      requestedAction: 'read',
      folder: 'src',
      principalId: 'alice',
      resolvedAccess: 'read_only',
      engagementId: 'engagement-private',
      detail: null,
    },
    ...overrides,
  };
}

function proofEvent(overrides: Partial<ProofAccessAuditEvent> = {}): ProofAccessAuditEvent {
  return {
    principalId: 'alice',
    engineId: 'engine-access',
    accessClass: 'raw_proof',
    objectType: 'proof_bundle',
    objectRef: 'proof-1',
    projectId: 'proj-access',
    runId: 'run-access',
    correlationId: 'corr-access',
    requestedAt: '2026-04-01T00:01:00.000Z',
    outcome: 'GRANTED',
    reasonCode: 'access_granted',
    detail: null,
    ...overrides,
  };
}

describe('SOC2 per-principal access evidence (t-137)', () => {
  it('groups policy and proof/export access by principal', () => {
    const report = buildAccessEvidenceReport({
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-01T00:10:00.000Z',
      limit: 50,
      policyAuditRows: [
        policyRow(),
        policyRow({
          id: randomUUID(),
          result: 'DENIED',
          createdAt: '2026-04-01T00:02:00.000Z',
          policyEvent: {
            reasonCode: 'access_scope_mismatch_access',
            requestedAction: 'edit',
            folder: 'src',
            principalId: 'bob',
            resolvedAccess: 'read_only',
            engagementId: null,
            detail: null,
          },
        }),
      ],
      proofAccessEvents: [
        proofEvent(),
        proofEvent({
          principalId: 'bob',
          accessClass: 'export',
          objectType: 'export_bundle',
          objectRef: 'exec-1',
          requestedAt: '2026-04-01T00:03:00.000Z',
          outcome: 'DENIED',
          reasonCode: 'missing_role',
        }),
      ],
    });

    expect(report.totalEntries).toBe(4);
    const alice = report.principals.find((p) => p.principalId === 'alice');
    const bob = report.principals.find((p) => p.principalId === 'bob');
    expect(alice).toMatchObject({ total: 2, granted: 2, denied: 0 });
    expect(bob).toMatchObject({ total: 2, granted: 0, denied: 2 });
  });

  it('applies time window and bounded limit deterministically', () => {
    const report = buildAccessEvidenceReport({
      since: '2026-04-01T00:01:00.000Z',
      until: '2026-04-01T00:03:00.000Z',
      limit: 1,
      policyAuditRows: [
        policyRow({ createdAt: '2026-04-01T00:00:00.000Z' }),
        policyRow({ id: randomUUID(), createdAt: '2026-04-01T00:02:00.000Z' }),
      ],
      proofAccessEvents: [
        proofEvent({ requestedAt: '2026-04-01T00:03:30.000Z' }),
      ],
    });

    expect(report.totalEntries).toBe(1);
    expect(report.principals[0]?.entries[0]?.createdAt).toBe('2026-04-01T00:02:00.000Z');
  });

  it('does not expose engagement ids, tokens, source slices, or raw proof content', () => {
    const report = buildAccessEvidenceReport({
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-01T00:10:00.000Z',
      limit: 10,
      policyAuditRows: [policyRow()],
      proofAccessEvents: [proofEvent()],
    });

    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain('engagement-private');
    expect(encoded).not.toContain('token');
    expect(encoded).not.toContain('sourceSlice');
    expect(encoded).not.toContain('auditResult');
  });
});
