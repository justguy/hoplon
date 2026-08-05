/**
 * operations/scoreAnomaly.ts — t-037 engine-side consumer of the advisory
 * anomaly detector.
 *
 * Thin wrapper that:
 *   - validates the request against `ScoreAnomalyRequestSchema`
 *   - delegates to the configured `AnomalyDetectorAdapter`
 *   - re-parses the score through `AnomalyScoreSchema` — the
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
import type { AnomalyDetectorAdapter } from '../adapters/anomalyDetector.js';
import {
  ScoreAnomalyRequestSchema,
  AnomalyScoreSchema,
  type ScoreAnomalyRequest,
  type AnomalyScore,
} from '../contracts/anomalyDetector.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId } from '../util/validators.js';

export interface ScoreAnomalyDeps {
  anomalyDetector: AnomalyDetectorAdapter;
  emitter: HoplonEmitter;
  engineId: string;
}

export async function scoreAnomaly(
  deps: ScoreAnomalyDeps,
  req: ScoreAnomalyRequest,
  signal?: AbortSignal,
): Promise<AnomalyScore> {
  const parsed = ScoreAnomalyRequestSchema.safeParse(req);
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
      `scoreAnomaly: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);

  const start = Date.now();
  deps.emitter.emit({
    op: 'scoreAnomaly',
    phase: 'start',
    engineId: deps.engineId,
    projectId: request.projectId,
    correlationId: request.correlationId,
  });

  try {
    const raw = await deps.anomalyDetector.score(
      {
        projectId: request.projectId,
        historicalRecords: request.historicalRecords,
        ...(request.proposedMetrics !== undefined
          ? { proposedMetrics: request.proposedMetrics }
          : {}),
      },
      signal,
    );

    // Re-validate adapter output. The `advisory: z.literal(true)` in the
    // schema is the hard invariant: any adapter that returns advisory=false
    // (or non-numeric score, or missing sampleSize) fails here.
    const validated = AnomalyScoreSchema.safeParse(raw);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `scoreAnomaly: anomalyDetector adapter returned invalid score: ${validated.error.message}`,
      );
    }
    const score = validated.data;

    deps.emitter.emit({
      op: 'scoreAnomaly',
      phase: 'end',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });

    return score;
  } catch (err) {
    deps.emitter.emit({
      op: 'scoreAnomaly',
      phase: 'error',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      errorCategory: err instanceof ValidationError ? 'validation' : 'adapter',
      errorKind:
        err instanceof ValidationError ? err.kind : 'anomaly_detector_failed',
    });
    throw err;
  }
}
