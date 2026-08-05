/**
 * authorization/capabilityTokenFreeze.ts — clone/freeze helpers for
 * capability token minting.
 *
 * Keeps minted token evidence detached from mutable authorization decision
 * objects supplied by callers.
 */
import type {
  RbaaAuthorizationEvidence,
  ScopeClaim,
  TokenCapabilities,
} from './authorizationAdapter.js';
import type { PolicyEvidence } from './capabilityToken.js';

const CAPABILITY_KEYS = ['read', 'search', 'write', 'lock', 'snapshot'] as const;

export function cloneAndFreezeCapabilities(
  capabilities: TokenCapabilities,
): TokenCapabilities {
  const cloned: TokenCapabilities = {};
  for (const key of CAPABILITY_KEYS) {
    const claim = capabilities[key];
    if (claim !== undefined) cloned[key] = cloneAndFreezeScopeClaim(claim);
  }
  return Object.freeze(cloned);
}

export function cloneAndFreezePolicy(policy: PolicyEvidence): PolicyEvidence {
  return Object.freeze({
    engine: policy.engine,
    source: policy.source,
    decisionId: policy.decisionId,
    policyVersion: policy.policyVersion,
    ...(policy.grantIds !== undefined
      ? { grantIds: freezeStringArray(policy.grantIds) }
      : {}),
    ...(policy.rbaa !== undefined
      ? { rbaa: cloneAndFreezeRbaaEvidence(policy.rbaa) }
      : {}),
  });
}

function cloneAndFreezeRbaaEvidence(
  evidence: RbaaAuthorizationEvidence,
): RbaaAuthorizationEvidence {
  return Object.freeze({
    schemaVersion: evidence.schemaVersion,
    limits: Object.freeze({ ...evidence.limits }),
    risk: Object.freeze({
      evaluationId: evidence.risk.evaluationId,
      band: evidence.risk.band,
      scoreBucket: evidence.risk.scoreBucket,
      autonomyTier: evidence.risk.autonomyTier,
      controls: freezeStringArray(evidence.risk.controls),
      topFactors: Object.freeze(
        evidence.risk.topFactors.map((factor) =>
          Object.freeze({
            id: factor.id,
            source: factor.source,
            label: factor.label,
            severity: factor.severity,
            ...(factor.evidenceRef !== undefined
              ? { evidenceRef: factor.evidenceRef }
              : {}),
          }),
        ),
      ) as unknown as RbaaAuthorizationEvidence['risk']['topFactors'],
    }),
  });
}

function cloneAndFreezeScopeClaim(claim: ScopeClaim): ScopeClaim {
  return Object.freeze({
    paths: freezeStringArray(claim.paths),
    branches: freezeStringArray(claim.branches),
    ...(claim.deniedPaths !== undefined
      ? { deniedPaths: freezeStringArray(claim.deniedPaths) }
      : {}),
    ...(claim.astNodeIds !== undefined
      ? { astNodeIds: freezeStringArray(claim.astNodeIds) }
      : {}),
    ...(claim.astSelectors !== undefined
      ? { astSelectors: freezeStringArray(claim.astSelectors) }
      : {}),
    ...(claim.maxOperations !== undefined
      ? { maxOperations: claim.maxOperations }
      : {}),
    ...(claim.maxFilesTouched !== undefined
      ? { maxFilesTouched: claim.maxFilesTouched }
      : {}),
  });
}

function freezeStringArray<T extends string>(values: T[]): T[] {
  return Object.freeze([...values]) as unknown as T[];
}
