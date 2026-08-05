/**
 * tests/util/convergence.test.ts — Track CV targeted test suite.
 *
 * Proof requirements per the convergence_report slice:
 *
 *   CV-1  Decreasing series [10, 8, 5, 2] → divergenceRisk: 'low', monotonicDecrease: true
 *   CV-2  Oscillating series [10, 6, 8, 4] → divergenceRisk: 'high' (oscillation detected)
 *   CV-3  Increasing series [5, 6, 8] → divergenceRisk: 'high', monotonicDecrease: false
 *   CV-4  Empty attempts → sentinel (divergenceRisk: 'low', attemptCount: 0)
 *   CV-5  Stable non-zero plateau [4, 4, 4] → divergenceRisk: 'medium'
 *   CV-6  persistentViolationRatio: all attempts same violations → 1.0
 *   CV-7  persistentViolationRatio: no overlap across attempts → 0.0
 *   CV-8  violationCountSeries matches per-attempt lengths
 *   CV-9  emitConvergenceEvent produces a HoplonEvent that passes assertEventIsContentFree
 *   CV-10 emitted event has op='convergence', phase='end', correct numeric attributes
 *   CV-11 H13: emitted event carries no violation kinds or paths
 *   CV-12 Single attempt → monotonicDecrease: true, divergenceRisk: 'low'
 *   CV-13 All-zero series [0, 0, 0] → divergenceRisk: 'low' (already clean, plateau OK)
 *
 * ## Oscillating-series heuristic documentation
 *
 * For the series [10, 6, 8, 4]:
 *   - Step 0→1: 6 < 10 (decreasing — ok)
 *   - Step 1→2: 8 > 6  (upward step — oscillation detected → 'high')
 *
 * The chosen heuristic treats ANY upward step as 'high', not 'medium', because
 * oscillation in a retry loop is a stronger regression signal than a stable
 * plateau. A flat non-zero series (e.g. [4, 4, 4]) maps to 'medium' since
 * there is no improvement but also no regression.
 *
 * Pure function tests — no filesystem, no git, no WASM, no network.
 * emitConvergenceEvent tests use createMemoryEmitter (in-process, no I/O).
 */

import { describe, it, expect } from 'vitest';
import { measureConvergence, emitConvergenceEvent } from '../../src/hoplon/util/convergence.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { PriorAttempt } from '../../src/hoplon/contracts/retryContext.js';
import type { AuditViolation } from '../../src/hoplon/contracts/audit.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeViolation(kind: 'out_of_scope_symbol', path: string, symbolName: string): AuditViolation;
function makeViolation(kind: 'uncontracted_file', path: string): AuditViolation;
function makeViolation(kind: string, path: string, symbolName?: string): AuditViolation {
  if (kind === 'out_of_scope_symbol') {
    return {
      kind: 'out_of_scope_symbol',
      path,
      symbolName: symbolName!,
      nodeKind: 'function_declaration',
      byteRange: [0, 10],
      sourceSlice: '',
      truncated: false,
      expectedScope: { level: 'symbol', path, name: symbolName!, kind: 'function' },
      message: `out of scope: ${symbolName}`,
      correction: 'remove it',
    } satisfies AuditViolation;
  }
  return {
    kind: 'uncontracted_file',
    path,
    firstChangedLine: 1,
    sourceSlice: '',
    truncated: false,
    message: `uncontracted: ${path}`,
    correction: 'remove it',
  } satisfies AuditViolation;
}

/** Build a PriorAttempt with the given violation count using distinct violations. */
function makeAttempt(attemptNumber: number, violationCount: number): PriorAttempt {
  const violations: AuditViolation[] = [];
  for (let i = 0; i < violationCount; i++) {
    // Use distinct paths per (attempt, index) so no cross-attempt overlap
    violations.push(makeViolation('uncontracted_file', `src/a${attemptNumber}_${i}.ts`));
  }
  return { attemptNumber, proposedContent: `// attempt ${attemptNumber}`, violations };
}

/** Build a PriorAttempt with a fixed set of shared violations. */
function makeAttemptWithViolations(
  attemptNumber: number,
  violations: AuditViolation[],
): PriorAttempt {
  return { attemptNumber, proposedContent: `// attempt ${attemptNumber}`, violations };
}

// ---------------------------------------------------------------------------
// CV-1: Decreasing series [10, 8, 5, 2] → low risk, monotonic
// ---------------------------------------------------------------------------

describe('CV-1: decreasing series [10, 8, 5, 2]', () => {
  const attempts = [
    makeAttempt(1, 10),
    makeAttempt(2, 8),
    makeAttempt(3, 5),
    makeAttempt(4, 2),
  ];
  const metrics = measureConvergence(attempts);

  it('divergenceRisk is low', () => {
    expect(metrics.divergenceRisk).toBe('low');
  });

  it('monotonicDecrease is true', () => {
    expect(metrics.monotonicDecrease).toBe(true);
  });

  it('violationCountSeries matches [10, 8, 5, 2]', () => {
    expect(metrics.violationCountSeries).toEqual([10, 8, 5, 2]);
  });

  it('attemptCount is 4', () => {
    expect(metrics.attemptCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// CV-2: Oscillating series [10, 6, 8, 4] → high risk
// ---------------------------------------------------------------------------

describe('CV-2: oscillating series [10, 6, 8, 4]', () => {
  const attempts = [
    makeAttempt(1, 10),
    makeAttempt(2, 6),
    makeAttempt(3, 8),  // upward step → oscillation
    makeAttempt(4, 4),
  ];
  const metrics = measureConvergence(attempts);

  it('divergenceRisk is high (oscillation detected)', () => {
    expect(metrics.divergenceRisk).toBe('high');
  });

  it('monotonicDecrease is false (upward step at index 2)', () => {
    expect(metrics.monotonicDecrease).toBe(false);
  });

  it('violationCountSeries matches [10, 6, 8, 4]', () => {
    expect(metrics.violationCountSeries).toEqual([10, 6, 8, 4]);
  });
});

// ---------------------------------------------------------------------------
// CV-3: Increasing series [5, 6, 8] → high risk, not monotonic
// ---------------------------------------------------------------------------

describe('CV-3: increasing series [5, 6, 8]', () => {
  const attempts = [
    makeAttempt(1, 5),
    makeAttempt(2, 6),
    makeAttempt(3, 8),
  ];
  const metrics = measureConvergence(attempts);

  it('divergenceRisk is high', () => {
    expect(metrics.divergenceRisk).toBe('high');
  });

  it('monotonicDecrease is false', () => {
    expect(metrics.monotonicDecrease).toBe(false);
  });

  it('violationCountSeries matches [5, 6, 8]', () => {
    expect(metrics.violationCountSeries).toEqual([5, 6, 8]);
  });

  it('attemptCount is 3', () => {
    expect(metrics.attemptCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CV-4: Empty attempts → sentinel (divergenceRisk: 'low', attemptCount: 0)
// ---------------------------------------------------------------------------

describe('CV-4: empty attempts → sentinel', () => {
  const metrics = measureConvergence([]);

  it('divergenceRisk is low', () => {
    expect(metrics.divergenceRisk).toBe('low');
  });

  it('attemptCount is 0', () => {
    expect(metrics.attemptCount).toBe(0);
  });

  it('monotonicDecrease is true (vacuously)', () => {
    expect(metrics.monotonicDecrease).toBe(true);
  });

  it('violationCountSeries is empty', () => {
    expect(metrics.violationCountSeries).toEqual([]);
  });

  it('persistentViolationRatio is 0', () => {
    expect(metrics.persistentViolationRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CV-5: Stable non-zero plateau [4, 4, 4] → medium risk
// ---------------------------------------------------------------------------

describe('CV-5: stable non-zero plateau [4, 4, 4]', () => {
  // Same violation paths across all attempts → all persistent, ratio = 1
  const sharedViolation = makeViolation('uncontracted_file', 'src/shared.ts');
  const attempts = [
    makeAttemptWithViolations(1, [
      sharedViolation,
      makeViolation('uncontracted_file', 'src/x1.ts'),
      makeViolation('uncontracted_file', 'src/x2.ts'),
      makeViolation('uncontracted_file', 'src/x3.ts'),
    ]),
    makeAttemptWithViolations(2, [
      sharedViolation,
      makeViolation('uncontracted_file', 'src/x1.ts'),
      makeViolation('uncontracted_file', 'src/x2.ts'),
      makeViolation('uncontracted_file', 'src/x3.ts'),
    ]),
    makeAttemptWithViolations(3, [
      sharedViolation,
      makeViolation('uncontracted_file', 'src/x1.ts'),
      makeViolation('uncontracted_file', 'src/x2.ts'),
      makeViolation('uncontracted_file', 'src/x3.ts'),
    ]),
  ];
  const metrics = measureConvergence(attempts);

  it('divergenceRisk is medium (stable non-zero plateau)', () => {
    expect(metrics.divergenceRisk).toBe('medium');
  });

  it('monotonicDecrease is true (non-increasing — flat)', () => {
    expect(metrics.monotonicDecrease).toBe(true);
  });

  it('violationCountSeries is [4, 4, 4]', () => {
    expect(metrics.violationCountSeries).toEqual([4, 4, 4]);
  });
});

// ---------------------------------------------------------------------------
// CV-6: All attempts same violations → persistentViolationRatio = 1.0
// ---------------------------------------------------------------------------

describe('CV-6: fully persistent violations → ratio 1.0', () => {
  const v1 = makeViolation('out_of_scope_symbol', 'src/foo.ts', 'badFn');
  const v2 = makeViolation('uncontracted_file', 'src/extra.ts');
  const attempts = [
    makeAttemptWithViolations(1, [v1, v2]),
    makeAttemptWithViolations(2, [v1, v2]),
    makeAttemptWithViolations(3, [v1, v2]),
  ];
  const metrics = measureConvergence(attempts);

  it('persistentViolationRatio is 1.0', () => {
    expect(metrics.persistentViolationRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CV-7: No violation overlap across attempts → persistentViolationRatio = 0.0
// ---------------------------------------------------------------------------

describe('CV-7: no overlap across attempts → ratio 0.0', () => {
  // Each attempt uses fully distinct violation paths
  const attempts = [
    makeAttempt(1, 2),  // paths: a1_0, a1_1
    makeAttempt(2, 2),  // paths: a2_0, a2_1
    makeAttempt(3, 2),  // paths: a3_0, a3_1
  ];
  const metrics = measureConvergence(attempts);

  it('persistentViolationRatio is 0', () => {
    expect(metrics.persistentViolationRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CV-8: violationCountSeries matches per-attempt violation array lengths
// ---------------------------------------------------------------------------

describe('CV-8: violationCountSeries matches per-attempt violation counts', () => {
  const attempts = [
    makeAttempt(1, 3),
    makeAttempt(2, 1),
    makeAttempt(3, 0),
  ];
  const metrics = measureConvergence(attempts);

  it('series is [3, 1, 0]', () => {
    expect(metrics.violationCountSeries).toEqual([3, 1, 0]);
  });

  it('attemptCount is 3', () => {
    expect(metrics.attemptCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CV-9: emitConvergenceEvent produces an event that passes assertEventIsContentFree
// ---------------------------------------------------------------------------

describe('CV-9: emitConvergenceEvent passes assertEventIsContentFree', () => {
  const emitter = createMemoryEmitter();
  const attempts = [makeAttempt(1, 5), makeAttempt(2, 3), makeAttempt(3, 1)];
  const metrics = measureConvergence(attempts);

  emitConvergenceEvent(emitter, metrics, {
    correlationId: 'cv-test-corr',
    engineId: 'cv-test-engine',
  });

  const events = emitter.getEvents();

  it('exactly one event emitted', () => {
    expect(events).toHaveLength(1);
  });

  it('emitted event passes assertEventIsContentFree (H13)', () => {
    expect(() => assertEventIsContentFree(events[0])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CV-10: emitted event has correct op, phase, and numeric attributes
// ---------------------------------------------------------------------------

describe('CV-10: emitConvergenceEvent produces correct structured event', () => {
  const emitter = createMemoryEmitter();
  const v = makeViolation('uncontracted_file', 'src/shared.ts');
  const attempts = [
    makeAttemptWithViolations(1, [v, makeViolation('uncontracted_file', 'src/a.ts')]),
    makeAttemptWithViolations(2, [v]),
  ];
  const metrics = measureConvergence(attempts);

  emitConvergenceEvent(emitter, metrics, {
    correlationId: 'cv-corr-10',
    engineId: 'cv-eng-10',
  });

  const [event] = emitter.getEvents();

  it('op is convergence', () => {
    expect(event!.op).toBe('convergence');
  });

  it('phase is end', () => {
    expect(event!.phase).toBe('end');
  });

  it('convergenceAttemptCount matches metrics.attemptCount', () => {
    expect(event!.convergenceAttemptCount).toBe(metrics.attemptCount);
  });

  it('convergenceMonotonicDecrease matches metrics.monotonicDecrease', () => {
    expect(event!.convergenceMonotonicDecrease).toBe(metrics.monotonicDecrease);
  });

  it('convergencePersistentViolationRatio is in [0, 1]', () => {
    const ratio = event!.convergencePersistentViolationRatio!;
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('convergenceDivergenceRisk is a valid enum value', () => {
    expect(['low', 'medium', 'high']).toContain(event!.convergenceDivergenceRisk);
  });

  it('convergenceViolationCountSeries is a numeric array', () => {
    const series = event!.convergenceViolationCountSeries!;
    expect(Array.isArray(series)).toBe(true);
    expect(series.every((n) => typeof n === 'number')).toBe(true);
  });

  it('engineId and correlationId are present', () => {
    expect(event!.engineId).toBe('cv-eng-10');
    expect(event!.correlationId).toBe('cv-corr-10');
  });
});

// ---------------------------------------------------------------------------
// CV-11: H13 — event carries no violation kinds or paths (field-name check)
// ---------------------------------------------------------------------------

describe('CV-11: H13 — event does not contain forbidden content fields', () => {
  const emitter = createMemoryEmitter();
  const metrics = measureConvergence([makeAttempt(1, 3)]);
  emitConvergenceEvent(emitter, metrics, {
    correlationId: 'cv-corr-11',
    engineId: 'cv-eng-11',
  });

  const [event] = emitter.getEvents();

  it('event has no symbolName field', () => {
    expect('symbolName' in (event as object)).toBe(false);
  });

  it('event has no sourceSlice field', () => {
    expect('sourceSlice' in (event as object)).toBe(false);
  });

  it('event has no paths field', () => {
    expect('paths' in (event as object)).toBe(false);
  });

  it('event has no content field', () => {
    expect('content' in (event as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CV-12: Single attempt → monotonicDecrease: true, divergenceRisk: 'low'
// ---------------------------------------------------------------------------

describe('CV-12: single attempt → low risk (vacuously monotonic)', () => {
  const metrics = measureConvergence([makeAttempt(1, 7)]);

  it('monotonicDecrease is true', () => {
    expect(metrics.monotonicDecrease).toBe(true);
  });

  it('divergenceRisk is low', () => {
    expect(metrics.divergenceRisk).toBe('low');
  });

  it('attemptCount is 1', () => {
    expect(metrics.attemptCount).toBe(1);
  });

  it('violationCountSeries has one element', () => {
    expect(metrics.violationCountSeries).toHaveLength(1);
    expect(metrics.violationCountSeries[0]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// CV-13: All-zero series [0, 0, 0] → divergenceRisk: 'low' (already clean)
// ---------------------------------------------------------------------------

describe('CV-13: all-zero series [0, 0, 0] → low risk (already clean)', () => {
  const attempts = [
    makeAttemptWithViolations(1, []),
    makeAttemptWithViolations(2, []),
    makeAttemptWithViolations(3, []),
  ];
  const metrics = measureConvergence(attempts);

  it('divergenceRisk is low (plateau at zero is fine)', () => {
    expect(metrics.divergenceRisk).toBe('low');
  });

  it('monotonicDecrease is true', () => {
    expect(metrics.monotonicDecrease).toBe(true);
  });

  it('persistentViolationRatio is 0 (no violations anywhere)', () => {
    expect(metrics.persistentViolationRatio).toBe(0);
  });

  it('violationCountSeries is [0, 0, 0]', () => {
    expect(metrics.violationCountSeries).toEqual([0, 0, 0]);
  });
});
