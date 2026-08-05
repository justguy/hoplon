/**
 * contracts/anomalyDetector.ts — t-037 advisory anomaly-detector DTOs.
 *
 * Extends the pre-existing (ML1) `AnomalyDetectorAdapter` seam with Zod-backed
 * request/response schemas. The output schema pins `advisory: z.literal(true)`
 * so any adapter that tries to return advisory=false is rejected at the engine
 * operation boundary before the caller ever sees the score.
 *
 * ## Bounded scope (t-037)
 * - no coupling to `auditDiff` / `createSnapshot` — structural audit PASS/BLOCK
 *   never consults the detector
 * - no content-bearing fields — counts, ratios, and fixed metric name strings
 *   only; H13 preserved
 * - no default blocking — every score carries `advisory: true`
 *
 * ## Not in scope
 * - semantic-search / embedding integration (t-034 is a different seam)
 * - violation prediction (t-036 ships on its own seam)
 * - remote ML services as a default (the shipped statistical implementation is
 *   fully in-process; remote providers stay host-owned)
 */

import { z } from 'zod';
import { AuditLogRecordSchema } from './auditLog.js';

// ---------------------------------------------------------------------------
// ProjectMetrics — H13-safe observations about the proposed run
// ---------------------------------------------------------------------------

/**
 * Numeric metrics describing the current (or proposed) file tree.
 *
 * All numeric fields are optional — implementations must tolerate absent
 * inputs and degrade to "no signal" for that metric.
 *
 * H13: counts and ratios only. No paths, no symbol names, no content.
 */
export const ProjectMetricsSchema = z.object({
  /** Project scoping — must match `AuditLogRecord.projectId` rows in history. */
  projectId: z.string().min(1),
  /** Projected total AST node count across the audited files. */
  astNodeCount: z.number().int().nonnegative().nullable().optional(),
  /** Projected total line count across the audited files. */
  fileLineCount: z.number().int().nonnegative().nullable().optional(),
  /** Projected `(bytes covered by manifest scope) / (total file bytes)`. */
  manifestScopeRatio: z.number().min(0).max(1).nullable().optional(),
});
export type ProjectMetrics = z.infer<typeof ProjectMetricsSchema>;

// ---------------------------------------------------------------------------
// AnomalySignal / AnomalyScore — advisory output envelope
// ---------------------------------------------------------------------------

/**
 * Canonical closed set of metric names the detector may flag.
 * Adding a new metric requires a schema bump so the H13 surface stays stable.
 */
export const ANOMALY_METRIC_NAMES = [
  'astNodeCount',
  'fileLineCount',
  'manifestScopeRatio',
] as const;
export const AnomalyMetricNameSchema = z.enum(ANOMALY_METRIC_NAMES);
export type AnomalyMetricName = z.infer<typeof AnomalyMetricNameSchema>;

/**
 * One flagged observation. Fields are numeric except `metric`, which is a
 * closed-union discriminator string.
 */
export const AnomalySignalSchema = z.object({
  /** Metric name — closed enum to preserve H13. */
  metric: AnomalyMetricNameSchema,
  /** The observed value that tripped the detector. */
  observedValue: z.number(),
  /** Historical mean used as the baseline. */
  baselineValue: z.number(),
  /** Historical standard deviation (0 when sampleSize < 2). */
  stddev: z.number().nonnegative(),
  /** Absolute z-score of `observedValue` against (baselineValue, stddev). */
  zScore: z.number().nonnegative(),
  /** Short machine-readable description of the anomaly — never empty. */
  description: z.string().min(1),
});
export type AnomalySignal = z.infer<typeof AnomalySignalSchema>;

/**
 * Advisory-only output of an `AnomalyDetectorAdapter.score` call.
 *
 * `advisory` is a `z.literal(true)` — the engine boundary rejects any attempt
 * to silently flip this field. Callers that want blocking behavior must do so
 * in a separate, out-of-scope slice.
 */
export const AnomalyScoreSchema = z.object({
  /** Aggregate anomaly score in [0, 1]. 0.0 = nothing flagged. */
  score: z.number().min(0).max(1),
  /**
   * Convenience flag — true when at least one signal exceeded the detector's
   * configured threshold. Advisory only; never used as a blocking verdict.
   */
  isAnomalous: z.boolean(),
  /** Hard invariant — schema-enforced. Never blocking by itself. */
  advisory: z.literal(true),
  /** Number of AUDIT_DIFF history rows the detector actually used. */
  sampleSize: z.number().int().nonnegative(),
  /** Per-metric signals. Empty when `score === 0`. */
  signals: z.array(AnomalySignalSchema),
  /** Short machine-and-human-readable explanation. Never empty. */
  reason: z.string().min(1),
});
export type AnomalyScore = z.infer<typeof AnomalyScoreSchema>;

// ---------------------------------------------------------------------------
// ScoreAnomalyRequest — engine-operation request envelope
// ---------------------------------------------------------------------------

/**
 * Input for the `scoreAnomaly` engine operation.
 *
 * Historical rows are passed directly — the operation is pure/read-only and
 * never scans the audit log on its own. The caller decides how to source
 * history (e.g., `findAuditLogByProjectAndRun` or an external analytics
 * store).
 */
export const ScoreAnomalyRequestSchema = z
  .object({
    /** Mandatory trace ID (H11). */
    correlationId: z.string().min(1),
    /** Project scoping — must match the history rows the caller feeds in. */
    projectId: z.string().min(1),
    /**
     * Observed metrics for the proposed run.
     * Optional — history alone is still valid input; the detector returns a
     * zero-score advisory when no proposed metrics are supplied.
     */
    proposedMetrics: ProjectMetricsSchema.optional(),
    /**
     * Historical audit rows for this project. Only `AUDIT_DIFF` rows contribute
     * to the baseline; other operations are ignored internally. Empty array is
     * valid — the detector returns a zero-score advisory with `sampleSize: 0`.
     */
    historicalRecords: z.array(AuditLogRecordSchema),
  })
  .superRefine((value, ctx) => {
    if (
      value.proposedMetrics !== undefined &&
      value.proposedMetrics.projectId !== value.projectId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedMetrics', 'projectId'],
        message:
          'proposedMetrics.projectId must match the top-level projectId',
      });
    }
  });
export type ScoreAnomalyRequest = z.infer<typeof ScoreAnomalyRequestSchema>;
