/**
 * contracts/dlp.ts — t-026 semantic-DLP contracts.
 *
 * Ships alongside the existing secret-scanner path without replacing it. The
 * shipped secret scanner keeps its warnings-only surface; semantic DLP adds
 * a distinct finding class (classified categories such as PII / financial /
 * healthcare / source-code fragments) and an explicit, caller-visible policy
 * mode that controls how findings are surfaced by `createSnapshot`.
 *
 * ## Bounded scope (t-026)
 * - Additive contract only. The shipped `SecretFinding` path is unchanged.
 * - No default-blocking behavior. Default `DlpPolicyMode` is `warn`.
 * - No coupling to `auditDiff` — DLP findings never become `AuditViolation`s.
 * - H13-compliant: findings carry a redacted snippet and a closed classification
 *   enum. Raw content never flows into operational events.
 *
 * ## Not in scope
 * - A managed real DLP provider (host-owned; this slice ships the seam only).
 * - Promotion of DLP findings into structural audit semantics.
 * - Automatic rule-pack discovery, policy inheritance, tenant overrides.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// DlpClassification — closed enum of data-class labels
// ---------------------------------------------------------------------------

/**
 * Canonical closed set of DLP classifications. Closed so that the H13 surface
 * stays stable: adding a new classification is an explicit contract bump, not
 * a silent provider extension.
 */
export const DLP_CLASSIFICATIONS = [
  'pii',
  'credential',
  'financial',
  'healthcare',
  'source_code',
  'other',
] as const;
export const DlpClassificationSchema = z.enum(DLP_CLASSIFICATIONS);
export type DlpClassification = z.infer<typeof DlpClassificationSchema>;

// ---------------------------------------------------------------------------
// DlpPolicyMode — explicit caller-visible policy
// ---------------------------------------------------------------------------

/**
 * How `createSnapshot` must treat non-empty DLP findings.
 *
 * - `disabled` — skip the DLP scan entirely. Adapter is not invoked.
 * - `warn` — invoke the adapter; surface findings in `SnapshotResult.warnings`.
 *   The shipped default. Never throws on a finding.
 * - `block` — invoke the adapter; if any finding is produced, createSnapshot
 *   throws a typed `ValidationError` with kind `dlp_policy_block` BEFORE any
 *   git commit lands. Opt-in only; never the default.
 *
 * The mode is a caller-visible configuration, not an implicit default. Hosts
 * that want stronger posture must set the mode explicitly.
 */
export const DLP_POLICY_MODES = ['disabled', 'warn', 'block'] as const;
export const DlpPolicyModeSchema = z.enum(DLP_POLICY_MODES);
export type DlpPolicyMode = z.infer<typeof DlpPolicyModeSchema>;

/** The shipped default DLP policy stance — warn-only. */
export const DEFAULT_DLP_POLICY_MODE: DlpPolicyMode = 'warn';

// ---------------------------------------------------------------------------
// DlpFinding — content-free finding envelope
// ---------------------------------------------------------------------------

/**
 * A single DLP detection. Never carries the raw matched value — providers are
 * required to populate `redactedSnippet` with the raw match replaced by a
 * placeholder (convention: `[REDACTED_<CLASSIFICATION>]` or provider-specific
 * marker). Confidence is optional so providers that return only rule-based
 * hits do not need to fabricate a score.
 */
export const DlpFindingSchema = z.object({
  /** Rule or detector name (closed per provider, free-form string at the seam). */
  ruleId: z.string().min(1),
  /** Closed-enum classification so the H13 surface stays stable. */
  classification: DlpClassificationSchema,
  /**
   * Optional confidence score in [0, 1]. When absent, the host must treat the
   * finding as a rule-based hit of unspecified confidence. Never fabricated.
   */
  confidence: z.number().min(0).max(1).optional(),
  /** 1-indexed line number of the match within the scanned file. */
  lineNumber: z.number().int().positive(),
  /**
   * The matched line with the sensitive value replaced by a placeholder.
   * Providers MUST redact before returning; the adapter boundary re-asserts
   * that the raw value is not present. Empty string is valid when the match
   * cannot be reconstructed without revealing the value.
   */
  redactedSnippet: z.string(),
});
export type DlpFinding = z.infer<typeof DlpFindingSchema>;

// ---------------------------------------------------------------------------
// Adapter-facing request envelope
// ---------------------------------------------------------------------------

/**
 * Structural input the adapter sees on each scan. The adapter receives a
 * relative path (for provenance / rule selection) and the raw file content
 * (so the provider can run pattern / ML checks). The adapter implementation
 * is host-owned and may be fully in-process or delegate to an external
 * provider; either way, this envelope is stable.
 */
export const DlpScanInputSchema = z.object({
  path: z.string().min(1),
  content: z.instanceof(Uint8Array),
});
// Intentional: the adapter-facing `DlpScanInput` type is declared in
// `adapters/dlp.ts` as a plain interface so its `Uint8Array` parameter stays
// compatible with `fs.read` return values across TS lib versions. Host code
// that wants runtime validation of the input envelope uses DlpScanInputSchema.
