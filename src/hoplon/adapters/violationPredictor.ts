/**
 * adapters/violationPredictor.ts — advisory violation-risk predictor seam (t-036).
 *
 * Ships two concrete adapters behind a stable interface:
 *   - `createNoopViolationPredictor()` — zero-risk default. This is the engine
 *     factory's runtime default when no predictor is supplied.
 *   - `createBaseRateViolationPredictor()` — a small, deterministic statistical
 *     predictor over historical ML2 audit-log rows. Not a default; callers
 *     wire it explicitly. Remains `advisory: true` regardless of configuration.
 *
 * Both implementations consume `AuditLogRecord` rows directly — there is no
 * parallel feature store. H13 stays intact because only counts, ratios, and
 * closed-union violation-kind strings cross the seam.
 *
 * Outside t-036 scope: default-blocking behavior, adoption by `auditDiff`,
 * adoption by the structural audit gate. Any such follow-on must ship as a
 * separate slice with its own durable proof corpus.
 */

import type {
  AuditLogRecord,
  AuditLogResult,
} from '../contracts/auditLog.js';
import type {
  PredictorFeatures,
  ViolationPrediction,
  ViolationRiskBand,
} from '../contracts/violationPredictor.js';

// ---------------------------------------------------------------------------
// PredictorInput — the structural input the adapter sees
// ---------------------------------------------------------------------------

export interface PredictorInput {
  projectId: string;
  proposedFeatures?: PredictorFeatures;
  historicalRecords: AuditLogRecord[];
}

export interface ViolationPredictorAdapter {
  /**
   * Score the proposed run against historical audit rows.
   *
   * MUST return `advisory: true`; the schema literal enforces this at the
   * operation boundary. Implementations should be deterministic given the
   * same `(projectId, historicalRecords, proposedFeatures)` triple.
   */
  predict(input: PredictorInput, signal?: AbortSignal): Promise<ViolationPrediction>;
}

// ---------------------------------------------------------------------------
// No-op factory — zero-risk advisory default
// ---------------------------------------------------------------------------

export function createNoopViolationPredictor(): ViolationPredictorAdapter {
  return {
    async predict(input: PredictorInput): Promise<ViolationPrediction> {
      const featuresUsed: PredictorFeatures = {
        ...(input.proposedFeatures ?? {}),
        projectId: input.projectId,
      };
      return {
        probability: 0,
        riskBand: 'low',
        advisory: true,
        sampleSize: input.historicalRecords.length,
        perKindProbabilities: {},
        featuresUsed,
        reason:
          'noop violation predictor — zero-risk advisory default; no history inspection',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Base-rate predictor — deterministic statistical implementation
// ---------------------------------------------------------------------------

export interface BaseRateViolationPredictorOptions {
  /**
   * Threshold `probability >= mediumThreshold` promotes a `low` band to
   * `medium`. Default: 0.2.
   */
  mediumThreshold?: number;
  /**
   * Threshold `probability >= highThreshold` promotes a `medium` band to
   * `high`. Default: 0.5.
   */
  highThreshold?: number;
  /**
   * Minimum historical `AUDIT_DIFF` rows required before the band may rise
   * above `low`. Below this count the band clamps to `low` to avoid acting
   * confidently on sparse history. Default: 3.
   */
  minSampleSize?: number;
  /**
   * Weight applied when the proposed `manifestScopeRatio` diverges from the
   * historical mean. The adjustment is bounded and never flips advisory into
   * blocking. Default: 0.25.
   */
  scopeDivergenceWeight?: number;
}

const DEFAULT_MEDIUM_THRESHOLD = 0.2;
const DEFAULT_HIGH_THRESHOLD = 0.5;
const DEFAULT_MIN_SAMPLE_SIZE = 3;
const DEFAULT_SCOPE_DIVERGENCE_WEIGHT = 0.25;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pickBand(
  probability: number,
  sampleSize: number,
  opts: Required<BaseRateViolationPredictorOptions>,
): ViolationRiskBand {
  if (sampleSize < opts.minSampleSize) return 'low';
  if (probability >= opts.highThreshold) return 'high';
  if (probability >= opts.mediumThreshold) return 'medium';
  return 'low';
}

export function createBaseRateViolationPredictor(
  options: BaseRateViolationPredictorOptions = {},
): ViolationPredictorAdapter {
  const opts: Required<BaseRateViolationPredictorOptions> = {
    mediumThreshold: options.mediumThreshold ?? DEFAULT_MEDIUM_THRESHOLD,
    highThreshold: options.highThreshold ?? DEFAULT_HIGH_THRESHOLD,
    minSampleSize: options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE,
    scopeDivergenceWeight:
      options.scopeDivergenceWeight ?? DEFAULT_SCOPE_DIVERGENCE_WEIGHT,
  };
  return {
    async predict(input: PredictorInput): Promise<ViolationPrediction> {
      return computeBaseRatePrediction(input, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic core — exported for targeted unit tests only
// ---------------------------------------------------------------------------

export function computeBaseRatePrediction(
  input: PredictorInput,
  opts: Required<BaseRateViolationPredictorOptions>,
): ViolationPrediction {
  const { projectId, proposedFeatures, historicalRecords } = input;
  const featuresUsed: PredictorFeatures = {
    ...(proposedFeatures ?? {}),
    projectId,
  };

  // Restrict to AUDIT_DIFF rows for this project — only audits carry
  // violation-kind truth; CREATE_SNAPSHOT/REVERT rows do not reflect blocks.
  const auditRows = historicalRecords.filter(
    (row): row is AuditLogRecord & { result: AuditLogResult } =>
      row.projectId === projectId && row.operation === 'AUDIT_DIFF',
  );
  const sampleSize = auditRows.length;

  if (sampleSize === 0) {
    return {
      probability: 0,
      riskBand: 'low',
      advisory: true,
      sampleSize: 0,
      perKindProbabilities: {},
      featuresUsed,
      reason:
        'no AUDIT_DIFF history for this project — returning zero-risk advisory',
    };
  }

  const blockCount = auditRows.filter((r) => r.result === 'BLOCK').length;
  const blockRate = blockCount / sampleSize;

  // Per-kind rate: (# rows whose kinds include K) / sampleSize.
  const kindCounts = new Map<string, number>();
  for (const row of auditRows) {
    const seen = new Set<string>();
    for (const kind of row.violationKinds) {
      if (seen.has(kind)) continue;
      seen.add(kind);
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }
  }
  const perKindProbabilities: Record<string, number> = {};
  for (const [kind, count] of kindCounts) {
    perKindProbabilities[kind] = clamp01(count / sampleSize);
  }

  // Scope-divergence adjustment: if the proposed manifestScopeRatio is far
  // from the historical mean, nudge the base-rate probability toward the
  // `high` bucket. The adjustment is bounded by `scopeDivergenceWeight`.
  let scopeAdjustment = 0;
  const historicalRatios = auditRows
    .map((r) => r.manifestScopeRatio ?? null)
    .filter((v): v is number => typeof v === 'number');
  const proposedRatio = proposedFeatures?.manifestScopeRatio;
  if (
    historicalRatios.length > 0 &&
    typeof proposedRatio === 'number' &&
    Number.isFinite(proposedRatio)
  ) {
    const mean =
      historicalRatios.reduce((sum, v) => sum + v, 0) / historicalRatios.length;
    const divergence = Math.abs(proposedRatio - mean);
    scopeAdjustment = divergence * opts.scopeDivergenceWeight;
  }

  const probability = clamp01(blockRate + scopeAdjustment);
  const riskBand = pickBand(probability, sampleSize, opts);

  const reasonParts = [
    `base-rate ${blockCount}/${sampleSize}=${blockRate.toFixed(3)}`,
  ];
  if (scopeAdjustment > 0) {
    reasonParts.push(`scope-divergence +${scopeAdjustment.toFixed(3)}`);
  }
  if (sampleSize < opts.minSampleSize) {
    reasonParts.push(
      `sample<${opts.minSampleSize} — clamped to low advisory band`,
    );
  }

  return {
    probability,
    riskBand,
    advisory: true,
    sampleSize,
    perKindProbabilities,
    featuresUsed,
    reason: reasonParts.join('; '),
  };
}
