/**
 * contracts/advisoryIntelligence.ts — t-101 shared advisory-intelligence
 * sidecar envelope.
 *
 * The post-t-100 intelligence lane enriches Hoplon read, write-preview, and
 * verification payloads with metadata only. This contract pins that boundary:
 * every sidecar is advisory, reports provider availability honestly, cannot
 * mutate files, and cannot change deterministic PASS/BLOCK decisions.
 */

import { z } from 'zod';

export const ADVISORY_INTELLIGENCE_SURFACES = [
  'read',
  'write_preview',
  'verification',
] as const;
export const AdvisoryIntelligenceSurfaceSchema = z.enum(
  ADVISORY_INTELLIGENCE_SURFACES,
);
export type AdvisoryIntelligenceSurface = z.infer<
  typeof AdvisoryIntelligenceSurfaceSchema
>;

export const ADVISORY_INTELLIGENCE_PROVIDER_STATUSES = [
  'available',
  'degraded',
  'unavailable',
] as const;
export const AdvisoryIntelligenceProviderStatusSchema = z.enum(
  ADVISORY_INTELLIGENCE_PROVIDER_STATUSES,
);
export type AdvisoryIntelligenceProviderStatus = z.infer<
  typeof AdvisoryIntelligenceProviderStatusSchema
>;

export const ADVISORY_EVIDENCE_STATUSES = [
  'AVAILABLE',
  'DEGRADED',
  'UNAVAILABLE',
  'EMPTY',
  'NO_VERDICT',
] as const;
export const AdvisoryEvidenceStatusSchema = z.enum(ADVISORY_EVIDENCE_STATUSES);
export type AdvisoryEvidenceStatus = z.infer<
  typeof AdvisoryEvidenceStatusSchema
>;

export const AdvisoryEvidenceStateSchema = z
  .object({
    status: AdvisoryEvidenceStatusSchema,
    reason: z.string().min(1).nullable(),
    detail: z.string().min(1).nullable(),
    deterministicVerdict: z.null(),
    representsGreenProof: z.literal(false),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'AVAILABLE' && value.reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'available advisory evidence must not carry a degradation reason',
      });
    }
    if (value.status !== 'AVAILABLE' && value.reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'non-available advisory evidence requires an explicit reason',
      });
    }
  });
export type AdvisoryEvidenceState = z.infer<typeof AdvisoryEvidenceStateSchema>;

export const AdvisoryIntelligenceProviderStateSchema = z
  .object({
    providerId: z.string().min(1),
    status: AdvisoryIntelligenceProviderStatusSchema,
    reason: z.string().min(1).nullable(),
    detail: z.string().min(1).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== 'available' && value.reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'degraded/unavailable providers require an explicit reason',
      });
    }
  });
export type AdvisoryIntelligenceProviderState = z.infer<
  typeof AdvisoryIntelligenceProviderStateSchema
>;

export const AdvisoryIntelligenceAuthoritySchema = z.object({
  canMutateFiles: z.literal(false),
  canChangeDeterministicVerdict: z.literal(false),
  deterministicVerdictAuthority: z.literal('structural_manifest_policy_only'),
});
export type AdvisoryIntelligenceAuthority = z.infer<
  typeof AdvisoryIntelligenceAuthoritySchema
>;

export const StrictAgentIntelligenceAccessSchema = z.object({
  hoplonMediatedPayloadOnly: z.literal(true),
  exposesFullscopeTool: z.literal(false),
  exposesVectorTool: z.literal(false),
  exposesLspTool: z.literal(false),
  exposesFilesystemTool: z.literal(false),
});
export type StrictAgentIntelligenceAccess = z.infer<
  typeof StrictAgentIntelligenceAccessSchema
>;

export const AdvisoryIntelligenceSidecarEnvelopeSchema = z.object({
  version: z.literal(1),
  advisory: z.literal(true),
  surface: AdvisoryIntelligenceSurfaceSchema,
  sidecarKind: z.string().min(1),
  provider: AdvisoryIntelligenceProviderStateSchema,
  evidence: AdvisoryEvidenceStateSchema,
  authority: AdvisoryIntelligenceAuthoritySchema,
  strictAgentAccess: StrictAgentIntelligenceAccessSchema,
  payload: z.unknown(),
});
export type AdvisoryIntelligenceSidecarEnvelope = z.infer<
  typeof AdvisoryIntelligenceSidecarEnvelopeSchema
>;

export function createAdvisoryIntelligenceAuthority(): AdvisoryIntelligenceAuthority {
  return {
    canMutateFiles: false,
    canChangeDeterministicVerdict: false,
    deterministicVerdictAuthority: 'structural_manifest_policy_only',
  };
}

export function createStrictAgentIntelligenceAccess(): StrictAgentIntelligenceAccess {
  return {
    hoplonMediatedPayloadOnly: true,
    exposesFullscopeTool: false,
    exposesVectorTool: false,
    exposesLspTool: false,
    exposesFilesystemTool: false,
  };
}

export type CreateAdvisoryEvidenceStateInput =
  | {
      readonly status: 'AVAILABLE';
      readonly detail?: string | null;
    }
  | {
      readonly status: Exclude<AdvisoryEvidenceStatus, 'AVAILABLE'>;
      readonly reason: string;
      readonly detail?: string | null;
    };

export function createAdvisoryEvidenceState(
  input: CreateAdvisoryEvidenceStateInput,
): AdvisoryEvidenceState {
  const state =
    input.status === 'AVAILABLE'
      ? {
          status: input.status,
          reason: null,
          detail: input.detail ?? null,
          deterministicVerdict: null,
          representsGreenProof: false,
        }
      : {
          status: input.status,
          reason: input.reason,
          detail: input.detail ?? null,
          deterministicVerdict: null,
          representsGreenProof: false,
        };
  return AdvisoryEvidenceStateSchema.parse(state);
}

export function createAdvisoryEvidenceStateFromProvider(
  provider: AdvisoryIntelligenceProviderState,
): AdvisoryEvidenceState {
  if (provider.status === 'available') {
    return createAdvisoryEvidenceState({ status: 'AVAILABLE' });
  }
  return createAdvisoryEvidenceState({
    status: provider.status === 'degraded' ? 'DEGRADED' : 'UNAVAILABLE',
    reason: provider.reason ?? `${provider.providerId}_not_available`,
    detail: provider.detail,
  });
}

export function createSampleBackedAdvisoryEvidenceState(input: {
  readonly sampleSize: number;
  readonly emptyReason: string;
  readonly detail?: string | null;
}): AdvisoryEvidenceState {
  return input.sampleSize > 0
    ? createAdvisoryEvidenceState({
        status: 'AVAILABLE',
        detail: input.detail ?? null,
      })
    : createAdvisoryEvidenceState({
        status: 'EMPTY',
        reason: input.emptyReason,
        detail: input.detail ?? null,
      });
}
