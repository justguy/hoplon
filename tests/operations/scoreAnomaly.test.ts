/**
 * tests/operations/scoreAnomaly.test.ts — t-037 advisory anomaly detector proof.
 *
 * Proof requirements:
 *   AD-1  Noop default returns a zero-score advisory.
 *   AD-2  Statistical detector flags a proposed metric that is far beyond the
 *         historical mean (spike detection).
 *   AD-3  Empty history → score=0, sampleSize=0, signals=[], advisory=true.
 *   AD-4  Per-metric signals mirror which historical column was breached.
 *   AD-5  `advisory: true` is a schema invariant — an adapter that returns
 *         advisory=false is rejected before reaching the caller.
 *   AD-6  Small-sample clamp: below minSampleSize the detector refuses to fire.
 *   AD-7  Emitter events are H13-compliant (no symbol names, paths, content).
 *   AD-8  Invalid request → ValidationError with kind 'invalid_manifest'.
 *   AD-9  proposedMetrics.projectId must match top-level projectId.
 *   AD-10 perfectly stable baselines still flag anomalous deviations.
 */

import { describe, it, expect } from 'vitest';

import {
  scoreAnomaly,
  type ScoreAnomalyDeps,
} from '../../src/hoplon/operations/scoreAnomaly.js';
import {
  createNoopAnomalyDetector,
  createStatisticalAnomalyDetector,
  type AnomalyDetectorAdapter,
} from '../../src/hoplon/adapters/anomalyDetector.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type {
  ScoreAnomalyRequest,
  AnomalyScore,
} from '../../src/hoplon/contracts/anomalyDetector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuditRowInit = {
  id: string;
  astNodeCount?: number | null;
  fileLineCount?: number | null;
  manifestScopeRatio?: number | null;
};

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function auditRow(init: AuditRowInit, projectId = 'proj-ad'): AuditLogRecord {
  return {
    id: nextUuid(),
    snapshotId: `snap-${init.id}`,
    projectId,
    runId: `run-${init.id}`,
    engineId: 'engine-ad-test',
    correlationId: `corr-${init.id}`,
    operation: 'AUDIT_DIFF',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 12,
    createdAt: '2026-04-16T12:00:00.000Z',
    astNodeCount: init.astNodeCount === undefined ? 100 : init.astNodeCount,
    fileLineCount: init.fileLineCount === undefined ? 80 : init.fileLineCount,
    manifestScopeRatio:
      init.manifestScopeRatio === undefined ? 0.5 : init.manifestScopeRatio,
  };
}

function makeDeps(adapter: AnomalyDetectorAdapter): {
  deps: ScoreAnomalyDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  return {
    deps: {
      anomalyDetector: adapter,
      emitter,
      engineId: 'engine-ad-test',
    },
    emitter,
  };
}

function req(
  overrides: Partial<ScoreAnomalyRequest> = {},
): ScoreAnomalyRequest {
  return {
    correlationId: 'corr-ad-001',
    projectId: 'proj-ad',
    historicalRecords: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreAnomaly', () => {
  it('AD-1: noop default returns zero-score advisory', async () => {
    const { deps } = makeDeps(createNoopAnomalyDetector());
    const score = await scoreAnomaly(deps, req());
    expect(score.score).toBe(0);
    expect(score.isAnomalous).toBe(false);
    expect(score.advisory).toBe(true);
    expect(score.sampleSize).toBe(0);
    expect(score.signals).toEqual([]);
  });

  it('AD-2: statistical detector flags a spike beyond the baseline', async () => {
    const { deps } = makeDeps(createStatisticalAnomalyDetector());
    const history = Array.from({ length: 8 }, (_, i) =>
      auditRow({
        id: `base-${i}`,
        astNodeCount: 100 + i,
        fileLineCount: 80 + i,
        manifestScopeRatio: 0.5,
      }),
    );
    const calm = await scoreAnomaly(
      deps,
      req({
        historicalRecords: history,
        correlationId: 'corr-ad-calm',
        proposedMetrics: {
          projectId: 'proj-ad',
          astNodeCount: 103,
          fileLineCount: 82,
          manifestScopeRatio: 0.5,
        },
      }),
    );
    const spike = await scoreAnomaly(
      deps,
      req({
        historicalRecords: history,
        correlationId: 'corr-ad-spike',
        proposedMetrics: {
          projectId: 'proj-ad',
          astNodeCount: 10_000,
          fileLineCount: 80,
          manifestScopeRatio: 0.5,
        },
      }),
    );
    expect(calm.isAnomalous).toBe(false);
    expect(calm.advisory).toBe(true);
    expect(calm.signals).toEqual([]);
    expect(spike.isAnomalous).toBe(true);
    expect(spike.advisory).toBe(true);
    expect(spike.sampleSize).toBe(8);
    expect(spike.score).toBeGreaterThan(calm.score);
    expect(spike.signals.map((s) => s.metric)).toContain('astNodeCount');
  });

  it('AD-3: empty history → score=0, sampleSize=0, signals=[], advisory=true', async () => {
    const { deps } = makeDeps(createStatisticalAnomalyDetector());
    const score = await scoreAnomaly(
      deps,
      req({ historicalRecords: [] }),
    );
    expect(score.sampleSize).toBe(0);
    expect(score.score).toBe(0);
    expect(score.isAnomalous).toBe(false);
    expect(score.advisory).toBe(true);
    expect(score.signals).toEqual([]);
  });

  it('AD-4: per-metric signals identify the breached historical column', async () => {
    const { deps } = makeDeps(createStatisticalAnomalyDetector());
    const history = Array.from({ length: 8 }, (_, i) =>
      auditRow({
        id: `perm-${i}`,
        astNodeCount: 100 + i,
        fileLineCount: 80 + i,
        manifestScopeRatio: 0.5 + i * 0.0001,
      }),
    );
    const score = await scoreAnomaly(
      deps,
      req({
        historicalRecords: history,
        proposedMetrics: {
          projectId: 'proj-ad',
          astNodeCount: 5000,
          fileLineCount: 80,
          manifestScopeRatio: 0.5,
        },
      }),
    );
    const metrics = score.signals.map((s) => s.metric);
    expect(metrics).toContain('astNodeCount');
    expect(metrics).not.toContain('fileLineCount');
  });

  it('AD-5: adapter returning advisory=false is rejected by schema invariant', async () => {
    const rogueAdapter: AnomalyDetectorAdapter = {
      async score() {
        return {
          score: 0.9,
          isAnomalous: true,
          advisory: false as unknown as true,
          sampleSize: 10,
          signals: [],
          reason: 'rogue adapter tried to flip advisory',
        } as unknown as AnomalyScore;
      },
    };
    const { deps } = makeDeps(rogueAdapter);
    await expect(scoreAnomaly(deps, req())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('AD-6: sample below minSampleSize clamps score to zero even with spike', async () => {
    const { deps } = makeDeps(
      createStatisticalAnomalyDetector({ minSampleSize: 5 }),
    );
    const score = await scoreAnomaly(
      deps,
      req({
        historicalRecords: [
          auditRow({ id: 'sparse-1', astNodeCount: 100 }),
          auditRow({ id: 'sparse-2', astNodeCount: 101 }),
        ],
        proposedMetrics: {
          projectId: 'proj-ad',
          astNodeCount: 9_999_999,
        },
      }),
    );
    expect(score.sampleSize).toBe(2);
    expect(score.score).toBe(0);
    expect(score.isAnomalous).toBe(false);
    expect(score.advisory).toBe(true);
    expect(score.signals).toEqual([]);
  });

  it('AD-7: emitted events are H13-compliant and carry correlation context', async () => {
    const { deps, emitter } = makeDeps(createStatisticalAnomalyDetector());
    await scoreAnomaly(
      deps,
      req({
        correlationId: 'corr-ad-h13',
        historicalRecords: [
          auditRow({ id: 'h13-1', astNodeCount: 100 }),
          auditRow({ id: 'h13-2', astNodeCount: 102 }),
        ],
      }),
    );
    const events = emitter
      .getEvents()
      .filter((e) => e.op === 'scoreAnomaly');
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    for (const e of events) {
      assertEventIsContentFree(e);
      expect(e.correlationId).toBe('corr-ad-h13');
      expect(e.engineId).toBe('engine-ad-test');
      expect(e.projectId).toBe('proj-ad');
    }
  });

  it('AD-8: invalid request (missing projectId) → ValidationError invalid_manifest', async () => {
    const { deps } = makeDeps(createNoopAnomalyDetector());
    await expect(
      scoreAnomaly(
        deps,
        {
          correlationId: 'corr-ad-bad',
          historicalRecords: [],
        } as unknown as ScoreAnomalyRequest,
      ),
    ).rejects.toMatchObject({ kind: 'invalid_manifest' });
  });

  it('AD-9: rejects mismatched proposedMetrics.projectId', async () => {
    const { deps } = makeDeps(createStatisticalAnomalyDetector());
    await expect(
      scoreAnomaly(
        deps,
        req({
          projectId: 'proj-ad',
          proposedMetrics: {
            projectId: 'proj-other',
            astNodeCount: 100,
          },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_manifest' });
  });

  it('AD-10: deviation from a perfectly stable baseline still flags as anomalous', async () => {
    const { deps } = makeDeps(createStatisticalAnomalyDetector());
    const history = Array.from({ length: 5 }, (_, i) =>
      auditRow({
        id: `stable-${i}`,
        astNodeCount: 100,
        fileLineCount: 80,
        manifestScopeRatio: 0.5,
      }),
    );

    const score = await scoreAnomaly(
      deps,
      req({
        historicalRecords: history,
        correlationId: 'corr-ad-stable-baseline',
        proposedMetrics: {
          projectId: 'proj-ad',
          astNodeCount: 101,
          fileLineCount: 80,
          manifestScopeRatio: 0.5,
        },
      }),
    );

    expect(score.isAnomalous).toBe(true);
    expect(score.score).toBe(1);
    expect(score.signals.map((signal) => signal.metric)).toContain('astNodeCount');
    expect(score.signals[0]?.stddev).toBe(0);
    expect(score.reason).toContain('stable-baseline-deviation');
  });
});
