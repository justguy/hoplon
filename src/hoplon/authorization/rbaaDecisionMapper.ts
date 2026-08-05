import type {
  HoplonAuthorizationDecision,
  TokenCapabilities,
} from './authorizationAdapter.js';
import type {
  RbaaAuthorizationDecision,
} from '../contracts/rbaaAuthorization.js';

type RbaaApprovalKind =
  | 'self_service'
  | 'cto_approval'
  | 'human_approval'
  | 'security_approval'
  | 'platform_approval'
  | 'dba_approval';

export function mapRbaaDecision(
  decision: RbaaAuthorizationDecision,
  buildDeny: (reason: string) => HoplonAuthorizationDecision,
): HoplonAuthorizationDecision {
  if (decision.outcome === 'allow') {
    return {
      outcome: 'allow',
      source: mapAllowSource(decision.source),
      capabilities: decision.capabilities as TokenCapabilities,
      expiresInSeconds: decision.limits.expiresInSeconds,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
      rbaa: {
        schemaVersion: decision.schemaVersion,
        risk: decision.risk,
        limits: decision.limits,
      },
      ...(decision.grantIds !== undefined
        ? { grantIds: [...decision.grantIds] }
        : {}),
    };
  }
  if (decision.outcome === 'requires_escalation') {
    return {
      outcome: 'requires_escalation',
      escalationKind: decision.escalationKind,
      requestedScope: decision.requestedScope as TokenCapabilities,
      reason: decision.reason,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }
  if (decision.outcome === 'requires_approval') {
    if (!isHoplonApprovalKind(decision.escalationKind)) {
      return buildDeny(
        `rbaa_unsupported_approval_kind: ${decision.escalationKind}`,
      );
    }
    return {
      outcome: 'requires_approval',
      escalationKind: decision.escalationKind,
      requestedScope: decision.requestedScope as TokenCapabilities,
      reason: decision.reason,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }
  if (decision.outcome === 'quarantine') {
    return buildDeny(`rbaa_quarantine: ${decision.reason}`);
  }
  return {
    outcome: 'deny',
    reason: decision.reason,
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
  };
}

function mapAllowSource(
  source: Extract<RbaaAuthorizationDecision, { outcome: 'allow' }>['source'],
): Extract<HoplonAuthorizationDecision, { outcome: 'allow' }>['source'] {
  if (source === 'risk_adjusted') return 'standing_policy';
  return source;
}

function isHoplonApprovalKind(
  kind: RbaaApprovalKind,
): kind is Extract<
  HoplonAuthorizationDecision,
  { outcome: 'requires_approval' }
>['escalationKind'] {
  return (
    kind === 'human_approval' ||
    kind === 'security_approval' ||
    kind === 'platform_approval' ||
    kind === 'dba_approval'
  );
}
