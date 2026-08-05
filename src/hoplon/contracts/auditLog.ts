/**
 * contracts/auditLog.ts — AuditLogRecord Zod schema and TypeScript types.
 *
 * Defines the immutable append-only audit trail record for the hoplon_audit_log table.
 *
 * ## H13 enforcement (content-free logs)
 * violationKinds is an array of closed-union kind strings ONLY.
 * It MUST NOT contain: sourceSlice, correction, symbolName, byteRange, path, or any
 * content-bearing field. Violation evidence stays in the returned AuditResult DTO.
 * The log records decisions (kinds), not evidence (content).
 *
 * ## H18 enforcement (append-only)
 * No update method exists on SnapshotStore for audit log records.
 * Only INSERT and DELETE (via gcAuditLog) are permitted on this table.
 * The id field is a UUID unique per log entry — not content-addressable
 * (audit decisions are events, not content-addressed objects).
 *
 * ## H21
 * dryRun never writes to hoplon_audit_log; auditDiff, createSnapshot, and
 * revertUncontracted always write (best-effort per cross-boundary rule 9).
 *
 * ## Phase 3 note
 * violationKinds contains string values from the AuditViolation.kind discriminated
 * union. In Phase 2+ this will expand as SV2 adds new violation kinds. The schema
 * uses z.array(z.string()) to remain forward-compatible without requiring a migration
 * each time a new kind is added; callers enforcing the closed union should apply
 * their own allowlist on top.
 *
 * ## ML2 note (Phase 2 Stage E)
 * Three additive ML columns capture aggregate metrics for violation predictor training
 * (Phase 3). These are counts/ratios ONLY — H13 is not violated because no content,
 * no symbol names, no paths, no slices are stored. Columns are nullable so existing
 * rows pre-migration remain readable (H19 backward-compatibility).
 *
 * - astNodeCount   INTEGER — total AST node count across all audited files
 * - fileLineCount  INTEGER — total line count across all audited files
 * - manifestScopeRatio REAL — (bytes covered by manifest scope) / (total file bytes)
 *   Value is null when no parseable files were present; 0.0–1.0 otherwise.
 *   whole_file scope entries contribute their full byte count to numerator.
 */

import { z } from 'zod';
import { PolicyAuditEventSchema } from './policyAudit.js';
import { ProofAccessAuditEventSchema } from './complianceAccess.js';

// ---------------------------------------------------------------------------
// Closed-union enumerations
// ---------------------------------------------------------------------------

/**
 * The set of engine operations that produce audit log entries.
 * dryRun is explicitly NOT in this union (H21).
 * packContext is NOT in this union — read-only, no audit decision.
 *
 * t-088 additions (policy lane — POLICY_* values):
 *   - POLICY_HANDSHAKE    — every handshake attempt (grant or deny).
 *   - POLICY_ACCESS_CHECK — every gated read/search/edit verify.
 *   - POLICY_RENEW        — engagement-token renewal attempts.
 *   - POLICY_REVOKE       — engagement-token revocation attempts.
 *
 * New enum values are emitted alongside a `policyEvent` payload carrying
 * the typed reason code, requested action, canonical folder, principal,
 * resolved access mode, and engagement correlation id. H13 is preserved:
 * no raw token, no rule body, no file content is persisted.
 */
export const AuditLogOperationSchema = z.enum([
  'CREATE_SNAPSHOT',
  'AUDIT_DIFF',
  'REVERT',
  'POLICY_HANDSHAKE',
  'POLICY_ACCESS_CHECK',
  'POLICY_CAPABILITY_CHECK',
  'POLICY_RENEW',
  'POLICY_REVOKE',
  'PROOF_ACCESS',
]);
export type AuditLogOperation = z.infer<typeof AuditLogOperationSchema>;

/**
 * Outcome of the operation from the audit perspective.
 * PASS  = operation completed without scope violations.
 * BLOCK = auditDiff detected out-of-scope violations.
 * ERROR = operation failed before an audit decision was reached.
 *
 * t-088 additions (policy lane — closed-union outcomes for POLICY_* ops):
 *   - GRANTED          — handshake issued or access check allowed.
 *   - DENIED           — handshake rejected by policy, request, or lookup.
 *   - REAUTH_REQUIRED  — token missing / expired / out-of-scope; caller
 *     must re-handshake. Also covers renew rejections that cannot auto-
 *     extend (policy changed between issuance and renewal).
 *   - REVOKED          — engagement binding explicitly removed.
 */
export const AuditLogResultSchema = z.enum([
  'PASS',
  'BLOCK',
  'ERROR',
  'GRANTED',
  'DENIED',
  'REAUTH_REQUIRED',
  'REVOKED',
]);
export type AuditLogResult = z.infer<typeof AuditLogResultSchema>;

const POLICY_AUDIT_OPERATIONS = new Set<AuditLogOperation>([
  'POLICY_HANDSHAKE',
  'POLICY_ACCESS_CHECK',
  'POLICY_CAPABILITY_CHECK',
  'POLICY_RENEW',
  'POLICY_REVOKE',
]);

const POLICY_AUDIT_RESULTS = new Set<AuditLogResult>([
  'GRANTED',
  'DENIED',
  'REAUTH_REQUIRED',
  'REVOKED',
]);

const LEGACY_AUDIT_RESULTS = new Set<AuditLogResult>([
  'PASS',
  'BLOCK',
  'ERROR',
]);

const PROOF_ACCESS_RESULTS = new Set<AuditLogResult>([
  'GRANTED',
  'DENIED',
]);

// ---------------------------------------------------------------------------
// AuditLogRecord — the shape of one row in hoplon_audit_log
// ---------------------------------------------------------------------------

export const AuditLogRecordSchema = z.object({
  /** UUID — unique per log entry (not content-addressable). */
  id: z.string().uuid(),
  /**
   * The snapshot this log entry is associated with.
   * Null for operations not bound to a specific snapshot at the time of logging
   * (e.g. ERROR path before snapshot creation completes).
   */
  snapshotId: z.string().nullable(),
  /** Project scoping (H14). */
  projectId: z.string().min(1),
  /** Run scoping — cross-run replay protection (H14, AS-2). */
  runId: z.string().min(1),
  /** Engine that produced this log entry (H5). */
  engineId: z.string().min(1),
  /**
   * Caller-supplied trace ID for cross-system correlation (H11).
   * Mandatory — never null, never empty.
   */
  correlationId: z.string().min(1),
  /** The engine operation that produced this entry. */
  operation: AuditLogOperationSchema,
  /** Outcome of the operation. */
  result: AuditLogResultSchema,
  /** Number of AuditViolations found (0 for PASS and ERROR paths). */
  violationCount: z.number().int().nonnegative(),
  /**
   * Array of AuditViolation.kind strings — H13 enforcement.
   * Contains ONLY the kind discriminant (e.g. 'out_of_scope_symbol').
   * NEVER contains: sourceSlice, correction, symbolName, byteRange, path, or
   * any other content-bearing field from the AuditViolation object.
   * Empty array for PASS and ERROR results.
   */
  violationKinds: z.array(z.string()),
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs: z.number().int().nonnegative(),
  /** ISO 8601 UTC timestamp when the log entry was created. */
  createdAt: z.string(),

  // ---------------------------------------------------------------------------
  // ML2 columns — Phase 2 Stage E additive additions.
  // All nullable (existing rows pre-migration → null). H13: counts/ratios only.
  // ---------------------------------------------------------------------------

  /**
   * Total AST node count across all audited files.
   * Null when the operation did not produce parseable trees (e.g. REVERT, ERROR).
   */
  astNodeCount: z.number().int().nonnegative().nullable().optional(),

  /**
   * Total line count (newline-delimited) across all audited file contents.
   * Null when the operation did not read file contents (e.g. ERROR before file reads).
   */
  fileLineCount: z.number().int().nonnegative().nullable().optional(),

  /**
   * (bytes covered by manifest scope) / (total file bytes), range 0.0–1.0.
   * Null when no files were audited or total bytes = 0.
   * whole_file entries contribute their full byte count to the numerator.
   * symbols entries contribute 0 to numerator (scope is symbolic, not positional).
   */
  manifestScopeRatio: z.number().min(0).max(1).nullable().optional(),

  // ---------------------------------------------------------------------------
  // t-088 — policy audit payload.
  //
  // Non-null only for rows whose `operation` is one of the `POLICY_*` values.
  // Legacy rows (CREATE_SNAPSHOT / AUDIT_DIFF / REVERT) carry null here.
  // H13-safe by construction — see PolicyAuditEvent docstring.
  // ---------------------------------------------------------------------------

  policyEvent: PolicyAuditEventSchema.nullable().optional(),

  // t-136 — proof/export access audit payload. H13-safe by schema.
  proofAccessEvent: ProofAccessAuditEventSchema.nullable().optional(),
  // ---------------------------------------------------------------------------
  // t-134 — SOC2 audit-log integrity hash chain.
  //
  // Adapter-owned metadata. Callers append ordinary audit rows; SnapshotStore
  // computes these fields at insertion time. Nullable/optional keeps pre-chain
  // rows readable and lets integrity verification report UNCHECKED explicitly.
  // ---------------------------------------------------------------------------

  auditSequence: z.number().int().positive().nullable().optional(),
  previousChainHash: z.string().nullable().optional(),
  rowHash: z.string().nullable().optional(),
  chainHash: z.string().nullable().optional(),
  chainVersion: z.number().int().positive().nullable().optional(),
  chainAlgorithm: z.enum(['sha256']).nullable().optional(),
}).superRefine((record, ctx) => {
  const policyOperation = POLICY_AUDIT_OPERATIONS.has(record.operation);
  if (policyOperation) {
    if (record.policyEvent == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policyEvent'],
        message: 'POLICY_* audit rows require a policyEvent payload',
      });
    }
    if (!POLICY_AUDIT_RESULTS.has(record.result)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'POLICY_* audit rows require a policy outcome result',
      });
    }
    return;
  }
  if (record.operation === 'PROOF_ACCESS') {
    if (record.policyEvent != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policyEvent'],
        message: 'PROOF_ACCESS audit rows must not carry policyEvent',
      });
    }
    if (record.proofAccessEvent == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofAccessEvent'],
        message: 'PROOF_ACCESS audit rows require a proofAccessEvent payload',
      });
    }
    if (!PROOF_ACCESS_RESULTS.has(record.result)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'PROOF_ACCESS rows require GRANTED or DENIED result',
      });
    }
    return;
  }
  if (record.proofAccessEvent != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proofAccessEvent'],
      message: 'non-PROOF_ACCESS audit rows must not carry proofAccessEvent',
    });
  }
  if (record.policyEvent != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyEvent'],
      message: 'non-policy audit rows must not carry policyEvent',
    });
  }
  if (!LEGACY_AUDIT_RESULTS.has(record.result)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result'],
      message: 'non-policy audit rows require PASS, BLOCK, or ERROR result',
    });
  }
});

export type AuditLogRecord = z.infer<typeof AuditLogRecordSchema>;
