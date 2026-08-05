/**
 * contracts/policyAudit.ts — PolicyAuditEvent schema and typed reason codes.
 *
 * Additive extension of the `hoplon_audit_log` mechanism for the t-088
 * folder-scoped policy lane. Every policy handshake attempt and every
 * policy-gated agent access request serializes into a `PolicyAuditEvent`
 * that is attached to an `AuditLogRecord` via the `policyEvent` column.
 *
 * ## t-148 evidence fields
 *
 * The schema is additively extended with the dynamic-authz evidence
 * fields required by the t-148 audit DoD:
 *   - `policyEngine`     — adapter/engine that produced the decision.
 *   - `decisionId`       — adapter-stable decision identifier.
 *   - `policyVersion`    — policy bundle version active at decision time.
 *   - `tokenId`          — capability-token id for op-level rows; the
 *                           random hex from `CapabilityEngagementToken`,
 *                           NEVER the raw bearer bytes.
 *   - `issuedTokenId`    — capability-token id for handshake-allow rows.
 *   - `capability`       — capability key on op-level rows (`read`,
 *                           `search`, `write`, `lock`, `snapshot`).
 *   - `branch` / `paths` — capability-scoped scope claim on the row.
 *   - `grantIds`         — escalation-grant ids when source is
 *                           `escalation_grant`.
 *   - `astNodeIds` /
 *     `astSelectors`     — AST coords on op-level rows that touch them.
 *   - `truncated`        — bounded-redaction flag.
 *
 * All new fields are optional / nullable so legacy t-088 rows remain
 * readable without migration.
 *
 * ## H13 enforcement (content-free logs)
 *
 * The event never carries:
 *   - raw engagement token values or token hashes
 *   - secret patterns, credential material, or file contents
 *   - full folder-rule bodies (matched rule bodies are referenced by the
 *     canonical folder only, never by the rule payload)
 *
 * `engagementId` is the server-private binding `nonce` (random bytes issued
 * at handshake and never returned in the envelope). It is safe to persist
 * because it does not unlock anything on its own; it is only useful as a
 * correlation handle joining handshake and subsequent access-check rows.
 *
 * ## Typed reason codes
 *
 * Consumers MUST NOT reconstruct typed reason codes from formatted messages.
 * The `reasonCode` closed union is the authoritative classification.
 */

import { z } from 'zod';
import { RbaaPolicyAuditEvidenceSchema } from './rbaaAuthorization.js';

// ---------------------------------------------------------------------------
// Bounded-redaction caps (t-148). Documented in the t-148 report.
// ---------------------------------------------------------------------------

/** Max number of paths persisted per row (incl. truncation marker). */
export const POLICY_AUDIT_MAX_PATHS = 32;
/** Max chars per path entry; longer paths are truncated. */
export const POLICY_AUDIT_MAX_PATH_LENGTH = 1024;
/** Max number of grant ids persisted per row. */
export const POLICY_AUDIT_MAX_GRANT_IDS = 16;
/** Max number of AST node ids / selectors persisted per row. */
export const POLICY_AUDIT_MAX_AST_ENTRIES = 16;
/** Max chars for the canonical branch string. */
export const POLICY_AUDIT_MAX_BRANCH_LENGTH = 256;
/** Max chars for a free-form `detail` field (agent reasons / errors). */
export const POLICY_AUDIT_MAX_DETAIL_LENGTH = 256;
/** Marker placed where a value was dropped or truncated. */
export const POLICY_AUDIT_TRUNCATION_MARKER = '__truncated__';

// ---------------------------------------------------------------------------
// Requested-action closed union
// ---------------------------------------------------------------------------

/**
 * The agent-facing action the audit entry describes.
 *
 * `handshake` / `renew` / `revoke` are policy-lifecycle verbs; `read`,
 * `search`, `edit`, `write`, `lock`, `snapshot` are the gated agent-facing
 * entry points. The closed union lets operator and programmatic consumers
 * filter without string parsing.
 */
export const PolicyAuditActionSchema = z.enum([
  'handshake',
  'renew',
  'revoke',
  'read',
  'search',
  'edit',
  'write',
  'lock',
  'snapshot',
]);
export type PolicyAuditAction = z.infer<typeof PolicyAuditActionSchema>;

// ---------------------------------------------------------------------------
// Access-mode closed union (mirrors projectPolicy.AccessMode)
// ---------------------------------------------------------------------------

export const PolicyAuditAccessSchema = z.enum([
  'read_only',
  'read_write',
  'none',
]);
export type PolicyAuditAccess = z.infer<typeof PolicyAuditAccessSchema>;

// ---------------------------------------------------------------------------
// Engine + capability closed unions (t-148)
// ---------------------------------------------------------------------------

export const PolicyAuditEngineSchema = z.enum(['static', 'opa', 'unknown']);
export type PolicyAuditEngine = z.infer<typeof PolicyAuditEngineSchema>;

export const PolicyAuditCapabilitySchema = z.enum([
  'read',
  'search',
  'write',
  'lock',
  'snapshot',
]);
export type PolicyAuditCapability = z.infer<typeof PolicyAuditCapabilitySchema>;

// ---------------------------------------------------------------------------
// Reason-code closed union
// ---------------------------------------------------------------------------

/**
 * Reason-code closed union. Every handshake outcome, every access-check
 * outcome, every renewal outcome, every revocation outcome, every dynamic-
 * authz outcome, and every capability-gate outcome maps to exactly one code.
 *
 * H13 note: codes never name rule bodies or principals — they classify
 * the decision shape, not its content.
 */
export const PolicyAuditReasonSchema = z.enum([
  // Handshake (POLICY_HANDSHAKE) — legacy t-088 set
  'handshake_granted',
  'handshake_invalid_request',
  'handshake_unknown_project',
  'handshake_no_folder_policy',
  'handshake_invalid_folder',
  'handshake_policy_denied',
  'handshake_unknown_principal',

  // Handshake (POLICY_HANDSHAKE) — t-148 dynamic-authz additions
  'handshake_requires_escalation',
  'handshake_requires_approval',
  'handshake_adapter_error',
  'handshake_adapter_invalid_expires',
  'handshake_adapter_empty_capabilities',
  'handshake_adapter_invalid_decision',
  'handshake_mint_error',

  // Access check (POLICY_ACCESS_CHECK) — legacy t-088 set
  'access_granted',
  'access_missing_token',
  'access_expired_token',
  'access_scope_mismatch_project',
  'access_scope_mismatch_folder',
  'access_scope_mismatch_access',
  'access_scope_mismatch_principal',

  // Capability gate (POLICY_CAPABILITY_CHECK) — t-148
  'capability_granted',
  'capability_denied_capability_missing',
  'capability_denied_project_mismatch',
  'capability_denied_session_mismatch',
  'capability_denied_task_mismatch',
  'capability_denied_principal_mismatch',
  'capability_denied_branch_mismatch',
  'capability_denied_path_mismatch',
  'capability_denied_denied_path_match',
  'capability_denied_ast_mismatch',
  'capability_denied_invalid_token',
  'capability_denied_token_revoked',
  'capability_denied_grant_revoked',
  'capability_denied_token_quarantined',
  'capability_reauth_token_expired',
  'capability_reauth_invalid_token',
  'capability_reauth_missing_branch',
  'capability_reauth_missing_path',
  'capability_reauth_missing_ast_coords',
  'capability_reauth_missing_runtime_state',
  'capability_reauth_operation_limit_exceeded',
  'capability_reauth_file_touch_limit_exceeded',

  // Renewal (POLICY_RENEW)
  'renew_granted',
  'renew_reauth_missing',
  'renew_reauth_expired',
  'renew_reauth_invalid_request',
  'renew_reauth_unknown_project',
  'renew_reauth_no_folder_policy',
  'renew_reauth_invalid_folder',
  'renew_reauth_policy_denied',
  'renew_reauth_unknown_principal',

  // Revocation (POLICY_REVOKE)
  'revoke_completed',
  'revoke_missing_token',
]);
export type PolicyAuditReason = z.infer<typeof PolicyAuditReasonSchema>;

// ---------------------------------------------------------------------------
// PolicyAuditEvent — inner envelope persisted in AuditLogRecord.policyEvent
// ---------------------------------------------------------------------------

export const PolicyAuditEventSchema = z.object({
  /** Typed reason code. Stable across transports. */
  reasonCode: PolicyAuditReasonSchema,

  /** The agent-facing action the audit entry describes. */
  requestedAction: PolicyAuditActionSchema,

  /**
   * Canonical project-relative folder the request targets.
   *
   * Null when the request never reached canonicalization (e.g.
   * `handshake_invalid_request` before folder parsing, or
   * `handshake_unknown_project`). Never the raw input bytes — only the
   * canonical string produced by `canonicalizeProjectRelativeFolder`.
   */
  folder: z.string().nullable(),

  /** Declared principal, or null for principal-agnostic requests. */
  principalId: z.string().nullable(),

  /**
   * Resolved access mode (`read_only | read_write | none`).
   *
   * Null on paths that never resolve to an access decision (e.g.
   * `handshake_invalid_request`, `access_missing_token`).
   */
  resolvedAccess: PolicyAuditAccessSchema.nullable(),

  /**
   * Server-private engagement correlation id — the binding `nonce`, not
   * the token. Null when no binding exists on this path (denial before
   * issuance, missing-token access check, etc.).
   *
   * H13: this value does NOT grant access. It is purely a join key.
   */
  engagementId: z.string().nullable(),

  /**
   * Machine-diagnostic detail. Intended for operator visibility, never
   * as a substitute for `reasonCode`. Bounded by `POLICY_AUDIT_MAX_DETAIL_LENGTH`.
   * Null when no additional detail is useful.
   */
  detail: z.string().nullable(),

  // ---- t-148 evidence fields (all optional + nullable for back-compat) ----

  /** Adapter/engine that produced the decision. */
  policyEngine: PolicyAuditEngineSchema.nullable().optional(),
  /** Adapter-stable decision id. */
  decisionId: z.string().nullable().optional(),
  /** Policy bundle / source version active at decision time. */
  policyVersion: z.string().nullable().optional(),
  /**
   * Capability-token id on op-level rows.
   *
   * **Critical H13 invariant:** this is the random hex `tokenId` field of
   * `CapabilityEngagementToken`, NEVER the raw bearer-token bytes
   * (`capabilityToken.token`).
   */
  tokenId: z.string().nullable().optional(),
  /** Capability-token id on handshake-allow rows. Same source as `tokenId`. */
  issuedTokenId: z.string().nullable().optional(),
  /** Capability key on op-level rows; null on handshake/lifecycle rows. */
  capability: PolicyAuditCapabilitySchema.nullable().optional(),
  /** Capability-scoped branch (bounded). */
  branch: z.string().nullable().optional(),
  /** Capability-scoped paths (bounded; truncation marker on overflow). */
  paths: z.array(z.string()).nullable().optional(),
  /** Escalation grant ids when source is `escalation_grant`. */
  grantIds: z.array(z.string()).nullable().optional(),
  /** AST node ids targeted by the operation. */
  astNodeIds: z.array(z.string()).nullable().optional(),
  /** AST selectors targeted by the operation. */
  astSelectors: z.array(z.string()).nullable().optional(),
  /** Set when any bounded array / string was truncated to fit caps. */
  truncated: z.boolean().optional(),
  /** Redacted Dynamic RBAA decision/risk/limit evidence, when present. */
  rbaaEvidence: RbaaPolicyAuditEvidenceSchema.nullable().optional(),
});
export type PolicyAuditEvent = z.infer<typeof PolicyAuditEventSchema>;
