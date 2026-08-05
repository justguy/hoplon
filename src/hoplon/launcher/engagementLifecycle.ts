/**
 * launcher/engagementLifecycle.ts — engagement-token lifecycle for
 * the folder-scoped policy lane (t-084).
 *
 * Single source of truth for the four lifecycle operations every
 * transport agrees on:
 *
 *   - `verifyEngagementToken` — used by downstream agent-facing entry
 *     points (lit up in t-085) to check that a presented token is live,
 *     un-revoked, unexpired, and bound to the claimed scope.
 *   - `renewEngagementToken` — explicit renewal path. No silent
 *     auto-extension: the caller must call renewal before expiry, and
 *     renewal re-runs handshake resolution so a policy change between
 *     issuance and renewal surfaces as a typed `reauth_required`.
 *   - `revokeEngagementToken` — remove a live binding. Idempotent.
 *   - `pruneExpiredTokens` — drop bindings whose `expiresAtIso` has
 *     passed. Cleanup touches only the engagement store — sessions,
 *     snapshots, and audit state are never mutated here.
 *
 * TTL resolution: we never cache a TTL number of our own. Each renewal
 * re-runs `issueProjectHandshake`, which reads
 * `folderPolicy.engagementTokenTtlMs` from the current project policy
 * (the launcher default is applied at policy load time). There is
 * exactly one TTL source per folder policy, so renewal never races an
 * operator policy change.
 */
import {
  HandshakeError,
  issueProjectHandshake,
} from './handshake.js';
import type {
  HandshakeErrorKind,
  HandshakeResult,
  IssueHandshakeDeps,
} from './handshake.js';
import type { EngagementStore } from './engagementStore.js';
import type {
  AccessMode,
  EngagementTokenBinding,
} from '../concurrency/projectPolicy.js';

/**
 * Scope narrowing expected on a valid token. Every field is optional:
 * callers pass only the fields they are checking. A supplied field
 * that does not match the binding downgrades the result to
 * `scope_mismatch` with the typed `reason`.
 */
export interface VerifyExpectation {
  readonly now: Date;
  readonly projectId?: string;
  readonly folder?: string;
  readonly requiredAccess?: AccessMode;
  readonly principalId?: string | null;
}

export type TokenVerification =
  | { kind: 'valid'; binding: EngagementTokenBinding }
  | { kind: 'missing' }
  | {
      kind: 'expired';
      binding: EngagementTokenBinding;
      nowIso: string;
    }
  | {
      kind: 'scope_mismatch';
      binding: EngagementTokenBinding;
      reason: 'project_id' | 'folder' | 'access' | 'principal';
    };

/**
 * Reason codes forcing a new handshake. Separate from
 * `HandshakeErrorKind` so renewal callers can distinguish
 * lifecycle-local outcomes (`expired`, `missing`) from policy-layer
 * rejections re-propagated from re-running issuance
 * (`policy_denied`, `invalid_folder`, etc.).
 */
export type ReauthReason =
  | 'missing'
  | 'expired'
  | 'unknown_project'
  | 'no_folder_policy'
  | 'invalid_folder'
  | 'policy_denied'
  | 'unknown_principal'
  | 'invalid_request';

export type TokenRenewal =
  | {
      kind: 'renewed';
      result: HandshakeResult;
      previousToken: string;
      binding: EngagementTokenBinding;
    }
  | { kind: 'reauth_required'; reason: ReauthReason };

export type TokenRevocation =
  | { kind: 'revoked'; binding: EngagementTokenBinding }
  | { kind: 'missing' };

export interface CleanupReport {
  readonly removed: number;
}

/**
 * Inspect a presented token against a scope expectation. No mutation,
 * no cleanup — callers that observe `expired` decide whether to prune
 * inline via `pruneExpiredTokens` or leave the binding for the next
 * periodic sweep.
 */
export function verifyEngagementToken(
  store: EngagementStore,
  token: string,
  expectation: VerifyExpectation,
): TokenVerification {
  if (typeof token !== 'string' || token.length === 0) {
    return { kind: 'missing' };
  }
  const binding = store.get(token);
  if (!binding) return { kind: 'missing' };

  const nowMs = expectation.now.getTime();
  if (isExpiredOrMalformed(binding, nowMs)) {
    return {
      kind: 'expired',
      binding,
      nowIso: expectation.now.toISOString(),
    };
  }

  if (
    expectation.projectId !== undefined &&
    expectation.projectId !== binding.projectId
  ) {
    return { kind: 'scope_mismatch', binding, reason: 'project_id' };
  }
  if (
    expectation.folder !== undefined &&
    expectation.folder !== binding.folder
  ) {
    return { kind: 'scope_mismatch', binding, reason: 'folder' };
  }
  if (
    expectation.principalId !== undefined &&
    expectation.principalId !== binding.principalId
  ) {
    return { kind: 'scope_mismatch', binding, reason: 'principal' };
  }
  if (
    expectation.requiredAccess !== undefined &&
    !accessSatisfies(binding.access, expectation.requiredAccess)
  ) {
    return { kind: 'scope_mismatch', binding, reason: 'access' };
  }
  return { kind: 'valid', binding };
}

function accessSatisfies(actual: AccessMode, required: AccessMode): boolean {
  if (required === 'read_only') {
    return actual === 'read_only' || actual === 'read_write';
  }
  if (required === 'read_write') return actual === 'read_write';
  return false;
}

/**
 * Explicit renewal path. When the presented token is live and
 * un-revoked, we re-run the shared handshake resolution against the
 * current folder policy and refresh the binding. When a different token is
 * generated, the new token is written before the old one is deleted. When the
 * handshake itself rejects the re-issue (policy changed, principal removed,
 * etc.) the caller receives a typed `reauth_required`.
 */
export function renewEngagementToken(
  store: EngagementStore,
  token: string,
  deps: IssueHandshakeDeps,
): TokenRenewal {
  if (typeof token !== 'string' || token.length === 0) {
    return { kind: 'reauth_required', reason: 'missing' };
  }
  const binding = store.get(token);
  if (!binding) return { kind: 'reauth_required', reason: 'missing' };

  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  if (isExpiredOrMalformed(binding, now.getTime())) {
    store.delete(token);
    return { kind: 'reauth_required', reason: 'expired' };
  }

  try {
    const result = issueProjectHandshake(
      {
        projectId: binding.projectId,
        folder: binding.folder,
        ...(binding.principalId !== null
          ? { principalId: binding.principalId }
          : {}),
      },
      { ...deps, store },
    );
    const renewedBinding = store.get(result.engagement.token);
    if (!renewedBinding) {
      throw new Error('renewed engagement binding was not persisted');
    }
    if (result.engagement.token !== token) {
      store.delete(token);
    }
    return {
      kind: 'renewed',
      result,
      previousToken: token,
      binding: renewedBinding,
    };
  } catch (err) {
    if (err instanceof HandshakeError) {
      return {
        kind: 'reauth_required',
        reason: reauthReasonFromHandshake(err.kind),
      };
    }
    throw err;
  }
}

function reauthReasonFromHandshake(kind: HandshakeErrorKind): ReauthReason {
  switch (kind) {
    case 'invalid_request':
      return 'invalid_request';
    case 'unknown_project':
      return 'unknown_project';
    case 'no_folder_policy':
      return 'no_folder_policy';
    case 'invalid_folder':
      return 'invalid_folder';
    case 'policy_denied':
      return 'policy_denied';
    case 'unknown_principal':
      return 'unknown_principal';
  }
}

/**
 * Remove a live binding. Returns `missing` when the token is not
 * known so callers can distinguish no-op from effective revocation.
 * Revocation never touches session, snapshot, or audit state — only
 * the engagement store.
 */
export function revokeEngagementToken(
  store: EngagementStore,
  token: string,
): TokenRevocation {
  if (typeof token !== 'string' || token.length === 0) {
    return { kind: 'missing' };
  }
  const binding = store.get(token);
  if (!binding) return { kind: 'missing' };
  store.delete(token);
  return { kind: 'revoked', binding };
}

function isExpiredOrMalformed(
  binding: EngagementTokenBinding,
  nowMs: number,
): boolean {
  const expiresMs = Date.parse(binding.expiresAtIso);
  return !Number.isFinite(expiresMs) || nowMs >= expiresMs;
}

/**
 * Remove every binding whose `expiresAtIso` is at or before `now`.
 * The caller provides the clock; tests drive it deterministically.
 * Cleanup is scoped to the engagement store and never deletes or
 * mutates unrelated session, snapshot, or audit state.
 */
export function pruneExpiredTokens(
  store: EngagementStore,
  now: Date,
): CleanupReport {
  const nowMs = now.getTime();
  const toRemove: string[] = [];
  for (const [token, binding] of store.entries()) {
    if (isExpiredOrMalformed(binding, nowMs)) {
      toRemove.push(token);
    }
  }
  for (const t of toRemove) store.delete(t);
  return { removed: toRemove.length };
}
