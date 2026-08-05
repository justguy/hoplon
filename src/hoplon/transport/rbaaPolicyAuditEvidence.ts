import type { RbaaPolicyAuditEvidence } from '../contracts/rbaaAuthorization.js';
import type { CapabilityEngagementToken } from '../authorization/capabilityToken.js';

export function buildRbaaPolicyAuditEvidence(
  token: CapabilityEngagementToken | null,
  outcome: RbaaPolicyAuditEvidence['outcome'],
  recordedAt: string,
  operationId?: string,
): RbaaPolicyAuditEvidence | null {
  const rbaa = token?.policy.rbaa;
  if (token === null || rbaa === undefined || token.taskId === undefined) {
    return null;
  }
  return {
    schemaVersion: rbaa.schemaVersion,
    sessionId: token.sessionId,
    taskId: token.taskId,
    decisionId: token.policy.decisionId,
    policyVersion: token.policy.policyVersion,
    tokenId: token.tokenId,
    ...(operationId !== undefined && operationId.length > 0 ? { operationId } : {}),
    ...(token.policy.grantIds !== undefined ? { grantIds: token.policy.grantIds } : {}),
    limits: rbaa.limits,
    riskEvaluationId: rbaa.risk.evaluationId,
    riskBand: rbaa.risk.band,
    autonomyTier: rbaa.risk.autonomyTier,
    runtimeControls: rbaa.risk.controls,
    outcome,
    recordedAt,
  };
}
