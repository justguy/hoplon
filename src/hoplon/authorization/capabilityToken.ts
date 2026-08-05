/**
 * authorization/capabilityToken.ts — capability-scoped engagement token
 * minting and validation (T-144).
 *
 * Extends `EngagementTokenEnvelope` with capability-specific scope claims
 * and policy evidence without changing the base lifecycle contract.
 *
 * Contract rules:
 *   - Only `allow` decisions may mint a token. Non-allow decisions (deny,
 *     requires_escalation, requires_approval) throw `CapabilityTokenError`.
 *   - No raw bearer tokens may appear in policy history or audit output.
 *   - OPA must never call this module directly; the module is a pure
 *     adapter utility with all side-effects injected.
 *   - Named exports only. TypeScript strict mode. No `any`.
 */
import { randomBytes } from 'node:crypto';

import type { EngagementTokenEnvelope } from '../concurrency/projectPolicy.js';
import type {
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
  RbaaAuthorizationEvidence,
  TokenCapabilities,
  ScopeClaim,
} from './authorizationAdapter.js';
import {
  cloneAndFreezeCapabilities,
  cloneAndFreezePolicy,
} from './capabilityTokenFreeze.js';

// ─── Re-exports for convenience ────────────────────────────────────────────

export type { TokenCapabilities, ScopeClaim };

// ─── Policy evidence ───────────────────────────────────────────────────────

/**
 * Policy provenance carried inside a `CapabilityEngagementToken`.
 * Mirrors the fields on an `allow` decision that constitute the audit
 * evidence chain: engine name, decision source, a stable decisionId, the
 * policy version that produced the decision, and optional grant ids when
 * the source is escalation-based.
 */
export type PolicyEvidence = {
  /** Adapter/engine that produced the decision (e.g. "static", "opa"). */
  engine: string;
  /** How the allow was sourced. Mirrors `HoplonAuthorizationDecision.source`. */
  source: 'standing_policy' | 'escalation_grant' | 'break_glass';
  /** Unique identifier for this specific decision. Required for audit. */
  decisionId: string;
  /** Version string of the policy that was active at decision time. */
  policyVersion: string;
  /** Grant IDs when source is `escalation_grant`. */
  grantIds?: string[];
  /** RBAA risk posture and usage limits when minted from the RBAA adapter. */
  rbaa?: RbaaAuthorizationEvidence;
};

// ─── Extended envelope ─────────────────────────────────────────────────────

/**
 * Capability-scoped engagement token envelope. Extends the base
 * `EngagementTokenEnvelope` with:
 *   - `tokenId`     — unique identifier for this token issuance.
 *   - `subject`     — principal id (mirrors `principalId`; explicit alias
 *                     for downstream consumers that expect a JWT-like
 *                     `subject` field).
 *   - `sessionId`   — session binding from the originating request.
 *   - `taskId`      — optional task binding.
 *   - `capabilities` — per-capability scope claims.
 *   - `policy`      — policy evidence for audit traceability.
 *
 * All base `EngagementTokenEnvelope` fields are preserved unchanged.
 */
export type CapabilityEngagementToken = EngagementTokenEnvelope & {
  readonly tokenId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly capabilities: TokenCapabilities;
  readonly policy: PolicyEvidence;
};

// ─── Error type ────────────────────────────────────────────────────────────

export type CapabilityTokenErrorKind =
  | 'non_allow_decision'
  | 'invalid_scope_claim'
  | 'missing_policy_evidence'
  | 'token_expired';

export class CapabilityTokenError extends Error {
  public readonly kind: CapabilityTokenErrorKind;

  constructor(kind: CapabilityTokenErrorKind, message: string) {
    super(message);
    this.name = 'CapabilityTokenError';
    this.kind = kind;
  }
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Typed result of `validateCapabilityToken`. Either a valid token (with the
 * parsed envelope) or a typed error describing the specific failure.
 */
export type CapabilityTokenValidation =
  | { kind: 'valid'; token: CapabilityEngagementToken }
  | { kind: 'expired'; tokenId: string; nowIso: string }
  | { kind: 'invalid_scope_claim'; field: string; reason: string }
  | { kind: 'missing_policy_evidence'; field: string };

/**
 * Validate a `CapabilityEngagementToken` shape and its time-based expiry.
 *
 * Rejects when:
 *   - Any `ScopeClaim` in `capabilities` is missing `paths` or `branches`
 *     (or either is an empty array).
 *   - `policy.decisionId` or `policy.policyVersion` is absent or empty when
 *     `policy.engine` is present (i.e. policy engine is declared but
 *     evidence is incomplete).
 *   - `token.expiresAtIso` has already passed (token is expired).
 */
export function validateCapabilityToken(
  candidate: CapabilityEngagementToken,
  now: Date,
): CapabilityTokenValidation {
  // Expiry check first — always the cheapest gate.
  const expiresMs = Date.parse(candidate.expiresAtIso);
  if (!Number.isFinite(expiresMs) || now.getTime() >= expiresMs) {
    return {
      kind: 'expired',
      tokenId: candidate.tokenId,
      nowIso: now.toISOString(),
    };
  }

  // Validate each scope claim in capabilities.
  const capabilityKeys = [
    'read',
    'search',
    'write',
    'lock',
    'snapshot',
  ] as const;
  for (const key of capabilityKeys) {
    const claim: ScopeClaim | undefined = candidate.capabilities[key];
    if (claim === undefined) continue;
    const pathsResult = validateScopeClaimArrayField(claim, key, 'paths');
    if (pathsResult !== null) return pathsResult;
    const branchesResult = validateScopeClaimArrayField(
      claim,
      key,
      'branches',
    );
    if (branchesResult !== null) return branchesResult;
  }

  // Validate policy evidence completeness when an engine is declared.
  const policyCheck = validatePolicyEvidence(candidate.policy);
  if (policyCheck !== null) return policyCheck;

  return { kind: 'valid', token: candidate };
}

function validateScopeClaimArrayField(
  claim: ScopeClaim,
  capKey: string,
  field: 'paths' | 'branches',
): CapabilityTokenValidation | null {
  const value = claim[field];
  if (!Array.isArray(value) || value.length === 0) {
    return {
      kind: 'invalid_scope_claim',
      field: `capabilities.${capKey}.${field}`,
      reason: `${field} must be a non-empty array`,
    };
  }
  return null;
}

function validatePolicyEvidence(
  policy: PolicyEvidence,
): CapabilityTokenValidation | null {
  if (typeof policy.engine !== 'string' || policy.engine.length === 0) {
    return null; // engine absent → no evidence validation required
  }
  if (typeof policy.decisionId !== 'string' || policy.decisionId.length === 0) {
    return { kind: 'missing_policy_evidence', field: 'policy.decisionId' };
  }
  if (
    typeof policy.policyVersion !== 'string' ||
    policy.policyVersion.length === 0
  ) {
    return { kind: 'missing_policy_evidence', field: 'policy.policyVersion' };
  }
  return null;
}

// ─── Minting ───────────────────────────────────────────────────────────────

/**
 * Dependencies injected into `mintCapabilityToken` so the function
 * is testable without ambient state.
 */
export interface MintCapabilityTokenDeps {
  /** Override token ID generation (e.g. for deterministic tests). */
  readonly generateTokenId?: () => string;
  /** Override the clock (e.g. for deterministic tests). */
  readonly clock?: () => Date;
  /** Engine name to embed in `PolicyEvidence`. Defaults to "unknown". */
  readonly engineName?: string;
}

/**
 * Mint a `CapabilityEngagementToken` from an `allow` decision.
 *
 * Throws `CapabilityTokenError` with `kind: 'non_allow_decision'` when
 * the decision outcome is not `allow`. This is a hard contract: deny,
 * requires_escalation, and requires_approval must never produce tokens.
 *
 * The resulting token envelope:
 *   - Inherits all base `EngagementTokenEnvelope` fields from `baseEnvelope`.
 *   - Sets `tokenId` to a fresh random hex string (or the injected override).
 *   - Sets `subject` from `req.principal.id`.
 *   - Sets `sessionId` from `req.context.sessionId`.
 *   - Sets `taskId` from `req.task.id` when present.
 *   - Sets `issuedAt` / `expiresAt` from the injected clock + `ttlSeconds`.
 *   - Sets `capabilities` from `decision.capabilities`.
 *   - Sets `policy` from the decision's evidence fields.
 */
export function mintCapabilityToken(
  decision: HoplonAuthorizationDecision & { outcome: 'allow' },
  req: HoplonAuthorizationRequest,
  ttlSeconds: number,
  baseEnvelope: EngagementTokenEnvelope,
  deps: MintCapabilityTokenDeps = {},
): CapabilityEngagementToken {
  if (decision.outcome !== 'allow') {
    throw new CapabilityTokenError(
      'non_allow_decision',
      `Cannot mint a capability token from a non-allow decision (outcome: ${String((decision as HoplonAuthorizationDecision).outcome)})`,
    );
  }

  const clock = deps.clock ?? (() => new Date());
  const generateTokenId =
    deps.generateTokenId ?? (() => randomBytes(16).toString('hex'));
  const engineName = deps.engineName ?? 'unknown';

  const now = clock();
  const issuedAtIso = now.toISOString();
  const expiresAtIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const policy: PolicyEvidence = {
    engine: engineName,
    source: decision.source,
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
    ...(decision.grantIds !== undefined
      ? { grantIds: decision.grantIds }
      : {}),
    ...(decision.rbaa !== undefined ? { rbaa: decision.rbaa } : {}),
  };

  const token: CapabilityEngagementToken = Object.freeze({
    // Base envelope fields (all preserved).
    token: baseEnvelope.token,
    projectId: baseEnvelope.projectId,
    folder: baseEnvelope.folder,
    access: baseEnvelope.access,
    principalId: baseEnvelope.principalId,
    // Capability-scoped extension fields.
    tokenId: generateTokenId(),
    subject: req.principal.id,
    sessionId: req.context.sessionId,
    ...(req.task.id.length > 0 ? { taskId: req.task.id } : {}),
    issuedAtIso,
    expiresAtIso,
    capabilities: cloneAndFreezeCapabilities(decision.capabilities),
    policy: cloneAndFreezePolicy(policy),
  });

  return token;
}
