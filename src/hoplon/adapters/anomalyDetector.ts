/**
 * adapters/anomalyDetector.ts — advisory anomaly-detector seam (t-037).
 *
 * Ships two concrete adapters behind a stable interface:
 *   - `createNoopAnomalyDetector()` — zero-score advisory default. The engine
 *     factory's runtime default when no detector is supplied.
 *   - `createStatisticalAnomalyDetector()` — deterministic statistical process
 *     control over historical ML2 audit-log columns (`astNodeCount`,
 *     `fileLineCount`, `manifestScopeRatio`). Not a default; callers wire it
 *     explicitly. Remains `advisory: true` regardless of configuration.
 *
 * Both implementations consume `AuditLogRecord` rows directly — there is no
 * parallel feature store. H13 stays intact because only counts, ratios, and a
 * closed enum of metric names cross the seam.
 *
 * Outside t-037 scope: default-blocking behavior, adoption by `auditDiff`,
 * adoption by the structural audit gate, remote ML services as a default.
 * Any such follow-on must ship as a separate proven slice with durable tracker,
 * PMO, or architecture evidence.
 */

import type {
  AuditLogRecord,
  AuditLogResult,
} from '../contracts/auditLog.js';
import type {
  AnomalyScore,
  AnomalySignal,
  ProjectMetrics,
} from '../contracts/anomalyDetector.js';
import {
  DEFAULT_MIN_SAMPLE_SIZE,
  DEFAULT_Z_SCORE_THRESHOLD,
  METRIC_NAMES,
  STABLE_BASELINE_SATURATION_ZSCORE,
  clamp01,
  formatMaxZScore,
  meanAndStddev,
  readMetric,
  readProposed,
} from './anomalyDetectorMath.js';

// ---------------------------------------------------------------------------
// AnomalyDetectorInput — the structural input the adapter sees
// ---------------------------------------------------------------------------

export interface AnomalyDetectorInput {
  projectId: string;
  proposedMetrics?: ProjectMetrics;
  historicalRecords: AuditLogRecord[];
}

export interface AnomalyDetectorAdapter {
  /**
   * Score the proposed project metrics against historical audit rows.
   *
   * MUST return `advisory: true`; the schema literal re-validates this at the
   * operation boundary. Implementations should be deterministic given the
   * same `(projectId, historicalRecords, proposedMetrics)` triple.
   */
  score(
    input: AnomalyDetectorInput,
    signal?: AbortSignal,
  ): Promise<AnomalyScore>;
}

// ---------------------------------------------------------------------------
// Types re-export — keep historic `ProjectMetrics`/`AnomalyScore`/`AnomalySignal`
// importable from adapters/anomalyDetector.js for backward compatibility with
// pre-t-037 callers. The canonical definitions live in contracts/anomalyDetector.
// ---------------------------------------------------------------------------

export type {
  ProjectMetrics,
  AnomalyScore,
  AnomalySignal,
  AnomalyMetricName,
} from '../contracts/anomalyDetector.js';

// ---------------------------------------------------------------------------
// No-op factory — zero-score advisory default
// ---------------------------------------------------------------------------

export function createNoopAnomalyDetector(): AnomalyDetectorAdapter {
  return {
    async score(input: AnomalyDetectorInput): Promise<AnomalyScore> {
      return {
        score: 0,
        isAnomalous: false,
        advisory: true,
        sampleSize: input.historicalRecords.length,
        signals: [],
        reason:
          'noop anomaly detector — zero-score advisory default; no history inspection',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Statistical detector — deterministic statistical process control
// ---------------------------------------------------------------------------

export interface StatisticalAnomalyDetectorOptions {
  /**
   * Z-score threshold above which an individual metric is flagged as a signal.
   * Default: 3 (matches "3-sigma" SPC convention).
   */
  zScoreThreshold?: number;
  /**
   * Minimum historical `AUDIT_DIFF` rows required before any signal can fire.
   * Below this count the detector returns `score=0, isAnomalous=false` to
   * avoid acting confidently on sparse history. Default: 3.
   */
  minSampleSize?: number;
}

export function createStatisticalAnomalyDetector(
  options: StatisticalAnomalyDetectorOptions = {},
): AnomalyDetectorAdapter {
  const opts: Required<StatisticalAnomalyDetectorOptions> = {
    zScoreThreshold: options.zScoreThreshold ?? DEFAULT_Z_SCORE_THRESHOLD,
    minSampleSize: options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE,
  };
  return {
    async score(input: AnomalyDetectorInput): Promise<AnomalyScore> {
      return computeStatisticalAnomalyScore(input, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic core — exported for targeted unit tests only
// ---------------------------------------------------------------------------

export function computeStatisticalAnomalyScore(
  input: AnomalyDetectorInput,
  opts: Required<StatisticalAnomalyDetectorOptions>,
): AnomalyScore {
  const { projectId, proposedMetrics, historicalRecords } = input;

  // Restrict to AUDIT_DIFF rows for this project — only audits carry the ML2
  // baseline columns reliably. CREATE_SNAPSHOT/REVERT rows are noise here.
  const auditRows = historicalRecords.filter(
    (row): row is AuditLogRecord & { result: AuditLogResult } =>
      row.projectId === projectId && row.operation === 'AUDIT_DIFF',
  );
  const sampleSize = auditRows.length;

  if (sampleSize === 0) {
    return {
      score: 0,
      isAnomalous: false,
      advisory: true,
      sampleSize: 0,
      signals: [],
      reason:
        'no AUDIT_DIFF history for this project — returning zero-score advisory',
    };
  }

  if (proposedMetrics === undefined) {
    return {
      score: 0,
      isAnomalous: false,
      advisory: true,
      sampleSize,
      signals: [],
      reason:
        'no proposedMetrics supplied — returning zero-score advisory over history',
    };
  }

  // Small-sample clamp: below minSampleSize the detector refuses to fire any
  // signal. sampleSize is still reported honestly.
  if (sampleSize < opts.minSampleSize) {
    return {
      score: 0,
      isAnomalous: false,
      advisory: true,
      sampleSize,
      signals: [],
      reason: `sample<${opts.minSampleSize} — advisory clamped to zero score`,
    };
  }

  const signals: AnomalySignal[] = [];
  let maxZScore = 0;

  for (const metric of METRIC_NAMES) {
    const proposedValue = readProposed(proposedMetrics, metric);
    if (proposedValue === null) continue;

    const history = auditRows
      .map((row) => readMetric(row, metric))
      .filter((v): v is number => v !== null);
    if (history.length < opts.minSampleSize) continue;

    const { mean, stddev } = meanAndStddev(history);
    if (stddev === 0) {
      // Perfectly stable baseline: treat any deviation as a saturated signal
      // instead of silently dropping it. A true z-score is undefined here, so
      // we emit a finite saturation marker through the DTO.
      if (proposedValue === mean) continue;
      const zScore = STABLE_BASELINE_SATURATION_ZSCORE;
      signals.push({
        metric,
        observedValue: proposedValue,
        baselineValue: mean,
        stddev,
        zScore,
        description: `${metric} deviated from a perfectly stable baseline (stddev=0)`,
      });
      if (zScore > maxZScore) maxZScore = zScore;
      continue;
    }
    const zScore = Math.abs(proposedValue - mean) / stddev;
    if (zScore >= opts.zScoreThreshold) {
      signals.push({
        metric,
        observedValue: proposedValue,
        baselineValue: mean,
        stddev,
        zScore,
        description: `${metric} z=${zScore.toFixed(2)} exceeds threshold ${opts.zScoreThreshold}`,
      });
    }
    if (zScore > maxZScore) maxZScore = zScore;
  }

  // Aggregate score: smoothly saturates the max observed z-score into [0,1]
  // so that a 3σ deviation maps to ~0.5 and ≥6σ saturates near 1.0. Bounded
  // and deterministic in (historicalRecords, proposedMetrics).
  const rawScore =
    maxZScore === 0
      ? 0
      : maxZScore >= STABLE_BASELINE_SATURATION_ZSCORE
        ? 1
        : maxZScore / (maxZScore + opts.zScoreThreshold);
  const score = clamp01(rawScore);
  const isAnomalous = signals.length > 0;

  const reasonParts = [
    `sample=${sampleSize}`,
    `max-z=${formatMaxZScore(maxZScore)}`,
    `threshold=${opts.zScoreThreshold}`,
  ];
  if (signals.length > 0) {
    reasonParts.push(`signals=${signals.length}`);
  } else {
    reasonParts.push('no metric exceeded threshold');
  }

  return {
    score,
    isAnomalous,
    advisory: true,
    sampleSize,
    signals,
    reason: reasonParts.join('; '),
  };
}
