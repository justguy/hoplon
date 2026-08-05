/**
 * contracts/violationPredictor.ts — T-036 advisory violation predictor DTOs.
 *
 * Adds the typed request/response surface for an advisory structural-violation
 * predictor that consumes the already-shipped ML2 audit-log columns
 * (`astNodeCount`, `fileLineCount`, `manifestScopeRatio`) and reports a
 * probability plus an explicit advisory flag. The predictor never gates the
 * structural audit path; the `advisory: true` literal is part of the schema so
 * any caller that tries to treat its output as blocking has to deliberately
 * strip the type.
 *
 * ## Bounded scope (t-036)
 * - no duplicate feature store — reuses `AuditLogRecord` verbatim as history
 * - no content-bearing fields — counts/ratios/kind-strings only, H13 preserved
 * - no default blocking — every prediction carries `advisory: true`
 *
 * ## Not in scope
 * - broader host risk wiring (separate later slice)
 * - anomaly-detector integration (t-037 / anomaly adapter is a different seam)
 * - semantic search / embeddings (t-034 / separate)
 */

import { z } from 'zod';
import { AuditLogRecordSchema } from './auditLog.js';

// ---------------------------------------------------------------------------
// PredictorFeatures — numeric features optionally supplied for the upcoming run
// ---------------------------------------------------------------------------

/**
 * Per-run numeric features for the proposed (about-to-execute) operation.
 *
 * All fields are optional because callers may not know the post-execution
 * metrics in advance. The predictor MUST tolerate absent fields — it
 * degrades to historical base-rate scoring without them.
 *
 * H13: counts and ratios only. No paths, no symbol names, no content.
 */
export const PredictorFeaturesSchema = z.object({
  /** Project scoping (matches `AuditLogRecord.projectId`). */
  projectId: z.string().min(1),
  /** Projected total AST node count across the audited files. */
  astNodeCount: z.number().int().nonnegative().nullable().optional(),
  /** Projected total line count across the audited files. */
  fileLineCount: z.number().int().nonnegative().nullable().optional(),
  /** Projected `(bytes covered by manifest scope) / (total file bytes)`. */
  manifestScopeRatio: z.number().min(0).max(1).nullable().optional(),
});
export type PredictorFeatures = z.infer<typeof PredictorFeaturesSchema>;

// ---------------------------------------------------------------------------
// ViolationPrediction — the advisory output envelope
// ---------------------------------------------------------------------------

export const ViolationRiskBandSchema = z.enum(['low', 'medium', 'high']);
export type ViolationRiskBand = z.infer<typeof ViolationRiskBandSchema>;

/**
 * Advisory-only output of a `ViolationPredictorAdapter.predict` call.
 *
 * `advisory` is a `z.literal(true)` — the schema rejects any attempt to
 * silently flip this field. Hosts that want blocking behavior must do so in
 * a separately proven slice (out of scope for t-036).
 */
export const ViolationPredictionSchema = z.object({
  /** Overall probability in [0, 1] that the upcoming run would BLOCK. */
  probability: z.number().min(0).max(1),
  /** Coarse bucket derived from `probability` and the predictor's thresholds. */
  riskBand: ViolationRiskBandSchema,
  /** Hard invariant — schema-enforced. Never blocking by itself. */
  advisory: z.literal(true),
  /** Number of historical audit rows the predictor actually used. */
  sampleSize: z.number().int().nonnegative(),
  /**
   * Per-violation-kind probability in [0, 1].
   * Keys are `AuditViolation.kind` strings observed in the history window.
   * Empty object when `sampleSize === 0`.
   * H13-safe — the keys are closed-union discriminants, never symbol names.
   */
  perKindProbabilities: z.record(z.string(), z.number().min(0).max(1)),
  /** Echo of the feature inputs the predictor actually consumed. */
  featuresUsed: PredictorFeaturesSchema,
  /** Short machine-and-human-readable explanation. Never empty. */
  reason: z.string().min(1),
});
export type ViolationPrediction = z.infer<typeof ViolationPredictionSchema>;

// ---------------------------------------------------------------------------
// PredictViolationRiskRequest — engine-operation request envelope
// ---------------------------------------------------------------------------

/**
 * Input for the `predictViolationRisk` engine operation.
 *
 * Historical rows are passed in directly. This keeps Hoplon from introducing
 * a new audit-log scan method on `SnapshotStore` just to feed the predictor,
 * and it keeps the engine operation pure/read-only — the caller decides how
 * to source history (e.g., via `findAuditLogByProjectAndRun` or an external
 * analytics store).
 */
export const PredictViolationRiskRequestSchema = z
  .object({
    /** Mandatory trace ID (H11). */
    correlationId: z.string().min(1),
    /** Project scoping — must match the rows the caller feeds in. */
    projectId: z.string().min(1),
    /** Numeric features for the proposed run. Optional — history alone is valid. */
    proposedFeatures: PredictorFeaturesSchema.optional(),
    /**
     * Historical audit rows for this project. Order-insensitive; the predictor
     * should not depend on row order beyond treating them as independent samples.
     * Empty array is valid — predictor returns a zero-risk advisory with
     * `sampleSize: 0`.
     */
    historicalRecords: z.array(AuditLogRecordSchema),
  })
  .superRefine((value, ctx) => {
    if (
      value.proposedFeatures !== undefined &&
      value.proposedFeatures.projectId !== value.projectId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedFeatures', 'projectId'],
        message:
          'proposedFeatures.projectId must match the top-level projectId',
      });
    }
  });
export type PredictViolationRiskRequest = z.infer<
  typeof PredictViolationRiskRequestSchema
>;
