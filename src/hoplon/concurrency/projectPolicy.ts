/**
 * concurrency/projectPolicy.ts — folder-scoped project policy contract
 * for the agent handshake lane (t-082).
 *
 * This module owns the **types, the canonicalizer, and the resolver**
 * for the folder-scoped policy surface that sits on top of the
 * registered-project boundary (t-080). Validation machinery (normalizing
 * rules, rejecting duplicates, validating principals) lives in the
 * sibling `projectPolicyValidation.ts` so each file stays well under
 * the 300-line cap.
 *
 * Design choices settled here:
 *
 *   1. Access mode is an explicit 3-value enum — `read_only`,
 *      `read_write`, `none`. There is no implicit allow or deny. A
 *      folder with no matching rule returns the policy's
 *      `defaultAccess` — which is itself required and explicit.
 *
 *   2. Folder matching is a **canonical project-relative string match**.
 *      The caller-supplied folder is canonicalized without touching
 *      the filesystem. Absolute paths, Windows drive letters,
 *      backslashes, `..` segments, `.` segments, and empty segments
 *      are all refused before a rule is ever consulted. Symlink and
 *      realpath containment checks are runtime-level concerns owned
 *      by the handshake caller before a token is issued — out of
 *      scope for this pure resolver by design.
 *
 *   3. Rule precedence is "most specific folder wins, principal-
 *      specific beats principal-agnostic". Duplicate `(folder,
 *      principalSet)` pairs are rejected at validation time rather
 *      than resolved by an arbitrary index-tie-break so policy-
 *      authoring errors surface as typed validation failures.
 *
 *   4. One engagement-token binding shape exists for every transport.
 *      Transports issue opaque tokens; they never invent per-transport
 *      hash semantics. Issuance / verification live in t-083 — this
 *      module defines only the binding + agent-facing envelope shapes
 *      so every transport agrees.
 *
 *   5. `engagementTokenTtlMs` is required on every folder policy and
 *      bounded to `[MIN_ENGAGEMENT_TOKEN_TTL_MS,
 *      MAX_ENGAGEMENT_TOKEN_TTL_MS]`. There is no implicit "forever"
 *      default; the launcher supplies a fallback at registration time
 *      when the operator did not set one.
 */

/** Access mode resolved for a principal over a canonical folder. */
export type AccessMode = 'read_only' | 'read_write' | 'none';

/** Explicit principal classes the policy can distinguish between. */
export type PrincipalKind = 'agent' | 'operator' | 'service';

/** Minimum engagement-token TTL accepted by the contract. */
export const MIN_ENGAGEMENT_TOKEN_TTL_MS = 60_000;
/** Maximum engagement-token TTL accepted by the contract. */
export const MAX_ENGAGEMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const ACCESS_MODES = Object.freeze([
  'read_only',
  'read_write',
  'none',
] as const satisfies readonly AccessMode[]);
export const PRINCIPAL_KINDS = Object.freeze([
  'agent',
  'operator',
  'service',
] as const satisfies readonly PrincipalKind[]);

/**
 * A principal known to the policy surface. Identity values are opaque
 * strings; `label` is operator-visible only and must never leak to
 * agent-facing summaries.
 */
export interface PolicyPrincipal {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly label?: string;
}

/**
 * A folder-scoped access rule. `folder` is canonical project-relative
 * POSIX (the empty string is the project root). `appliesToPrincipalIds`,
 * when present, restricts the rule to the listed principal ids; when
 * absent the rule applies to every principal.
 */
export interface FolderRule {
  readonly folder: string;
  readonly access: AccessMode;
  readonly appliesToPrincipalIds?: readonly string[];
}

/**
 * The folder-scoped policy for a registered project. Carried inside
 * `ProjectPolicy.folderPolicy`. When `folderPolicy` is absent on a
 * registered project, that project has no opinion on the folder-scoped
 * handshake surface — handshake behavior is decided by t-083 (likely
 * a launcher-wide default).
 */
export interface FolderPolicy {
  readonly defaultAccess: AccessMode;
  readonly folderRules: readonly FolderRule[];
  readonly engagementTokenTtlMs: number;
  readonly principals?: readonly PolicyPrincipal[];
}

/**
 * Server-side binding record for an issued engagement token. One shape
 * for every transport. `nonce` is server-private; it is never echoed to
 * the agent and never appears in operator-visible summaries.
 *
 * Issuance / verification live in t-083; this module defines only the
 * shape so every transport agrees.
 */
export interface EngagementTokenBinding {
  readonly projectId: string;
  readonly folder: string;
  readonly access: AccessMode;
  readonly principalId: string | null;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly nonce: string;
}

/**
 * Agent-facing envelope carrying an opaque engagement token plus the
 * non-secret subset of its binding. Fields match the binding exactly
 * except for the excluded `nonce`, so agents can echo the envelope
 * back without re-deriving anything.
 */
export interface EngagementTokenEnvelope {
  readonly token: string;
  readonly projectId: string;
  readonly folder: string;
  readonly access: AccessMode;
  readonly principalId: string | null;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
}

/** Structured reason a folder value could not be canonicalized. */
export type InvalidFolderReason =
  | 'not_a_string'
  | 'absolute_path'
  | 'windows_drive'
  | 'backslash'
  | 'dot_segment'
  | 'parent_segment'
  | 'empty_segment';

/** Discriminated result of `resolveFolderAccess`. */
export type FolderPolicyResolution =
  | {
      readonly kind: 'matched';
      readonly access: AccessMode;
      readonly canonicalFolder: string;
      readonly matchedRuleIndex: number;
      readonly matchedRuleFolder: string;
    }
  | {
      readonly kind: 'default_fallback';
      readonly access: AccessMode;
      readonly canonicalFolder: string;
    }
  | {
      readonly kind: 'invalid_folder';
      readonly reason: InvalidFolderReason;
    };

export type FolderPolicyErrorKind =
  | 'invalid_mode'
  | 'invalid_folder'
  | 'invalid_rule'
  | 'duplicate_rule'
  | 'invalid_ttl'
  | 'invalid_principal'
  | 'unknown_principal_ref';

export class FolderPolicyError extends Error {
  public readonly kind: FolderPolicyErrorKind;

  constructor(kind: FolderPolicyErrorKind, message: string) {
    super(message);
    this.name = 'FolderPolicyError';
    this.kind = kind;
  }
}

/**
 * Canonicalize a project-relative folder string into the form used by
 * folder rules. Returns the reason the input was rejected when it fails
 * any of the path-safety predicates instead of throwing — callers can
 * surface the structured reason.
 *
 * Accepted input shapes:
 *   - ''             → project root
 *   - 'src'          → 'src'
 *   - 'src/hoplon/'  → 'src/hoplon'
 *   - '/src/hoplon'  → rejected (absolute)
 *   - '..'           → rejected (parent segment)
 *   - 'src//hoplon'  → rejected (empty segment)
 *   - 'src\\hoplon'  → rejected (backslash)
 *   - 'C:\\src'      → rejected (windows drive)
 */
export function canonicalizeProjectRelativeFolder(
  raw: unknown,
): { ok: true; canonical: string } | { ok: false; reason: InvalidFolderReason } {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  if (raw.includes('\\')) return { ok: false, reason: 'backslash' };
  if (/^[a-zA-Z]:[/]/.test(raw)) return { ok: false, reason: 'windows_drive' };
  if (raw.startsWith('/')) return { ok: false, reason: 'absolute_path' };

  let trimmed = raw;
  if (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  if (trimmed.endsWith('/')) return { ok: false, reason: 'empty_segment' };
  if (trimmed === '') return { ok: true, canonical: '' };

  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '') return { ok: false, reason: 'empty_segment' };
    if (seg === '.') return { ok: false, reason: 'dot_segment' };
    if (seg === '..') return { ok: false, reason: 'parent_segment' };
  }
  return { ok: true, canonical: segments.join('/') };
}

/**
 * Resolve the access mode for a principal requesting a folder within a
 * project. Pure: no filesystem lookup, no realpath, no symlink
 * resolution — the caller is responsible for validating symlink and
 * realpath containment against the project's fsRoot before trusting the
 * result. Returns a discriminated resolution so callers can distinguish
 * "no rule matched, fell back to default" from "invalid folder input"
 * from "a rule matched".
 */
export function resolveFolderAccess(
  policy: FolderPolicy,
  folder: unknown,
  principalId?: string,
): FolderPolicyResolution {
  const canon = canonicalizeProjectRelativeFolder(folder);
  if (!canon.ok) return { kind: 'invalid_folder', reason: canon.reason };

  const canonical = canon.canonical;
  type Candidate = {
    index: number;
    rule: FolderRule;
    specificity: number;
    principalSpecific: boolean;
  };
  const candidates: Candidate[] = [];
  for (let i = 0; i < policy.folderRules.length; i++) {
    const r = policy.folderRules[i]!;
    if (!folderRuleCovers(r.folder, canonical)) continue;
    if (r.appliesToPrincipalIds !== undefined) {
      if (principalId === undefined) continue;
      if (!r.appliesToPrincipalIds.includes(principalId)) continue;
    }
    candidates.push({
      index: i,
      rule: r,
      specificity: r.folder.length,
      principalSpecific: r.appliesToPrincipalIds !== undefined,
    });
  }
  if (candidates.length === 0) {
    return {
      kind: 'default_fallback',
      access: policy.defaultAccess,
      canonicalFolder: canonical,
    };
  }

  candidates.sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    if (a.principalSpecific !== b.principalSpecific) {
      return a.principalSpecific ? -1 : 1;
    }
    return a.index - b.index;
  });
  const top = candidates[0]!;
  return {
    kind: 'matched',
    access: top.rule.access,
    canonicalFolder: canonical,
    matchedRuleIndex: top.index,
    matchedRuleFolder: top.rule.folder,
  };
}

function folderRuleCovers(ruleFolder: string, canonical: string): boolean {
  if (ruleFolder === '') return true;
  if (ruleFolder === canonical) return true;
  return canonical.startsWith(ruleFolder + '/');
}
