/**
 * operations/predictViolationRisk.ts — t-036 engine-side consumer of the
 * advisory violation predictor.
 *
 * Thin wrapper that:
 *   - validates the request against `PredictViolationRiskRequestSchema`
 *   - delegates to the configured `ViolationPredictorAdapter`
 *   - re-parses the prediction through `ViolationPredictionSchema` — the
 *     `advisory: z.literal(true)` in that schema is the hard invariant that
 *     blocks a misbehaving adapter from smuggling a blocking verdict past
 *     the engine surface
 *   - emits H13-compliant start/end/error telemetry
 *
 * This operation never touches `auditDiff`, `createSnapshot`, or any gating
 * path. It never writes to `hoplon_audit_log`. It never consults the
 * filesystem or git object store. Advisory only.
 */

import type { HoplonEmitter } from '../adapters/emitter.js';
import type { ViolationPredictorAdapter } from '../adapters/violationPredictor.js';
import {
  PredictViolationRiskRequestSchema,
  ViolationPredictionSchema,
  type PredictViolationRiskRequest,
  type ViolationPrediction,
} from '../contracts/violationPredictor.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId } from '../util/validators.js';

export interface PredictViolationRiskDeps {
  violationPredictor: ViolationPredictorAdapter;
  emitter: HoplonEmitter;
  engineId: string;
}

export async function predictViolationRisk(
  deps: PredictViolationRiskDeps,
  req: PredictViolationRiskRequest,
  signal?: AbortSignal,
): Promise<ViolationPrediction> {
  const parsed = PredictViolationRiskRequestSchema.safeParse(req);
  if (!parsed.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: corrId,
        cause: parsed.error,
      },
      `predictViolationRisk: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);

  const start = Date.now();
  deps.emitter.emit({
    op: 'predictViolationRisk',
    phase: 'start',
    engineId: deps.engineId,
    projectId: request.projectId,
    correlationId: request.correlationId,
  });

  try {
    const raw = await deps.violationPredictor.predict(
      {
        projectId: request.projectId,
        historicalRecords: request.historicalRecords,
        ...(request.proposedFeatures !== undefined
          ? { proposedFeatures: request.proposedFeatures }
          : {}),
      },
      signal,
    );

    // Re-validate adapter output. The `advisory: z.literal(true)` in the
    // schema is the hard invariant: any adapter that returns advisory=false
    // (or non-numeric probability, or missing sampleSize) fails here.
    const validated = ViolationPredictionSchema.safeParse(raw);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `predictViolationRisk: violationPredictor adapter returned invalid prediction: ${validated.error.message}`,
      );
    }
    const prediction = validated.data;

    deps.emitter.emit({
      op: 'predictViolationRisk',
      phase: 'end',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });

    return prediction;
  } catch (err) {
    deps.emitter.emit({
      op: 'predictViolationRisk',
      phase: 'error',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      errorCategory: err instanceof ValidationError ? 'validation' : 'adapter',
      errorKind:
        err instanceof ValidationError ? err.kind : 'predictor_failed',
    });
    throw err;
  }
}
