import type {
  AdvisoryEvidenceState,
  AdvisoryIntelligenceProviderState,
  AdvisoryIntelligenceSidecarEnvelope,
} from '../contracts/advisoryIntelligence.js';
import {
  AdvisoryIntelligenceSidecarEnvelopeSchema,
  createAdvisoryEvidenceStateFromProvider,
  createAdvisoryIntelligenceAuthority,
  createStrictAgentIntelligenceAccess,
} from '../contracts/advisoryIntelligence.js';

export function makeReadIntelligenceSidecar(
  sidecarKind: string,
  provider: AdvisoryIntelligenceProviderState,
  payload: unknown,
  evidence?: AdvisoryEvidenceState,
): AdvisoryIntelligenceSidecarEnvelope {
  return AdvisoryIntelligenceSidecarEnvelopeSchema.parse({
    version: 1,
    advisory: true,
    surface: 'read',
    sidecarKind,
    provider,
    evidence: evidence ?? createAdvisoryEvidenceStateFromProvider(provider),
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
    payload,
  });
}

export function unavailableProvider(
  providerId: string,
  reason: string,
): AdvisoryIntelligenceProviderState {
  return {
    providerId,
    status: 'unavailable',
    reason,
    detail: null,
  };
}

export function degradedProvider(
  providerId: string,
  reason: string,
): AdvisoryIntelligenceProviderState {
  return {
    providerId,
    status: 'degraded',
    reason,
    detail: null,
  };
}
