/**
 * tests/operations/predictViolationRisk.test.ts — t-036 advisory predictor proof.
 *
 * Proof requirements:
 *   VP-1  Noop default returns a zero-risk advisory prediction.
 *   VP-2  Base-rate predictor: higher historical BLOCK rate → higher probability.
 *   VP-3  Base-rate predictor: empty history → probability=0, sampleSize=0, band=low.
 *   VP-4  Per-kind probabilities reflect historical violationKinds.
 *   VP-5  `advisory: true` is a schema invariant — an adapter that returns
 *         advisory=false is rejected before reaching the caller.
 *   VP-6  Small-sample clamp: below minSampleSize the band is pinned to 'low'.
 *   VP-7  Emitter events are H13-compliant (no symbol names, paths, content).
 *   VP-8  Invalid request → ValidationError with kind 'invalid_manifest'.
 *   VP-9  proposedFeatures.projectId must match top-level projectId.
 */

import { describe, it, expect } from 'vitest';

import {
  predictViolationRisk,
  type PredictViolationRiskDeps,
} from '../../src/hoplon/operations/predictViolationRisk.js';
import {
  createNoopViolationPredictor,
  createBaseRateViolationPredictor,
  type ViolationPredictorAdapter,
} from '../../src/hoplon/adapters/violationPredictor.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type {
  PredictViolationRiskRequest,
  ViolationPrediction,
} from '../../src/hoplon/contracts/violationPredictor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuditRowInit = {
  id: string;
  result: 'PASS' | 'BLOCK' | 'ERROR';
  kinds?: string[];
  manifestScopeRatio?: number | null;
};

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function auditRow(init: AuditRowInit, projectId = 'proj-vp'): AuditLogRecord {
  return {
    id: nextUuid(),
    snapshotId: `snap-${init.id}`,
    projectId,
    runId: `run-${init.id}`,
    engineId: 'engine-vp-test',
    correlationId: `corr-${init.id}`,
    operation: 'AUDIT_DIFF',
    result: init.result,
    violationCount: init.kinds?.length ?? 0,
    violationKinds: init.kinds ?? [],
    durationMs: 12,
    createdAt: '2026-04-16T12:00:00.000Z',
    astNodeCount: 100,
    fileLineCount: 80,
    manifestScopeRatio:
      init.manifestScopeRatio === undefined ? 0.5 : init.manifestScopeRatio,
  };
}

function makeDeps(
  adapter: ViolationPredictorAdapter,
): {
  deps: PredictViolationRiskDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  return {
    deps: {
      violationPredictor: adapter,
      emitter,
      engineId: 'engine-vp-test',
    },
    emitter,
  };
}

function req(
  overrides: Partial<PredictViolationRiskRequest> = {},
): PredictViolationRiskRequest {
  return {
    correlationId: 'corr-vp-001',
    projectId: 'proj-vp',
    historicalRecords: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('predictViolationRisk', () => {
  it('VP-1: noop default returns zero-risk advisory', async () => {
    const { deps } = makeDeps(createNoopViolationPredictor());
    const prediction = await predictViolationRisk(deps, req());
    expect(prediction.probability).toBe(0);
    expect(prediction.riskBand).toBe('low');
    expect(prediction.advisory).toBe(true);
    expect(prediction.sampleSize).toBe(0);
    expect(prediction.perKindProbabilities).toEqual({});
    expect(prediction.featuresUsed.projectId).toBe('proj-vp');
  });

  it('VP-2: base-rate predictor biases probability upward with BLOCK history', async () => {
    const { deps } = makeDeps(createBaseRateViolationPredictor());
    const cleanHistory = Array.from({ length: 8 }, (_, i) =>
      auditRow({ id: `clean-${i}`, result: 'PASS' }),
    );
    const dirtyHistory = Array.from({ length: 8 }, (_, i) =>
      auditRow({
        id: `dirty-${i}`,
        result: i < 6 ? 'BLOCK' : 'PASS',
        kinds: i < 6 ? ['out_of_scope_symbol'] : [],
      }),
    );
    const clean = await predictViolationRisk(
      deps,
      req({ historicalRecords: cleanHistory, correlationId: 'corr-vp-clean' }),
    );
    const dirty = await predictViolationRisk(
      deps,
      req({ historicalRecords: dirtyHistory, correlationId: 'corr-vp-dirty' }),
    );
    expect(dirty.probability).toBeGreaterThan(clean.probability);
    expect(clean.advisory).toBe(true);
    expect(dirty.advisory).toBe(true);
    expect(dirty.sampleSize).toBe(8);
    expect(dirty.riskBand).toBe('high');
    expect(clean.riskBand).toBe('low');
  });

  it('VP-3: empty history → sampleSize 0, probability 0, band low, advisory true', async () => {
    const { deps } = makeDeps(createBaseRateViolationPredictor());
    const prediction = await predictViolationRisk(
      deps,
      req({ historicalRecords: [] }),
    );
    expect(prediction.sampleSize).toBe(0);
    expect(prediction.probability).toBe(0);
    expect(prediction.riskBand).toBe('low');
    expect(prediction.advisory).toBe(true);
    expect(prediction.perKindProbabilities).toEqual({});
  });

  it('VP-4: per-kind probabilities mirror historical violationKinds', async () => {
    const { deps } = makeDeps(createBaseRateViolationPredictor());
    const history = [
      auditRow({ id: 'a', result: 'BLOCK', kinds: ['out_of_scope_symbol'] }),
      auditRow({ id: 'b', result: 'BLOCK', kinds: ['out_of_scope_symbol', 'path_escape'] }),
      auditRow({ id: 'c', result: 'BLOCK', kinds: ['path_escape'] }),
      auditRow({ id: 'd', result: 'PASS' }),
    ];
    const prediction = await predictViolationRisk(
      deps,
      req({ historicalRecords: history }),
    );
    expect(prediction.sampleSize).toBe(4);
    expect(prediction.perKindProbabilities.out_of_scope_symbol).toBeCloseTo(2 / 4);
    expect(prediction.perKindProbabilities.path_escape).toBeCloseTo(2 / 4);
    expect(Object.keys(prediction.perKindProbabilities)).not.toContain('never_seen_kind');
  });

  it('VP-5: adapter returning advisory=false is rejected by schema invariant', async () => {
    const rogueAdapter: ViolationPredictorAdapter = {
      async predict() {
        return {
          probability: 0.9,
          riskBand: 'high',
          // Deliberately violate the schema invariant.
          advisory: false as unknown as true,
          sampleSize: 10,
          perKindProbabilities: {},
          featuresUsed: { projectId: 'proj-vp' },
          reason: 'rogue adapter tried to flip advisory',
        } as unknown as ViolationPrediction;
      },
    };
    const { deps } = makeDeps(rogueAdapter);
    await expect(predictViolationRisk(deps, req())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('VP-6: sample below minSampleSize clamps band to low even with BLOCK rows', async () => {
    const { deps } = makeDeps(
      createBaseRateViolationPredictor({ minSampleSize: 5 }),
    );
    const prediction = await predictViolationRisk(
      deps,
      req({
        historicalRecords: [
          auditRow({ id: 'sparse-1', result: 'BLOCK', kinds: ['out_of_scope_symbol'] }),
          auditRow({ id: 'sparse-2', result: 'BLOCK', kinds: ['path_escape'] }),
        ],
      }),
    );
    expect(prediction.sampleSize).toBe(2);
    expect(prediction.riskBand).toBe('low');
    expect(prediction.advisory).toBe(true);
  });

  it('VP-7: emitted events are H13-compliant and carry correlation context', async () => {
    const { deps, emitter } = makeDeps(createBaseRateViolationPredictor());
    await predictViolationRisk(
      deps,
      req({
        correlationId: 'corr-vp-h13',
        historicalRecords: [
          auditRow({ id: 'h13-1', result: 'PASS' }),
          auditRow({ id: 'h13-2', result: 'BLOCK', kinds: ['out_of_scope_symbol'] }),
        ],
      }),
    );
    const events = emitter
      .getEvents()
      .filter((e) => e.op === 'predictViolationRisk');
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    for (const e of events) {
      assertEventIsContentFree(e);
      expect(e.correlationId).toBe('corr-vp-h13');
      expect(e.engineId).toBe('engine-vp-test');
      expect(e.projectId).toBe('proj-vp');
    }
  });

  it('VP-8: invalid request (missing projectId) → ValidationError invalid_manifest', async () => {
    const { deps } = makeDeps(createNoopViolationPredictor());
    await expect(
      predictViolationRisk(
        deps,
        {
          correlationId: 'corr-vp-bad',
          historicalRecords: [],
        } as unknown as PredictViolationRiskRequest,
      ),
    ).rejects.toMatchObject({ kind: 'invalid_manifest' });
  });

  it('VP-9: rejects mismatched proposedFeatures.projectId', async () => {
    const { deps } = makeDeps(createBaseRateViolationPredictor());
    await expect(
      predictViolationRisk(
        deps,
        req({
          projectId: 'proj-vp',
          proposedFeatures: {
            projectId: 'proj-other',
            manifestScopeRatio: 0.2,
          },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_manifest' });
  });
});
