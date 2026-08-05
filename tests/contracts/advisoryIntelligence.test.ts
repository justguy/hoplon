/**
 * tests/contracts/advisoryIntelligence.test.ts — t-101 sidecar invariants.
 */

import { describe, expect, it } from 'vitest';

import {
  AdvisoryEvidenceStateSchema,
  AdvisoryIntelligenceSidecarEnvelopeSchema,
  createAdvisoryEvidenceState,
  createSampleBackedAdvisoryEvidenceState,
  createAdvisoryIntelligenceAuthority,
  createStrictAgentIntelligenceAccess,
} from '../../src/hoplon/contracts/advisoryIntelligence.js';

function makeEnvelope(overrides = {}) {
  return {
    version: 1,
    advisory: true,
    surface: 'read',
    sidecarKind: 'read_semantic_metadata',
    provider: {
      providerId: 'tree-sitter-local',
      status: 'available',
      reason: null,
      detail: null,
    },
    evidence: createAdvisoryEvidenceState({ status: 'AVAILABLE' }),
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
    payload: { symbolCount: 2 },
    ...overrides,
  };
}

describe('AdvisoryIntelligenceSidecarEnvelopeSchema', () => {
  it('accepts the shared advisory sidecar envelope', () => {
    const parsed = AdvisoryIntelligenceSidecarEnvelopeSchema.parse(
      makeEnvelope(),
    );
    expect(parsed.advisory).toBe(true);
    expect(parsed.provider.status).toBe('available');
    expect(parsed.evidence.status).toBe('AVAILABLE');
    expect(parsed.evidence.deterministicVerdict).toBeNull();
    expect(parsed.evidence.representsGreenProof).toBe(false);
    expect(parsed.authority.canMutateFiles).toBe(false);
    expect(parsed.strictAgentAccess.exposesFilesystemTool).toBe(false);
  });

  it('rejects sidecars that claim deterministic authority', () => {
    const parsed = AdvisoryIntelligenceSidecarEnvelopeSchema.safeParse(
      makeEnvelope({
        advisory: false,
        authority: {
          ...createAdvisoryIntelligenceAuthority(),
          canChangeDeterministicVerdict: true,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('requires degraded and unavailable providers to explain the state', () => {
    const parsed = AdvisoryIntelligenceSidecarEnvelopeSchema.safeParse(
      makeEnvelope({
        provider: {
          providerId: 'vector-store',
          status: 'degraded',
          reason: null,
          detail: null,
        },
      }),
    );
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some((issue) => issue.path.join('.') === 'provider.reason'),
    ).toBe(true);
  });

  it('rejects deterministic PASS/FAIL vocabulary in advisory evidence', () => {
    const parsed = AdvisoryEvidenceStateSchema.safeParse({
      status: 'PASS',
      reason: null,
      detail: null,
      deterministicVerdict: null,
      representsGreenProof: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unavailable, empty, and no-verdict evidence as green proof', () => {
    for (const status of ['UNAVAILABLE', 'EMPTY', 'NO_VERDICT'] as const) {
      const parsed = AdvisoryEvidenceStateSchema.safeParse({
        status,
        reason: `${status.toLowerCase()}_fixture`,
        detail: null,
        deterministicVerdict: null,
        representsGreenProof: true,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('requires non-available advisory evidence to carry a reason', () => {
    const parsed = AdvisoryEvidenceStateSchema.safeParse({
      status: 'DEGRADED',
      reason: null,
      detail: null,
      deterministicVerdict: null,
      representsGreenProof: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('classifies zero-sample risk and anomaly outputs as EMPTY evidence', () => {
    const riskEvidence = createSampleBackedAdvisoryEvidenceState({
      sampleSize: 0,
      emptyReason: 'violation_risk_no_history',
    });
    const anomalyEvidence = createSampleBackedAdvisoryEvidenceState({
      sampleSize: 0,
      emptyReason: 'anomaly_no_history',
    });
    const historyBacked = createSampleBackedAdvisoryEvidenceState({
      sampleSize: 3,
      emptyReason: 'not_used',
    });

    expect(riskEvidence.status).toBe('EMPTY');
    expect(anomalyEvidence.status).toBe('EMPTY');
    expect(historyBacked.status).toBe('AVAILABLE');
    expect(riskEvidence.representsGreenProof).toBe(false);
    expect(anomalyEvidence.deterministicVerdict).toBeNull();
  });

  it('rejects direct strict-agent peer tool exposure', () => {
    const parsed = AdvisoryIntelligenceSidecarEnvelopeSchema.safeParse(
      makeEnvelope({
        strictAgentAccess: {
          ...createStrictAgentIntelligenceAccess(),
          exposesFullscopeTool: true,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});
