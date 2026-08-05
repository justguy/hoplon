/**
 * snapshot.ts — SnapshotRef, SnapshotResult, and SnapshotWarning Zod schemas.
 *
 * SnapshotRef is the opaque pointer returned by createSnapshot.
 * id is sha256(stableStringify(manifest)) per invariant H1.
 *
 * Phase 2 HA1: new IDs use the `sha256:<64-char-hex>` format.
 * Legacy bare-hex IDs (64 lowercase hex chars) are still accepted for backward compat (H19).
 *
 * SnapshotResult bundles the ref with non-blocking secret-scan warnings.
 * SnapshotWarning carries redacted evidence — never the raw secret.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SnapshotRef
// ---------------------------------------------------------------------------

export const SnapshotRefSchema = z.object({
  /**
   * Content-addressable snapshot ID.
   *
   * Phase 2 HA1 format: `sha256:<64-char-lowercase-hex>` (71 chars).
   * Legacy Phase 1 format: bare 64-char lowercase hex (still accepted for backward compat — H19).
   */
  id: z
    .string()
    .regex(
      /^(?:sha256:[0-9a-f]{64}|[0-9a-f]{64})$/,
      'snapshot id must be sha256:<64-hex> or a bare 64-char lowercase hex string',
    ),
  /** engineId of the engine that created this snapshot. */
  engineId: z
    .string()
    .min(1, 'engineId must be non-empty')
    .regex(/^\S+$/, 'engineId must not contain whitespace'),
  /**
   * Run ID from the manifest — flows through for AS-2 cross-run replay
   * protection. Callers use this to verify the ref belongs to their run.
   */
  runId: z.string().min(1, 'runId must be non-empty'),
  /** ISO 8601 UTC timestamp. */
  createdAt: z
    .string()
    .datetime({ offset: false, message: 'createdAt must be ISO 8601 UTC' }),
});

export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;

// ---------------------------------------------------------------------------
// SnapshotWarning — discriminated union
// ---------------------------------------------------------------------------

/**
 * A non-blocking warning emitted during createSnapshot.
 * The snapshot commits regardless; the host decides whether to proceed.
 * The 'possible_secret' variant carries a redacted snippet — never the raw value.
 */
export const SnapshotWarningPossibleSecretSchema = z.object({
  kind: z.literal('possible_secret'),
  path: z.string().min(1),
  patternName: z.string().min(1),
  lineNumber: z.number().int().nonnegative(),
  /** The matched line with the secret characters replaced by [REDACTED]. */
  redactedSnippet: z.string(),
});

/**
 * Semantic-DLP finding surfaced as a non-blocking warning (t-026). Emitted
 * when `dlpPolicyMode === 'warn'`. Content-free: carries a closed-enum
 * classification and a redacted snippet only — never the raw matched value.
 */
export const SnapshotWarningPossibleDlpFindingSchema = z.object({
  kind: z.literal('possible_dlp_finding'),
  path: z.string().min(1),
  ruleId: z.string().min(1),
  classification: z.enum([
    'pii',
    'credential',
    'financial',
    'healthcare',
    'source_code',
    'other',
  ]),
  confidence: z.number().min(0).max(1).optional(),
  lineNumber: z.number().int().positive(),
  redactedSnippet: z.string(),
});

export const SnapshotWarningSchema = z.discriminatedUnion('kind', [
  SnapshotWarningPossibleSecretSchema,
  SnapshotWarningPossibleDlpFindingSchema,
]);

export type SnapshotWarning = z.infer<typeof SnapshotWarningSchema>;

// ---------------------------------------------------------------------------
// SnapshotResult
// ---------------------------------------------------------------------------

export const SnapshotResultSchema = z.object({
  snapshotRef: SnapshotRefSchema,
  /** Non-blocking secret-scan warnings. Always present; may be empty. */
  warnings: z.array(SnapshotWarningSchema),
});

export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;
