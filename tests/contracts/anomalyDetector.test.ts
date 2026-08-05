/**
 * tests/contracts/anomalyDetector.test.ts — Zod round-trip + invariant proof.
 */

import { describe, expect, it } from 'vitest';
import {
  ScoreAnomalyRequestSchema,
  AnomalyScoreSchema,
} from '../../src/hoplon/contracts/anomalyDetector.js';

describe('ScoreAnomalyRequestSchema', () => {
  it('accepts a minimal request', () => {
    const parsed = ScoreAnomalyRequestSchema.parse({
      correlationId: 'corr-ad-contract',
      projectId: 'proj-ad-contract',
      historicalRecords: [],
    });
    expect(parsed.projectId).toBe('proj-ad-contract');
    expect(parsed.historicalRecords).toEqual([]);
  });

  it('rejects mismatched proposedMetrics.projectId', () => {
    const result = ScoreAnomalyRequestSchema.safeParse({
      correlationId: 'corr-ad-contract',
      projectId: 'proj-ad-contract',
      proposedMetrics: {
        projectId: 'proj-other',
        astNodeCount: 100,
      },
      historicalRecords: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('AnomalyScoreSchema', () => {
  it('accepts a well-formed advisory score', () => {
    const parsed = AnomalyScoreSchema.parse({
      score: 0.5,
      isAnomalous: true,
      advisory: true,
      sampleSize: 8,
      signals: [
        {
          metric: 'astNodeCount',
          observedValue: 200,
          baselineValue: 100,
          stddev: 10,
          zScore: 10,
          description: 'astNodeCount z=10 exceeds threshold 3',
        },
      ],
      reason: 'sample=8; max-z=10.00; threshold=3; signals=1',
    });
    expect(parsed.advisory).toBe(true);
  });

  it('rejects advisory=false', () => {
    const result = AnomalyScoreSchema.safeParse({
      score: 0.9,
      isAnomalous: true,
      advisory: false,
      sampleSize: 4,
      signals: [],
      reason: 'rogue',
    });
    expect(result.success).toBe(false);
  });
});
