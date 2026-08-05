import { describe, expect, it } from 'vitest';

import {
  authorizeAndAuditProofAccess,
  roleBasedProofAccessPolicy,
} from '../../src/hoplon/contracts/complianceAccess.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';

const BASE_REQUEST = {
  principalId: 'compliance',
  engineId: 'engine-access',
  accessClass: 'raw_proof',
  objectType: 'proof_bundle',
  objectRef: 'proof-1',
  projectId: 'proj-access',
  runId: 'run-access',
  correlationId: 'corr-access',
  requestedAt: '2026-04-01T00:00:00.000Z',
} as const;

describe('SOC2 proof/export access contracts (t-136)', () => {
  it('grants and writes an H13-safe proof access audit event', async () => {
    const events: ProofAccessAuditEvent[] = [];
    const decision = await authorizeAndAuditProofAccess(
      BASE_REQUEST,
      roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: ['compliance'],
        source_slice: [],
        export: [],
      }),
      { appendProofAccessAudit: async (event) => { events.push(event); } },
    );

    expect(decision.outcome).toBe('GRANTED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      principalId: 'compliance',
      accessClass: 'raw_proof',
      objectRef: 'proof-1',
      outcome: 'GRANTED',
      reasonCode: 'access_granted',
    });
    expect(JSON.stringify(events[0])).not.toContain('sourceSlice');
  });

  it('denies missing roles and still writes the denial audit event', async () => {
    const events: ProofAccessAuditEvent[] = [];
    const decision = await authorizeAndAuditProofAccess(
      { ...BASE_REQUEST, principalId: 'viewer' },
      roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: ['compliance'],
        source_slice: [],
        export: [],
      }),
      { appendProofAccessAudit: async (event) => { events.push(event); } },
    );

    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasonCode).toBe('missing_role');
    expect(events[0]).toMatchObject({
      principalId: 'viewer',
      outcome: 'DENIED',
      reasonCode: 'missing_role',
    });
  });

  it('fails closed when the audit sink cannot write', async () => {
    const decision = await authorizeAndAuditProofAccess(
      BASE_REQUEST,
      roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: ['compliance'],
        source_slice: [],
        export: [],
      }),
      { appendProofAccessAudit: async () => { throw new Error('boom'); } },
    );

    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasonCode).toBe('audit_write_failed');
  });
});
