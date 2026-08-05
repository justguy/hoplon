/**
 * contracts/policyAuditQuery.ts — t-089 bounded read-only query contract
 * for the policy audit trail recorded by t-088.
 *
 * One contract, three surfaces. The same `PolicyAuditQueryRequest` /
 * `PolicyAuditQueryResponse` pair is consumed by:
 *   - the launcher/programmatic helper (`launcher/policyAuditQuery.ts`)
 *   - the HTTP route          (`/projects/policy/audit`)
 *   - the MCP tool             (`projects_policy_audit`)
 *
 * Surface drift is impossible because every transport calls the same
 * shared launcher function, which validates input through this schema
 * and projects rows through `summarizePolicyAuditRows`.
 *
 * ## Design conditions (t-089 product/architecture sign-off)
 *
 * - **Bounded by construction.** `limit` is a required-with-default
 *   integer in `[1, 200]`. There is no unscoped whole-table dump. The
 *   default of 50 and hard max of 200 are explicit product bounds, not
 *   implementation choices.
 * - **Read-only evidence access.** Nothing on this surface is part of
 *   an access-control gate; callers may not derive grant/deny from a
 *   query response.
 * - **Content-safe by construction.** `PolicyAuditEntry` excludes raw
 *   engagement tokens, engagement hashes, secret patterns, full rule
 *   bodies, and the server-private engagement binding nonce
 *   (`engagementId` from the t-088 event). Cross-system correlation
 *   uses `correlationId` (already H13-safe).
 * - **Discriminated principal filter.** `principal` is a tagged union
 *   so an "any" filter cannot be confused with a "principal-agnostic"
 *   row filter; HTTP query parsing must produce one of the three
 *   explicit shapes. No string overloading like `principal=any` doubling
 *   as a literal id.
 * - **Validated time window.** `since` and `until` are ISO 8601 UTC
 *   timestamps. When both are present the schema enforces
 *   `since <= until`. Invalid timestamps and inverted windows fail at
 *   the contract layer.
 * - **Deterministic order.** Adapters MUST return rows in
 *   `createdAt DESC, id DESC` order. The contract documents this so
 *   callers can rely on it for paging by time window.
 */

import { z } from 'zod';
import {
  PolicyAuditAccessSchema,
  PolicyAuditActionSchema,
  PolicyAuditReasonSchema,
} from './policyAudit.js';

// ---------------------------------------------------------------------------
// PolicyAuditEntry — the content-safe shape returned to all surfaces.
//
// Mirrors the t-086 `PolicyAuditOperatorSummary` (which already excludes the
// server-private `engagementId`). Promoted to contracts so HTTP, MCP, and
// the launcher consume one canonical shape. Every field carries audit
// significance per the t-089 DoD: id, createdAtIso, correlationId,
// requestedAction, resolvedAccess, outcome, and reasonCode are all
// preserved.
// ---------------------------------------------------------------------------

export const PolicyAuditOperationSchema = z.enum([
  'POLICY_HANDSHAKE',
  'POLICY_ACCESS_CHECK',
  'POLICY_RENEW',
  'POLICY_REVOKE',
]);
export type PolicyAuditOperation = z.infer<typeof PolicyAuditOperationSchema>;

export const PolicyAuditOutcomeSchema = z.enum([
  'GRANTED',
  'DENIED',
  'REAUTH_REQUIRED',
  'REVOKED',
]);
export type PolicyAuditOutcome = z.infer<typeof PolicyAuditOutcomeSchema>;

const UtcIsoTimestampSchema = z.string().datetime({ offset: false });

export const PolicyAuditEntrySchema = z.object({
  /** Audit row UUID — stable identifier. */
  id: z.string().min(1),
  /** ISO 8601 UTC timestamp of the audit decision. */
  createdAtIso: UtcIsoTimestampSchema,
  /** Project scope. */
  projectId: z.string().min(1),
  /** Run scope (per-call when no upstream runId is supplied). */
  runId: z.string().min(1),
  /** Snapshot the decision was bound to, or null when not bound. */
  snapshotId: z.string().nullable(),
  /** Stable cross-system trace handle (NOT the engagement nonce). */
  correlationId: z.string().min(1),
  /** Which policy gate produced this row. */
  operation: PolicyAuditOperationSchema,
  /** Coarse outcome (GRANTED/DENIED/REAUTH_REQUIRED/REVOKED). */
  outcome: PolicyAuditOutcomeSchema,
  /** Typed reason code — stable across transports. */
  reasonCode: PolicyAuditReasonSchema,
  /** Agent-facing action the audit entry describes. */
  requestedAction: PolicyAuditActionSchema,
  /** Canonical project-relative folder, or null when none was resolved. */
  folder: z.string().nullable(),
  /** Declared principal, or null for principal-agnostic requests. */
  principalId: z.string().nullable(),
  /** Resolved access mode at decision time, or null. */
  resolvedAccess: PolicyAuditAccessSchema.nullable(),
  /**
   * Machine-diagnostic detail emitted by the t-088 mapper. Operator-
   * visible by design — never raw user-input bytes (the mapper strips
   * those at write time).
   */
  detail: z.string().nullable(),
});
export type PolicyAuditEntry = z.infer<typeof PolicyAuditEntrySchema>;

// ---------------------------------------------------------------------------
// PolicyAuditQueryRequest — bounded, validated, discriminated.
// ---------------------------------------------------------------------------

/**
 * Discriminated principal filter. The three variants are mutually
 * exclusive and unambiguous:
 *
 *   - `{ kind: 'any' }`   — no principal filter applied (default).
 *   - `{ kind: 'none' }`  — match only rows whose `principalId IS NULL`
 *                           (principal-agnostic requests).
 *   - `{ kind: 'exact', principalId }` — match only rows with the given
 *                           non-null principal id.
 *
 * HTTP query parsing maps `principalFilter` + optional `principalId`
 * into this union; combinations like `principalFilter=none` together
 * with a non-empty `principalId` are rejected before the launcher fn
 * is called.
 */
export const PolicyAuditPrincipalFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('any') }),
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('exact'),
    principalId: z.string().min(1),
  }),
]);
export type PolicyAuditPrincipalFilter = z.infer<
  typeof PolicyAuditPrincipalFilterSchema
>;

export const POLICY_AUDIT_QUERY_DEFAULT_LIMIT = 50;
export const POLICY_AUDIT_QUERY_MAX_LIMIT = 200;

/**
 * Bounded query request. Project scope is required. All other filters
 * narrow the result set further. `limit` defaults to 50 and is hard-
 * capped at 200; the contract refuses larger values rather than
 * silently clamping so callers see the bound explicitly.
 */
export const PolicyAuditQueryRequestSchema = z
  .object({
    projectId: z.string().min(1),
    folder: z.string().min(1).optional(),
    principal: PolicyAuditPrincipalFilterSchema.default({ kind: 'any' }),
    outcome: PolicyAuditOutcomeSchema.optional(),
    reasonCode: PolicyAuditReasonSchema.optional(),
    /** ISO 8601 lower bound (inclusive). */
    since: UtcIsoTimestampSchema.optional(),
    /** ISO 8601 upper bound (inclusive). */
    until: UtcIsoTimestampSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(POLICY_AUDIT_QUERY_MAX_LIMIT)
      .default(POLICY_AUDIT_QUERY_DEFAULT_LIMIT),
  })
  .superRefine((req, ctx) => {
    if (req.since !== undefined && req.until !== undefined) {
      if (Date.parse(req.since) > Date.parse(req.until)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['until'],
          message: 'until must be greater than or equal to since',
        });
      }
    }
  });
export type PolicyAuditQueryRequest = z.infer<
  typeof PolicyAuditQueryRequestSchema
>;

// ---------------------------------------------------------------------------
// PolicyAuditQueryResponse
// ---------------------------------------------------------------------------

/**
 * Bounded query response. Adapters return at most `limit` entries in
 * `createdAt DESC, id DESC` order. `limit` is echoed for caller
 * confirmation; pagination is by-window via `since`/`until`, NOT by
 * cursor — keeping the contract genuinely bounded.
 */
export const PolicyAuditQueryResponseSchema = z.object({
  projectId: z.string().min(1),
  entries: z.array(PolicyAuditEntrySchema),
  limit: z.number().int().min(1).max(POLICY_AUDIT_QUERY_MAX_LIMIT),
});
export type PolicyAuditQueryResponse = z.infer<
  typeof PolicyAuditQueryResponseSchema
>;
