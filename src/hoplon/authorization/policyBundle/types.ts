/**
 * authorization/policyBundle/types.ts — typed shape of the Hoplon OPA
 * policy data bundle (T-149).
 *
 * STATUS: ADVISORY / FIXTURE-ONLY.
 *
 *   These types model the JSON document at
 *   `policy/data/hoplon_policy_data.json`. They are consumed by the
 *   in-process `policyEvaluator` (Strategy A) which mirrors the
 *   semantics of `policy/hoplon_authz.rego` for hermetic tests.
 *
 *   The production bundle is delivered to an OPA sidecar externally
 *   (Agentic OS / GitOps publisher); Hoplon does not load this JSON at
 *   runtime in the default flow. See `policy/README.md`.
 *
 * Architecture rules:
 *   - Pure types. No I/O, no clock, no randomness.
 *   - Named exports only. TypeScript strict. No `any`.
 */

/** Disposition for a single capability under a project default. */
export type ProjectCapabilityDisposition =
  | 'allow'
  | 'requires_escalation';

/** Disposition for a single capability under a branch override. */
export type BranchCapabilityDisposition =
  | 'allow'
  | 'requires_escalation'
  | 'requires_human_approval';

/** Disposition for a single capability when a sensitive path is touched. */
export type SensitivePathCapabilityDisposition =
  | 'requires_security_approval'
  | 'deny';

/**
 * Per-project default capability dispositions and token shape.
 *
 * Every key listed in `BUNDLE_CAPABILITY_KEYS` (the single source of
 * truth for "capabilities the bundle understands") MUST be present here
 * — including `snapshot`. The loader rejects projects that omit any of
 * them so the evaluator cannot silently fall through to a default.
 */
export type PolicyProject = {
  default: {
    read: ProjectCapabilityDisposition;
    search: ProjectCapabilityDisposition;
    write: ProjectCapabilityDisposition;
    lock: ProjectCapabilityDisposition;
    snapshot: ProjectCapabilityDisposition;
  };
  token: { maxTtlSeconds: number };
};

/** Per-branch override (keyed by exact branch or single-segment glob). */
export type PolicyBranchRule = Partial<{
  read: BranchCapabilityDisposition;
  search: BranchCapabilityDisposition;
  write: BranchCapabilityDisposition;
  lock: BranchCapabilityDisposition;
  snapshot: BranchCapabilityDisposition;
}>;

/** A sensitive-path entry. The pattern is a glob (e.g. `secrets/**`, `.env*`). */
export type PolicySensitivePath = {
  pattern: string;
} & Partial<{
  read: SensitivePathCapabilityDisposition;
  search: SensitivePathCapabilityDisposition;
  write: SensitivePathCapabilityDisposition;
  lock: SensitivePathCapabilityDisposition;
  snapshot: SensitivePathCapabilityDisposition;
}>;

/**
 * A "global hard deny" entry. The match contract is intentionally
 * minimal: a deny matches when EVERY non-undefined field equals the
 * corresponding field of the request. An empty entry would match
 * everything; loaders reject empty entries.
 */
export type PolicyGlobalDeny = {
  projectId?: string;
  principalId?: string;
  capability?: 'read' | 'search' | 'write' | 'lock' | 'snapshot';
  pathPattern?: string;
  reason?: string;
};

/** Top-level policy data document (matches `hoplon_policy_data.json`). */
export type PolicyData = {
  policyVersion: string;
  defaultExpiresInSeconds: number;
  grantExpiresInSeconds: number;
  projects: Record<string, PolicyProject>;
  branches: Record<string, Record<string, PolicyBranchRule>>;
  sensitivePaths: PolicySensitivePath[];
  globalDenies: PolicyGlobalDeny[];
  /**
   * Grant ids that have been administratively revoked. Active grants
   * with these ids are filtered out before any matching logic runs.
   */
  revokedGrantIds: string[];
};
