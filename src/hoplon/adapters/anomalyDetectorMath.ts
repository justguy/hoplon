import type { AuditLogRecord } from '../contracts/auditLog.js';
import type {
  AnomalyMetricName,
  ProjectMetrics,
} from '../contracts/anomalyDetector.js';

export const DEFAULT_Z_SCORE_THRESHOLD = 3;
export const DEFAULT_MIN_SAMPLE_SIZE = 3;

// Finite marker for a stable baseline that then changes. Infinity/NaN must
// never cross the anomaly-score DTO boundary.
export const STABLE_BASELINE_SATURATION_ZSCORE = Number.MAX_SAFE_INTEGER;

export const METRIC_NAMES: readonly AnomalyMetricName[] = [
  'astNodeCount',
  'fileLineCount',
  'manifestScopeRatio',
] as const;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function formatMaxZScore(value: number): string {
  if (value >= STABLE_BASELINE_SATURATION_ZSCORE) {
    return 'stable-baseline-deviation';
  }
  return value.toFixed(2);
}

export function meanAndStddev(
  values: number[],
): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, stddev: 0 };
  const variance =
    values.reduce(
      (sum, value) => sum + (value - mean) * (value - mean),
      0,
    ) /
    (values.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

export function readMetric(
  row: AuditLogRecord,
  metric: AnomalyMetricName,
): number | null {
  const value = row[metric];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function readProposed(
  metrics: ProjectMetrics | undefined,
  metric: AnomalyMetricName,
): number | null {
  if (metrics === undefined) return null;
  const value = metrics[metric];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}
