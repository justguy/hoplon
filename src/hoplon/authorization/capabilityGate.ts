/**
 * authorization/capabilityGate.ts — pure capability-token assertion
 * for protected operations (T-147).
 *
 * `assertCapability` is the single source of truth for capability-scoped
 * authorization decisions. It is **pure**: no I/O, no clock other than
 * the injected one, no store lookup. The transport / MCP gate adapter
 * resolves the capability claims (via `CapabilityClaimsStore`), then
 * hands the resolved `CapabilityEngagementToken` to this function.
 *
 * Approval status (T-142): T-147 ships this gate as **advisory-only**.
 * The legacy strict engagement gate continues to be the default access
 * check; this gate runs in parallel only when the entry point opts in
 * via the `capabilityMode: 'enforce'` flag.
 *
 * Architecture rules:
 *   - No OPA / policy-engine call here. The decision is purely
 *     mathematical against an already-minted token.
 *   - No silent widening: missing branch / path data when the token
 *     carries a constrained capability returns `reauth_required`.
 *   - Read does not satisfy write; lock does not satisfy snapshot;
 *     each capability is checked discretely.
 *   - Named exports, ES modules, TypeScript strict.
 */

import type {
  ScopeClaim,
  TokenCapabilities,
} from './authorizationAdapter.js';
import type {
  CapabilityEngagementToken,
} from './capabilityToken.js';
import { matchGlobAny, matchGlobPattern } from './capabilityGlob.js';

/**
 * Capability key checked at a protected operation entry point.
 *
 * Maps directly to `TokenCapabilities`. We intentionally do not collapse
 * `read` into `search` (or vice versa) — a token granted only `read`
 * cannot pass a `search` gate. T-142 's verdict explicitly lists this
 * separation as a hard constraint.
 */
export type CapabilityKey =
  | 'read'
  | 'search'
  | 'write'
  | 'lock'
  | 'snapshot';

/**
 * Operation specification handed to `assertCapability`.
 *
 * `capability` selects which scope claim from the token applies.
 * Branch / path / AST fields are matched against that claim. Missing
 * branch / path on the request when the token carries those constraints
 * is a typed `reauth_required` outcome — never a silent allow.
 */
export interface CapabilityOpSpec {
  readonly capability: CapabilityKey;
  readonly projectId: string;
  /** Branch the operation is targeting. Empty string = no branch. */
  readonly branch: string;
  /** Project-relative path the operation is touching. */
  readonly path: string;
  /** AST node ids targeted by the operation, when applicable. */
  readonly astNodeIds?: ReadonlyArray<string>;
  /** AST selectors targeted by the operation, when applicable. */
  readonly astSelectors?: ReadonlyArray<string>;
  /**
   * Session id the operation is running under. Verified against the
   * token's `sessionId` binding. Empty string skips the session check
   * (legacy callers that have not yet plumbed a sessionId).
   */
  readonly sessionId?: string;
  /**
   * Task id the operation is running under. Verified against the
   * token's optional `taskId` binding. When the token has no
   * `taskId`, this field is ignored.
   */
  readonly taskId?: string;
  /**
   * Principal id the operation is running under. Verified against the
   * token's `subject` field. Empty string skips the principal check.
   */
  readonly principalId?: string;
}

/**
 * Typed reason codes for a `denied` or `reauth_required` outcome.
 *
 * Audit-ready: T-148 will consume the same set in its durable audit
 * envelope. Adding a new reason here is the only sanctioned way to
 * widen the surface.
 */
export type CapabilityDeniedReason =
  | 'token_expired'
  | 'capability_missing'
  | 'project_mismatch'
  | 'session_mismatch'
  | 'task_mismatch'
  | 'principal_mismatch'
  | 'branch_mismatch'
  | 'path_mismatch'
  | 'denied_path_match'
  | 'ast_mismatch'
  | 'invalid_token'
  | 'missing_branch'
  | 'missing_path'
  | 'missing_ast_coords'
  | 'missing_runtime_state'
  | 'operation_limit_exceeded'
  | 'file_touch_limit_exceeded'
  | 'token_revoked'
  | 'grant_revoked'
  | 'token_quarantined';

/**
 * Output of `assertCapability`. Always includes the typed `reason` so
 * audit and transport-layer envelope code can map without re-deriving.
 */
export type CapabilityAssertionResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'denied';
      readonly reason: CapabilityDeniedReason;
      readonly field?: string;
    }
  | {
      readonly kind: 'reauth_required';
      readonly reason: CapabilityDeniedReason;
      readonly field?: string;
    };

/**
 * Inputs to `assertCapability`. Clock is injected so tests can drive
 * expiry deterministically.
 */
export interface AssertCapabilityArgs {
  readonly token: CapabilityEngagementToken;
  readonly op: CapabilityOpSpec;
  readonly clock: () => Date;
}

/**
 * Pure capability-token assertion. Returns `ok` when every constraint
 * is satisfied, `denied` for a hard failure, or `reauth_required` when
 * the request is missing data the token would have constrained.
 *
 * Order of checks (cheapest first; fail-closed at every step):
 *   1. Expiry (token clock window).
 *   2. Capability presence.
 *   3. Project / session / task / principal binding.
 *   4. Branch glob match.
 *   5. Path glob match (then deniedPaths precedence).
 *   6. AST node / selector match.
 *
 * Counter-style limits and administrative runtime state are enforced
 * outside this pure scope assertion by the opt-in transport gate.
 */
export function assertCapability(
  args: AssertCapabilityArgs,
): CapabilityAssertionResult {
  const { token, op, clock } = args;

  // 1. Expiry. Hard fail-closed; no clock skew tolerance.
  const expiresMs = Date.parse(token.expiresAtIso);
  if (!Number.isFinite(expiresMs)) {
    return { kind: 'denied', reason: 'invalid_token', field: 'expiresAtIso' };
  }
  if (clock().getTime() >= expiresMs) {
    return { kind: 'reauth_required', reason: 'token_expired' };
  }

  // 2. Capability presence on the token.
  const capabilities: TokenCapabilities = token.capabilities;
  const claim: ScopeClaim | undefined = capabilities[op.capability];
  if (claim === undefined) {
    return {
      kind: 'denied',
      reason: 'capability_missing',
      field: op.capability,
    };
  }

  // 3. Project / session / task / principal binding.
  if (token.projectId !== op.projectId) {
    return { kind: 'denied', reason: 'project_mismatch' };
  }
  if (
    op.sessionId !== undefined &&
    op.sessionId.length > 0 &&
    token.sessionId !== op.sessionId
  ) {
    return { kind: 'denied', reason: 'session_mismatch' };
  }
  if (
    op.taskId !== undefined &&
    op.taskId.length > 0 &&
    token.taskId !== undefined &&
    token.taskId !== op.taskId
  ) {
    return { kind: 'denied', reason: 'task_mismatch' };
  }
  if (
    op.principalId !== undefined &&
    op.principalId.length > 0 &&
    token.subject !== op.principalId
  ) {
    return { kind: 'denied', reason: 'principal_mismatch' };
  }

  // 4. Branch matching against `claim.branches`.
  if (!Array.isArray(claim.branches) || claim.branches.length === 0) {
    // T-144 validation guarantees this. Defensive.
    return { kind: 'denied', reason: 'invalid_token', field: 'branches' };
  }
  if (op.branch === '' && !claim.branches.includes('**')) {
    return {
      kind: 'reauth_required',
      reason: 'missing_branch',
    };
  }
  if (!matchGlobAny(op.branch, claim.branches)) {
    return { kind: 'denied', reason: 'branch_mismatch' };
  }

  // 5. Path matching. deniedPaths > paths (denied wins).
  if (!Array.isArray(claim.paths) || claim.paths.length === 0) {
    return { kind: 'denied', reason: 'invalid_token', field: 'paths' };
  }
  if (op.path === '' && !claim.paths.includes('**')) {
    return {
      kind: 'reauth_required',
      reason: 'missing_path',
    };
  }
  if (matchGlobAny(op.path, claim.deniedPaths)) {
    return { kind: 'denied', reason: 'denied_path_match' };
  }
  if (!matchGlobAny(op.path, claim.paths)) {
    return { kind: 'denied', reason: 'path_mismatch' };
  }

  // 6. AST constraints.
  // Decision: if the token carries AST constraints AND the request does
  // not present any AST coordinates, we fail closed with
  // `missing_ast_coords` (reauth-required). An unconstrained token (no
  // AST fields) plus an unconstrained request is the normal path.
  const hasAstConstraint =
    (Array.isArray(claim.astNodeIds) && claim.astNodeIds.length > 0) ||
    (Array.isArray(claim.astSelectors) && claim.astSelectors.length > 0);
  if (hasAstConstraint) {
    const reqIds = op.astNodeIds ?? [];
    const reqSelectors = op.astSelectors ?? [];
    if (reqIds.length === 0 && reqSelectors.length === 0) {
      return {
        kind: 'reauth_required',
        reason: 'missing_ast_coords',
      };
    }
    // Every requested AST node id must be allowed.
    for (const id of reqIds) {
      if (!Array.isArray(claim.astNodeIds) || !claim.astNodeIds.includes(id)) {
        return { kind: 'denied', reason: 'ast_mismatch', field: id };
      }
    }
    // Every requested selector must be allowed (selectors compared by
    // exact match; glob semantics are not part of the AST claim).
    for (const sel of reqSelectors) {
      if (
        !Array.isArray(claim.astSelectors) ||
        !claim.astSelectors.includes(sel)
      ) {
        return { kind: 'denied', reason: 'ast_mismatch', field: sel };
      }
    }
  }

  return { kind: 'ok' };
}

/**
 * Re-export glob helpers for convenience to other transport-layer files
 * that need branch / path matching against the same semantics.
 */
export { matchGlobAny, matchGlobPattern };
