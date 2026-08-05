/**
 * contracts/writePreviewIntelligence.ts - t-103 advisory write-preview
 * intelligence sidecars.
 *
 * These helpers wrap existing advisory seams in the shared t-101 envelope.
 * They do not add a second blast-radius mechanism and do not assign
 * deterministic PASS/BLOCK authority to risk metadata.
 */

import { z } from 'zod';
import { AdvisoryIntelligenceSidecarEnvelopeSchema, createAdvisoryIntelligenceAuthority, createStrictAgentIntelligenceAccess } from './advisoryIntelligence.js';
import { createWritePreviewRiskEvidenceState } from './writePreviewEvidence.js';
import {
  DependencyImpactSidecarSchema,
  type DependencyImpactSidecar,
} from './dependencyImpact.js';
import {
  PredictViolationRiskRequestSchema,
  ViolationPredictionSchema,
  type PredictViolationRiskRequest,
  type ViolationPrediction,
} from './violationPredictor.js';

export const WRITE_PREVIEW_INTELLIGENCE_SIDECAR_KINDS = ['blast_radius', 'violation_risk'] as const;
export const WritePreviewIntelligenceSidecarKindSchema = z.enum(
  WRITE_PREVIEW_INTELLIGENCE_SIDECAR_KINDS,
);

export const WRITE_PREVIEW_VIOLATION_RISK_STATUSES = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE'] as const;
export const WritePreviewViolationRiskStatusSchema = z.enum(
  WRITE_PREVIEW_VIOLATION_RISK_STATUSES,
);

export const WRITE_PREVIEW_VIOLATION_RISK_REASONS = [
  'not_requested', 'no_engine', 'predict_failed',
] as const;
export const WritePreviewViolationRiskReasonSchema = z.enum(
  WRITE_PREVIEW_VIOLATION_RISK_REASONS,
);
export type WritePreviewViolationRiskReason = z.infer<
  typeof WritePreviewViolationRiskReasonSchema
>;

export const WritePreviewRiskEvidenceSchema = z.object({
  changedFileCount: z.number().int().nonnegative(),
  dependencySubjectCounts: z.object({
    symbol: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
  }),
  historicalRecordCount: z.number().int().nonnegative(),
  historySource: z.literal('not_sourced_by_review_payload'),
});
export type WritePreviewRiskEvidence = z.infer<
  typeof WritePreviewRiskEvidenceSchema
>;

export const WritePreviewRiskConfidenceSchema = z.object({
  basis: z.literal('predictor_sample_size'),
  sampleSize: z.number().int().nonnegative(),
});

export const WritePreviewViolationRiskPayloadSchema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('AVAILABLE'),
      reason: z.null(),
      detail: z.null(),
      prediction: ViolationPredictionSchema,
      evidence: WritePreviewRiskEvidenceSchema,
      confidence: WritePreviewRiskConfidenceSchema,
    }),
    z.object({
      status: z.literal('DEGRADED'),
      reason: WritePreviewViolationRiskReasonSchema,
      detail: z.string().min(1),
      prediction: z.null(),
      evidence: WritePreviewRiskEvidenceSchema,
      confidence: z.null(),
    }),
    z.object({
      status: z.literal('UNAVAILABLE'),
      reason: WritePreviewViolationRiskReasonSchema,
      detail: z.string().min(1).nullable(),
      prediction: z.null(),
      evidence: WritePreviewRiskEvidenceSchema,
      confidence: z.null(),
    }),
  ]);
export const WritePreviewBlastRadiusSidecarSchema =
  AdvisoryIntelligenceSidecarEnvelopeSchema.extend({
    surface: z.literal('write_preview'),
    sidecarKind: z.literal('blast_radius'),
    payload: DependencyImpactSidecarSchema,
  });
export type WritePreviewBlastRadiusSidecar = z.infer<
  typeof WritePreviewBlastRadiusSidecarSchema
>;

export const WritePreviewViolationRiskSidecarSchema =
  AdvisoryIntelligenceSidecarEnvelopeSchema.extend({
    surface: z.literal('write_preview'),
    sidecarKind: z.literal('violation_risk'),
    payload: WritePreviewViolationRiskPayloadSchema,
  });
export type WritePreviewViolationRiskSidecar = z.infer<
  typeof WritePreviewViolationRiskSidecarSchema
>;

export const WritePreviewAdvisoryIntelligenceSchema = z.object({
  blastRadius: WritePreviewBlastRadiusSidecarSchema,
  violationRisk: WritePreviewViolationRiskSidecarSchema,
});
export type WritePreviewAdvisoryIntelligence = z.infer<
  typeof WritePreviewAdvisoryIntelligenceSchema
>;

export type PredictViolationRiskForPreview = (
  req: PredictViolationRiskRequest,
  signal?: AbortSignal,
) => Promise<ViolationPrediction>;

export interface ComposeWritePreviewAdvisoryIntelligenceInput {
  readonly dependencyImpact: DependencyImpactSidecar;
  readonly includeViolationRisk: boolean;
  readonly predictViolationRisk: PredictViolationRiskForPreview | null;
  readonly correlationId: string;
  readonly projectId: string;
  readonly changedFileCount: number;
  readonly signal?: AbortSignal | undefined;
}

export async function composeWritePreviewAdvisoryIntelligence(
  input: ComposeWritePreviewAdvisoryIntelligenceInput,
): Promise<WritePreviewAdvisoryIntelligence> {
  const evidence = createRiskEvidence(input);
  const violationRisk = await composeViolationRiskSidecar(input, evidence);
  return WritePreviewAdvisoryIntelligenceSchema.parse({
    blastRadius: createBlastRadiusSidecar(input.dependencyImpact),
    violationRisk,
  });
}

function createBlastRadiusSidecar(
  dependencyImpact: DependencyImpactSidecar,
): WritePreviewBlastRadiusSidecar {
  const providerStatus =
    dependencyImpact.status === 'AVAILABLE'
      ? 'available'
      : dependencyImpact.status === 'DEGRADED'
        ? 'degraded'
        : 'unavailable';
  return WritePreviewBlastRadiusSidecarSchema.parse({
    version: 1,
    advisory: true,
    surface: 'write_preview',
    sidecarKind: 'blast_radius',
    provider: {
      providerId: 'engine.analyzeBlastRadius',
      status: providerStatus,
      reason:
        providerStatus === 'available'
          ? null
          : dependencyImpact.reason ?? 'dependency_impact_unavailable',
      detail: dependencyImpact.detail,
    },
    evidence: dependencyImpact.evidence,
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
    payload: dependencyImpact,
  });
}

async function composeViolationRiskSidecar(
  input: ComposeWritePreviewAdvisoryIntelligenceInput,
  evidence: WritePreviewRiskEvidence,
): Promise<WritePreviewViolationRiskSidecar> {
  if (!input.includeViolationRisk) {
    return createViolationRiskSidecar('UNAVAILABLE', 'not_requested', null, null, evidence);
  }
  if (input.predictViolationRisk === null) {
    return createViolationRiskSidecar('UNAVAILABLE', 'no_engine', null, null, evidence);
  }

  try {
    const req = PredictViolationRiskRequestSchema.parse({
      correlationId: input.correlationId,
      projectId: input.projectId,
      historicalRecords: [],
    });
    const raw =
      input.signal === undefined
        ? await input.predictViolationRisk(req)
        : await input.predictViolationRisk(req, input.signal);
    const parsed = ViolationPredictionSchema.safeParse(raw);
    if (!parsed.success) {
      return createViolationRiskSidecar(
        'DEGRADED',
        'predict_failed',
        `invalid violation risk prediction: ${parsed.error.message}`,
        null,
        evidence,
      );
    }
    return createViolationRiskSidecar(
      'AVAILABLE',
      null,
      null,
      parsed.data,
      evidence,
    );
  } catch (err) {
    return createViolationRiskSidecar(
      'DEGRADED',
      'predict_failed',
      err instanceof Error ? err.message : String(err),
      null,
      evidence,
    );
  }
}

function createViolationRiskSidecar(
  status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE',
  reason: WritePreviewViolationRiskReason | null,
  detail: string | null,
  prediction: ViolationPrediction | null,
  evidence: WritePreviewRiskEvidence,
): WritePreviewViolationRiskSidecar {
  const providerStatus =
    status === 'AVAILABLE'
      ? 'available'
      : status === 'DEGRADED'
        ? 'degraded'
        : 'unavailable';
  const payloadDetail =
    status === 'DEGRADED'
      ? nonEmptyDetail(detail, 'violation risk provider failed')
      : detail ?? null;
  return WritePreviewViolationRiskSidecarSchema.parse({
    version: 1,
    advisory: true,
    surface: 'write_preview',
    sidecarKind: 'violation_risk',
    provider: {
      providerId: 'engine.predictViolationRisk',
      status: providerStatus,
      reason: providerStatus === 'available' ? null : reason ?? 'predict_failed',
      detail: payloadDetail,
    },
    evidence: createWritePreviewRiskEvidenceState(status, reason, prediction),
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
    payload:
      status === 'AVAILABLE'
        ? {
            status,
            reason: null,
            detail: null,
            prediction,
            evidence,
            confidence: {
              basis: 'predictor_sample_size',
              sampleSize: prediction?.sampleSize ?? 0,
            },
          }
        : {
            status,
            reason: reason ?? 'predict_failed',
            detail: payloadDetail,
            prediction: null,
            evidence,
            confidence: null,
          },
  });
}

function nonEmptyDetail(detail: string | null, fallback: string): string {
  return detail && detail.length > 0 ? detail : fallback;
}

function createRiskEvidence(
  input: ComposeWritePreviewAdvisoryIntelligenceInput,
): WritePreviewRiskEvidence {
  return {
    changedFileCount: input.changedFileCount,
    dependencySubjectCounts: {
      symbol: input.dependencyImpact.subjectCounts.symbol,
      file: input.dependencyImpact.subjectCounts.file,
    },
    historicalRecordCount: 0,
    historySource: 'not_sourced_by_review_payload',
  };
}
