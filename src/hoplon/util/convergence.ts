/**
 * util/convergence.ts — Convergence telemetry for the Phalanx retry loop.
 *
 * Track CV (§1.5 of HOPLON_COMPLETE_RECOMMENDATIONS.md).
 *
 * ## Purpose
 *
 * Measures whether the retry loop is making monotone progress (|violations_k+1|
 * ≤ |violations_k| for all k) and computes a structured summary that can be
 * emitted as a H13-compliant HoplonEvent for operational observability.
 *
 * ## Divergence risk heuristic
 *
 * The heuristic classifies the series using three rules applied in order:
 *
 *   1. `'high'`   — the final attempt has MORE violations than the first, OR
 *                   the series oscillates (any k where count[k+1] > count[k]).
 *   2. `'medium'` — no oscillation but violation count is non-zero and constant
 *                   across all attempts (stable non-monotonic plateau).
 *   3. `'low'`    — fully monotonically non-increasing and final count ≤ initial
 *                   count (i.e. the series is making real progress or is already
 *                   at zero).
 *
 * For the oscillating case [10, 6, 8, 4]: count[1]=6 < count[0]=10 (ok),
 * count[2]=8 > count[1]=6 (oscillation detected) → `'high'`.
 *
 * ## Import wall
 *
 * Imports only from ../contracts/* and ../adapters/emitter.ts.
 * No filesystem, no async, no adapters beyond the emitter parameter.
 */

import type { PriorAttempt } from '../contracts/retryContext.js';
import type { HoplonEmitter } from '../adapters/emitter.js';

// ---------------------------------------------------------------------------
// ConvergenceMetrics — the pure-function output type
// ---------------------------------------------------------------------------

/**
 * Structured convergence summary computed from a retry history.
 *
 * All fields are content-free (counts, booleans, enum values) and are safe
 * to pass to emitConvergenceEvent without H13 risk.
 */
export interface ConvergenceMetrics {
  /**
   * True if every attempt's violation count is ≤ the previous attempt's count
   * (i.e. the series is non-increasing). Vacuously true for 0–1 attempts.
   */
  monotonicDecrease: boolean;

  /**
   * Per-attempt violation counts in ascending attemptNumber order.
   * Length equals attemptCount. Empty when attemptCount === 0.
   */
  violationCountSeries: number[];

  /**
   * Ratio of persistent violations to total unique violations across all attempts.
   * A violation is "persistent" if its identity key appears in every attempt.
   * A violation is "unique" if it appears in at least one attempt.
   * Range [0, 1]. Returns 0 when there are no unique violations (including empty
   * or all-pass attempts).
   */
  persistentViolationRatio: number;

  /**
   * Heuristic divergence risk classification.
   *
   * - 'low'    — monotonically non-increasing series (progress or already clean).
   * - 'medium' — stable non-monotonic plateau (no oscillation but no improvement).
   * - 'high'   — oscillating or increasing series (retry loop likely stuck).
   */
  divergenceRisk: 'low' | 'medium' | 'high';

  /**
   * Total number of attempts provided. May be 0 (sentinel case).
   */
  attemptCount: number;
}

// ---------------------------------------------------------------------------
// measureConvergence — pure synchronous function
// ---------------------------------------------------------------------------

/**
 * Compute convergence metrics from a list of prior attempts.
 *
 * Pure function — no I/O, no side effects, no adapter calls. Synchronous.
 *
 * @param attempts - Ordered prior attempts (ascending attemptNumber).
 *                   May be empty. Need not be pre-sorted.
 * @returns ConvergenceMetrics summarising monotonicity, ratio, and risk.
 */
export function measureConvergence(attempts: PriorAttempt[]): ConvergenceMetrics {
  // -------------------------------------------------------------------------
  // Sentinel: empty attempts
  // -------------------------------------------------------------------------
  if (attempts.length === 0) {
    return {
      monotonicDecrease: true,
      violationCountSeries: [],
      persistentViolationRatio: 0,
      divergenceRisk: 'low',
      attemptCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Sort by attemptNumber (caller should already sort, but be defensive)
  // -------------------------------------------------------------------------
  const sorted = attempts.slice().sort((a, b) => a.attemptNumber - b.attemptNumber);

  // -------------------------------------------------------------------------
  // violationCountSeries — per-attempt violation counts
  // -------------------------------------------------------------------------
  const violationCountSeries = sorted.map((a) => a.violations.length);

  // -------------------------------------------------------------------------
  // monotonicDecrease — true iff series is non-increasing at every step
  // -------------------------------------------------------------------------
  let monotonicDecrease = true;
  for (let i = 1; i < violationCountSeries.length; i++) {
    if (violationCountSeries[i]! > violationCountSeries[i - 1]!) {
      monotonicDecrease = false;
      break;
    }
  }

  // -------------------------------------------------------------------------
  // persistentViolationRatio — persistent / total unique violations
  //
  // "Persistent" = violation identity key present in EVERY attempt.
  // "Unique"     = violation identity key present in AT LEAST ONE attempt.
  //
  // Uses the same identity key as compressRetryContext (kind + path ±
  // symbolName / parseError).
  // -------------------------------------------------------------------------
  const persistentViolationRatio = computePersistentRatio(sorted);

  // -------------------------------------------------------------------------
  // divergenceRisk heuristic (see module doc)
  // -------------------------------------------------------------------------
  const divergenceRisk = classifyDivergenceRisk(violationCountSeries, monotonicDecrease);

  return {
    monotonicDecrease,
    violationCountSeries,
    persistentViolationRatio,
    divergenceRisk,
    attemptCount: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// emitConvergenceEvent — fire-and-forget H13-compliant event
// ---------------------------------------------------------------------------

/**
 * Emit a HoplonEvent with op='convergence' and structured numeric attributes.
 *
 * H13 compliant — event carries only:
 *   - counts (attemptCount, violationCountSeries)
 *   - boolean (monotonicDecrease)
 *   - ratio in [0,1] (persistentViolationRatio)
 *   - enum value (divergenceRisk: 'low'|'medium'|'high')
 *
 * Never emits: violation kinds, paths, source slices, symbol names.
 *
 * @param emitter       - HoplonEmitter to receive the event (fire-and-forget).
 * @param metrics       - ConvergenceMetrics from measureConvergence().
 * @param ctx           - correlationId and engineId (mandatory trace fields H11).
 */
export function emitConvergenceEvent(
  emitter: HoplonEmitter,
  metrics: ConvergenceMetrics,
  ctx: { correlationId: string; engineId: string },
): void {
  emitter.emit({
    op: 'convergence',
    phase: 'end',
    engineId: ctx.engineId,
    correlationId: ctx.correlationId,
    convergenceAttemptCount: metrics.attemptCount,
    convergenceMonotonicDecrease: metrics.monotonicDecrease,
    convergencePersistentViolationRatio: metrics.persistentViolationRatio,
    convergenceDivergenceRisk: metrics.divergenceRisk,
    convergenceViolationCountSeries: metrics.violationCountSeries,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Stable violation identity key — mirrors the logic in compressRetryContext
 * to ensure consistent identity comparison.
 */
function violationKey(v: PriorAttempt['violations'][number]): string {
  const base = `${v.kind}::${v.path}`;
  if ('symbolName' in v && v.symbolName) return `${base}::${v.symbolName}`;
  if ('parseError' in v && v.parseError) return `${base}::${v.parseError}`;
  return base;
}

/**
 * Compute persistent / unique violation ratio across a sorted attempt list.
 *
 * Returns 0 when there are zero unique violations (all attempts had empty
 * violation arrays).
 */
function computePersistentRatio(sorted: PriorAttempt[]): number {
  if (sorted.length === 0) return 0;

  // Build per-attempt key sets
  const keySetsByAttempt: Set<string>[] = sorted.map(
    (a) => new Set(a.violations.map(violationKey)),
  );

  // Total unique violation keys across all attempts
  const allUniqueKeys = new Set<string>();
  for (const ks of keySetsByAttempt) {
    for (const k of ks) {
      allUniqueKeys.add(k);
    }
  }

  if (allUniqueKeys.size === 0) return 0;

  // Keys present in EVERY attempt
  let persistentCount = 0;
  for (const k of allUniqueKeys) {
    if (keySetsByAttempt.every((ks) => ks.has(k))) {
      persistentCount++;
    }
  }

  return persistentCount / allUniqueKeys.size;
}

/**
 * Classify divergence risk from the violation count series.
 *
 * Rules (applied in order):
 *   1. Any upward step → 'high' (oscillating or increasing).
 *   2. Fully non-increasing but final count equals initial and both are
 *      non-zero (stable plateau) → 'medium'.
 *   3. Otherwise → 'low' (monotonically decreasing or already clean).
 *
 * Rationale for rule 2: a perfectly flat non-zero series means the retry loop
 * is running but not converging — dangerous in production, though not yet
 * oscillating. This is the "stable non-monotonic" case from the spec.
 */
function classifyDivergenceRisk(
  series: number[],
  monotonicDecrease: boolean,
): 'low' | 'medium' | 'high' {
  // 0 or 1 elements: trivially low risk
  if (series.length <= 1) return 'low';

  // Any upward step → high
  if (!monotonicDecrease) return 'high';

  // All non-increasing. Check for stable non-zero plateau (medium).
  const first = series[0]!;
  const last = series[series.length - 1]!;
  if (first === last && first > 0) return 'medium';

  // Monotonically decreasing (or all zeros) → low
  return 'low';
}
