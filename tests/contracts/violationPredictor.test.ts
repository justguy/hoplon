/**
 * tests/contracts/violationPredictor.test.ts — Zod round-trip + invariant proof.
 */

import { describe, expect, it } from 'vitest';
import {
  PredictViolationRiskRequestSchema,
  ViolationPredictionSchema,
} from '../../src/hoplon/contracts/violationPredictor.js';

describe('PredictViolationRiskRequestSchema', () => {
  it('accepts a minimal request', () => {
    const parsed = PredictViolationRiskRequestSchema.parse({
      correlationId: 'corr-vp-contract',
      projectId: 'proj-vp-contract',
      historicalRecords: [],
    });
    expect(parsed.projectId).toBe('proj-vp-contract');
    expect(parsed.historicalRecords).toEqual([]);
  });

  it('rejects mismatched proposedFeatures.projectId', () => {
    const result = PredictViolationRiskRequestSchema.safeParse({
      correlationId: 'corr-vp-contract',
      projectId: 'proj-vp-contract',
      proposedFeatures: {
        projectId: 'proj-other',
        manifestScopeRatio: 0.5,
      },
      historicalRecords: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('ViolationPredictionSchema', () => {
  it('accepts a well-formed advisory prediction', () => {
    const parsed = ViolationPredictionSchema.parse({
      probability: 0.25,
      riskBand: 'medium',
      advisory: true,
      sampleSize: 8,
      perKindProbabilities: { out_of_scope_symbol: 0.25 },
      featuresUsed: { projectId: 'proj-vp-contract', manifestScopeRatio: 0.5 },
      reason: 'base-rate 2/8=0.250',
    });
    expect(parsed.advisory).toBe(true);
  });

  it('rejects advisory=false', () => {
    const result = ViolationPredictionSchema.safeParse({
      probability: 0.9,
      riskBand: 'high',
      advisory: false,
      sampleSize: 4,
      perKindProbabilities: {},
      featuresUsed: { projectId: 'proj-vp-contract' },
      reason: 'rogue',
    });
    expect(result.success).toBe(false);
  });
});
