/**
 * authorization/staticAuthorizationAdapter.ts — static FolderPolicy
 * compatibility adapter (T-143).
 *
 * Wraps the existing `resolveFolderAccess` + `FolderPolicy` mechanism
 * behind the `AuthorizationAdapter` seam without changing current default
 * behavior. This is the default adapter used until dynamic OPA evaluation
 * is wired in (a later task).
 *
 * Mapping contract:
 *   - FolderPolicy `read_write`  → `allow` with read + search + write + lock
 *     + snapshot capabilities, all paths/branches wildcard.
 *   - FolderPolicy `read_only`   → `allow` with read + search capabilities
 *     only, all paths/branches wildcard.
 *   - FolderPolicy `none`        → `deny`.
 *   - Missing / invalid folder   → `deny` with descriptive reason.
 *
 * Intentional non-inventions:
 *   - Does NOT invent `requires_escalation` or `requires_approval` outcomes;
 *     those are OPA-only outcomes (T-144+). Static policy has no escalation
 *     model.
 *   - Does NOT mint EngagementTokens; that remains in the handshake layer.
 *   - Does NOT carry grantIds, break_glass, or escalation_grant sources;
 *     static policy always uses `standing_policy`.
 *
 * Architecture rules:
 *   - No ambient state. All deps injected via constructor.
 *   - No filesystem, git, network, or clock access.
 *   - Named exports only. ES modules.
 */
import { randomBytes } from 'node:crypto';

import {
  resolveFolderAccess,
} from '../concurrency/projectPolicy.js';
import type {
  AccessMode,
  FolderPolicy,
} from '../concurrency/projectPolicy.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
  ScopeClaim,
  TokenCapabilities,
} from './authorizationAdapter.js';

/** Static policy version string. Stable across process restarts. */
export const STATIC_POLICY_VERSION = 'static-folder-policy-v1';

/**
 * Default TTL in seconds the static adapter falls back to when the
 * folder policy does not declare a positive `engagementTokenTtlMs`
 * value. Kept as a public export so callers / tests have a stable
 * reference, but the runtime authoritative value is derived from the
 * folder policy on every `evaluateAccess` call (see `ttlSecondsFromPolicy`).
 *
 * **TTL ownership (T-146):** the FolderPolicy is the single source of
 * truth for engagement-token TTL. `expiresInSeconds` on every static
 * `allow` decision is derived from `folderPolicy.engagementTokenTtlMs`
 * (rounded down to whole seconds, with a positive minimum of 1) so that
 * downstream handshake minting paths can treat the adapter's
 * `expiresInSeconds` as authoritative without a second TTL lookup.
 */
export const STATIC_POLICY_EXPIRES_IN_SECONDS = 3600;

/** Wildcard scope claim: all paths, all branches. */
function wildcardScopeClaim(): ScopeClaim {
  return { paths: ['**'], branches: ['**'] };
}

/**
 * Build `TokenCapabilities` from an `AccessMode`.
 *
 * `read_write` → read + search + write + lock + snapshot (all wildcard).
 * `read_only`  → read + search (all wildcard).
 * `none`       → empty object (should not reach this path; deny short-circuits).
 */
function capabilitiesFromAccessMode(access: AccessMode): TokenCapabilities {
  if (access === 'read_write') {
    const claim = wildcardScopeClaim();
    return {
      read: claim,
      search: claim,
      write: claim,
      lock: claim,
      snapshot: claim,
    };
  }
  if (access === 'read_only') {
    const claim = wildcardScopeClaim();
    return { read: claim, search: claim };
  }
  // access === 'none' — caller should not reach this; deny is returned earlier.
  return {};
}

/**
 * Generate a short opaque decision ID. Not cryptographically significant;
 * used for audit log correlation only.
 */
function generateDecisionId(): string {
  return 'static-' + randomBytes(8).toString('hex');
}

/**
 * Dependencies required by `StaticAuthorizationAdapter`. All fields are
 * injected; the adapter must not reach outside this interface.
 */
export interface StaticAuthorizationAdapterDeps {
  /** The folder policy to evaluate requests against. */
  readonly folderPolicy: FolderPolicy;
  /** Optional override for decision ID generation; useful in tests. */
  readonly generateDecisionId?: () => string;
}

/**
 * Static authorization adapter. Evaluates a `HoplonAuthorizationRequest`
 * against a fixed `FolderPolicy` and returns a typed
 * `HoplonAuthorizationDecision` without making any external calls.
 *
 * This is the default compatibility adapter. It preserves existing allow /
 * deny / reauth semantics without inventing escalation grants.
 */
export class StaticAuthorizationAdapter implements AuthorizationAdapter {
  private readonly deps: Required<StaticAuthorizationAdapterDeps>;

  constructor(deps: StaticAuthorizationAdapterDeps) {
    this.deps = {
      ...deps,
      generateDecisionId: deps.generateDecisionId ?? generateDecisionId,
    };
  }

  /**
   * Evaluate a Hoplon authorization request against the static folder
   * policy. Returns a resolved `Promise` — the interface is async to match
   * `AuthorizationAdapter` so callers need not branch on adapter type.
   *
   * Evaluation logic:
   *   1. Validate that the request has the minimum required fields.
   *   2. Resolve the folder from `request.request.paths[0]` or project root.
   *   3. Call `resolveFolderAccess` with the folderPolicy.
   *   4. Map the result to a `HoplonAuthorizationDecision`.
   */
  evaluateAccess(
    request: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision> {
    const decisionId = this.deps.generateDecisionId();

    // Basic request validation.
    if (
      typeof request.principal?.id !== 'string' ||
      request.principal.id.length === 0
    ) {
      return Promise.resolve({
        outcome: 'deny',
        reason: 'Request is missing a valid principal id',
        decisionId,
        policyVersion: STATIC_POLICY_VERSION,
      });
    }

    if (
      typeof request.request?.projectId !== 'string' ||
      request.request.projectId.length === 0
    ) {
      return Promise.resolve({
        outcome: 'deny',
        reason: 'Request is missing a valid projectId',
        decisionId,
        policyVersion: STATIC_POLICY_VERSION,
      });
    }

    // Derive the folder to evaluate from the first explicit path, or fall
    // back to the project root (empty string).
    const firstPath = request.request.paths?.[0] ?? '';

    // Validation pass: run the raw path through resolveFolderAccess first
    // so that obviously-invalid inputs (absolute paths, backslashes, etc.)
    // are rejected before folder extraction. If the raw path itself is
    // invalid, we surface the rejection directly.
    const rawResolution = resolveFolderAccess(
      this.deps.folderPolicy,
      firstPath,
      request.principal.id,
    );
    if (rawResolution.kind === 'invalid_folder') {
      return Promise.resolve({
        outcome: 'deny',
        reason: `Invalid folder path '${firstPath}': ${rawResolution.reason}`,
        decisionId,
        policyVersion: STATIC_POLICY_VERSION,
      });
    }

    // Path is structurally valid. Now extract the top-level folder for rule
    // matching — FolderPolicy rules are folder-prefix-based, not file-based.
    const folder = extractFolder(firstPath);

    const resolution = resolveFolderAccess(
      this.deps.folderPolicy,
      folder,
      request.principal.id,
    );

    if (resolution.kind === 'invalid_folder') {
      return Promise.resolve({
        outcome: 'deny',
        reason: `Invalid folder path '${folder}': ${resolution.reason}`,
        decisionId,
        policyVersion: STATIC_POLICY_VERSION,
      });
    }

    if (resolution.access === 'none') {
      return Promise.resolve({
        outcome: 'deny',
        reason: `Access denied for folder '${resolution.canonicalFolder}' by static policy`,
        decisionId,
        policyVersion: STATIC_POLICY_VERSION,
      });
    }

    const capabilities = capabilitiesFromAccessMode(resolution.access);

    const decision: HoplonAuthorizationDecision = {
      outcome: 'allow',
      source: 'standing_policy',
      capabilities,
      expiresInSeconds: ttlSecondsFromPolicy(this.deps.folderPolicy),
      decisionId,
      policyVersion: STATIC_POLICY_VERSION,
    };
    return Promise.resolve(decision);
  }
}

/**
 * Derive `expiresInSeconds` from the folder policy's
 * `engagementTokenTtlMs`. The contract requires a positive integer in
 * seconds (T-145 normalization rejects `<= 0` for OPA), so we floor the
 * conversion and clamp to a minimum of 1 second when the policy declares
 * a sub-second TTL. When the policy field is missing or malformed we
 * fall back to {@link STATIC_POLICY_EXPIRES_IN_SECONDS}.
 *
 * `FolderPolicy.engagementTokenTtlMs` is policy-global (not per-rule)
 * per `projectPolicy.ts`, so static-adapter TTL precedence matches the
 * existing folder-policy precedence: there is one TTL per registered
 * project policy.
 */
function ttlSecondsFromPolicy(folderPolicy: FolderPolicy): number {
  const ttlMs = folderPolicy.engagementTokenTtlMs;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return STATIC_POLICY_EXPIRES_IN_SECONDS;
  }
  const seconds = Math.floor(ttlMs / 1000);
  return seconds > 0 ? seconds : 1;
}

/**
 * Extract a project-relative folder from a file path for policy evaluation.
 * Takes the first non-empty path segment or returns empty string for the
 * project root. The result is passed to `resolveFolderAccess` as-is; that
 * function handles further canonicalization and rejects invalid shapes.
 *
 * Examples:
 *   'src/hoplon/launcher/handshake.ts' → 'src'
 *   'docs/arch.md'                     → 'docs'
 *   ''                                 → ''
 *   'secrets/**'                       → 'secrets'
 */
function extractFolder(filePath: string): string {
  if (filePath === '') return '';
  const firstSlash = filePath.indexOf('/');
  if (firstSlash === -1) {
    // Single segment with no directory — use as-is (it could be a file
    // at project root or a folder name; resolveFolderAccess handles it).
    return filePath;
  }
  return filePath.slice(0, firstSlash);
}
