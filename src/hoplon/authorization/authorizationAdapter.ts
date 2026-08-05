/**
 * authorization/authorizationAdapter.ts — typed seam for Hoplon's
 * authorization layer (T-143).
 *
 * Defines the `AuthorizationAdapter` interface and all supporting DTOs:
 * `HoplonAuthorizationRequest`, `HoplonAuthorizationDecision`,
 * `TokenCapabilities`, and `ScopeClaim`.
 *
 * Architecture rules:
 *   - No ambient state: all dependencies must be injected.
 *   - No OPA, sidecar, filesystem, network, or clock calls here.
 *   - This file is types + interface only. Implementations live in
 *     sibling files (`staticAuthorizationAdapter.ts`,
 *     `opaAuthorizationAdapter.ts`).
 *   - Named exports only. ES modules.
 */
import type {
  RbaaRiskPosture,
  RbaaSchemaVersion,
  RbaaUsageLimits,
} from '../contracts/rbaaAuthorization.js';

/**
 * Per-capability scope claim carried in an authorization decision or
 * minted token. Paths and branches use glob-style patterns; consumers
 * must not rely on exact string equality.
 */
export type ScopeClaim = {
  paths: string[];
  branches: string[];
  deniedPaths?: string[];
  astNodeIds?: string[];
  astSelectors?: string[];
  maxOperations?: number;
  maxFilesTouched?: number;
};

/**
 * Capability map returned in an `allow` or `requires_escalation` /
 * `requires_approval` decision. Each capability key is optional; absence
 * means the capability was not granted or not requested.
 */
export type TokenCapabilities = {
  read?: ScopeClaim;
  search?: ScopeClaim;
  write?: ScopeClaim;
  lock?: ScopeClaim;
  snapshot?: ScopeClaim;
};

export type RbaaAuthorizationEvidence = {
  schemaVersion: RbaaSchemaVersion;
  risk: RbaaRiskPosture;
  limits: RbaaUsageLimits;
};

/**
 * Full typed request sent to `AuthorizationAdapter.evaluateAccess`.
 * All fields are required by the adapter contract so implementations
 * can make decisions without secondary lookups.
 */
export type HoplonAuthorizationRequest = {
  principal: {
    id: string;
    type: 'agent' | 'human' | 'service';
    roles: string[];
  };

  task: {
    id: string;
    type?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    delegationChain?: string[];
  };

  request: {
    projectId: string;
    branch: string;
    capabilities: Array<'read' | 'search' | 'write' | 'lock' | 'snapshot'>;
    paths?: string[];
    astSelectors?: string[];
    astNodeIds?: string[];
    reason?: string;
  };

  context: {
    sessionId: string;
    environment: 'dev' | 'staging' | 'prod';
    now: string;
  };
};

/**
 * Typed decision returned by `AuthorizationAdapter.evaluateAccess`.
 *
 * Variants:
 *   - `allow`               — access granted; capabilities and TTL are set.
 *   - `requires_escalation` — access not granted without escalation.
 *   - `requires_approval`   — access requires explicit human/security approval.
 *   - `deny`                — access denied; no escalation path available.
 */
export type HoplonAuthorizationDecision =
  | {
      outcome: 'allow';
      source: 'standing_policy' | 'escalation_grant' | 'break_glass';
      capabilities: TokenCapabilities;
      expiresInSeconds: number;
      decisionId: string;
      policyVersion: string;
      grantIds?: string[];
      rbaa?: RbaaAuthorizationEvidence;
    }
  | {
      outcome: 'requires_escalation';
      escalationKind:
        | 'self_service'
        | 'cto_approval'
        | 'human_approval'
        | 'security_approval'
        | 'platform_approval'
        | 'dba_approval';
      requestedScope: TokenCapabilities;
      reason: string;
      decisionId: string;
      policyVersion: string;
    }
  | {
      outcome: 'requires_approval';
      escalationKind:
        | 'human_approval'
        | 'security_approval'
        | 'platform_approval'
        | 'dba_approval';
      requestedScope: TokenCapabilities;
      reason: string;
      decisionId: string;
      policyVersion: string;
    }
  | {
      outcome: 'deny';
      reason: string;
      decisionId: string;
      policyVersion: string;
    };

/**
 * The authorization adapter seam. Implementations must be injected;
 * they must not capture ambient filesystem, network, clock, or process
 * state. The static compatibility implementation is
 * `StaticAuthorizationAdapter`; the dynamic OPA implementation is
 * `OpaAuthorizationAdapter` (a later task).
 */
export interface AuthorizationAdapter {
  evaluateAccess(
    request: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision>;
}
