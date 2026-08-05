/**
 * contracts/blastRadius.ts — t-027 advisory blast-radius DTOs.
 *
 * The bounded `analyzeBlastRadius` operation reports, for each caller-supplied
 * symbol, how many cross-file references reach it and how many distinct files
 * would be affected if the symbol's declaration changed. It is additive to the
 * existing CodeIntelligence seam and strictly advisory.
 *
 * ## Bounded scope (t-027)
 * - no coupling to `auditDiff` / `createSnapshot` — structural audit PASS/BLOCK
 *   never consults this report
 * - no new cross-file reference mechanism — the operation calls the existing
 *   `CodeIntelligenceAdapter.findReferences` (optional on the contract)
 * - no hidden SCIP prerequisite — when `findReferences` is unimplemented the
 *   operation returns a structured `UNAVAILABLE` result with every symbol
 *   classified `missing_provider`, never throws
 * - no default blocking — the `advisory: z.literal(true)` schema field is the
 *   hard invariant; promoting this report to a blocking role is a separate
 *   out-of-scope slice
 *
 * ## Threshold surface
 * The warn threshold is explicit. `DEFAULT_BLAST_RADIUS_WARN_THRESHOLD = 10`
 * is a reference default; every result echoes the effective `warnThreshold`
 * and every entry echoes the `thresholdUsed` that classified it so callers
 * cannot be silently re-tuned.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Default warn threshold
// ---------------------------------------------------------------------------

/**
 * Reference default used when the caller does not pass `warnThreshold`.
 *
 * Intentionally surfaced at the module level: the value is echoed back on
 * the result so any future change is a visible contract change, never an
 * implicit behaviour change.
 */
export const DEFAULT_BLAST_RADIUS_WARN_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// BlastRadiusSymbol — the subject of one query
// ---------------------------------------------------------------------------

/**
 * Caller-supplied symbol target. Fields mirror the existing `Symbol` shape
 * exported from `adapters/codeIntelligence.ts` so the caller can forward
 * `getTopLevelSymbols()` results directly.
 *
 * `path` is optional — some providers index purely by symbol name; when the
 * caller has it available it flows through so callers can display it alongside
 * the classification.
 */
export const BlastRadiusSymbolSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  path: z.string().min(1).optional(),
});
export type BlastRadiusSymbol = z.infer<typeof BlastRadiusSymbolSchema>;

// ---------------------------------------------------------------------------
// BlastRadiusEntry — classification for one symbol
// ---------------------------------------------------------------------------

export const BlastRadiusClassificationSchema = z.enum([
  'safe',
  'warning',
  'missing_provider',
]);
export type BlastRadiusClassification = z.infer<
  typeof BlastRadiusClassificationSchema
>;

/**
 * The per-symbol row returned by `analyzeBlastRadius`.
 *
 * `missing_provider` is a first-class state rather than an error so callers
 * can surface "no cross-file data available" without turning the advisory
 * operation into a failure path. `thresholdUsed` echoes the numeric value
 * the operation actually applied so the classification is reconstructable.
 */
export const BlastRadiusEntrySchema = z.object({
  symbol: BlastRadiusSymbolSchema,
  classification: BlastRadiusClassificationSchema,
  /** Total reference sites reported by the provider. */
  referenceCount: z.number().int().nonnegative(),
  /** Unique files touched by those references. */
  affectedFileCount: z.number().int().nonnegative(),
  /**
   * Unique affected file paths in sorted order. Empty when
   * `referenceCount === 0` or `classification === 'missing_provider'`.
   */
  affectedFiles: z.array(z.string().min(1)),
  /** The warn threshold applied to classify this row. */
  thresholdUsed: z.number().int().nonnegative(),
});
export type BlastRadiusEntry = z.infer<typeof BlastRadiusEntrySchema>;

// ---------------------------------------------------------------------------
// AnalyzeBlastRadiusResult
// ---------------------------------------------------------------------------

export const BlastRadiusStatusSchema = z.enum([
  /** Every entry is below threshold. */
  'SAFE',
  /** At least one entry met or exceeded threshold. */
  'WARNING',
  /** The configured CodeIntelligence adapter does not implement findReferences. */
  'UNAVAILABLE',
]);
export type BlastRadiusStatus = z.infer<typeof BlastRadiusStatusSchema>;

/**
 * Advisory-only output of `analyzeBlastRadius`.
 *
 * - `advisory: z.literal(true)` is the hard invariant — a misbehaving consumer
 *   cannot silently flip it to a blocking verdict at the engine boundary.
 * - `status === 'UNAVAILABLE'` is returned when the CodeIntelligence adapter
 *   does not expose `findReferences` (e.g., the shipped tree-sitter default
 *   on its own). The operation never fabricates cross-file data.
 * - `providerAvailable` mirrors `status !== 'UNAVAILABLE'` and is kept as a
 *   boolean so callers that only care about seam readiness can branch on it
 *   without string-matching.
 */
export const AnalyzeBlastRadiusResultSchema = z.object({
  correlationId: z.string().min(1),
  advisory: z.literal(true),
  status: BlastRadiusStatusSchema,
  providerAvailable: z.boolean(),
  /** The warn threshold applied to every entry in this report. */
  warnThreshold: z.number().int().nonnegative(),
  entries: z.array(BlastRadiusEntrySchema),
});
export type AnalyzeBlastRadiusResult = z.infer<
  typeof AnalyzeBlastRadiusResultSchema
>;

// ---------------------------------------------------------------------------
// AnalyzeBlastRadiusRequest
// ---------------------------------------------------------------------------

/**
 * Input for `analyzeBlastRadius`.
 *
 * The caller supplies the symbol targets directly — the operation does not
 * re-derive them from a manifest or a diff. This keeps the seam composable
 * (a preflight consumer can feed it `getTopLevelSymbols()` on the intent
 * list) and avoids entangling the advisory path with auditDiff semantics.
 *
 * `warnThreshold` is optional. Omitted → `DEFAULT_BLAST_RADIUS_WARN_THRESHOLD`
 * is applied and echoed on the result. Passing `0` means "warn on every
 * non-zero reference count".
 */
export const AnalyzeBlastRadiusRequestSchema = z.object({
  /** Mandatory trace ID (H11). */
  correlationId: z.string().min(1),
  /** Optional project scoping for telemetry. */
  projectId: z.string().min(1).optional(),
  /** Subject symbols. At least one entry is required. */
  symbols: z.array(BlastRadiusSymbolSchema).min(1),
  /**
   * Classification threshold. An entry with at least one reference whose
   * `referenceCount >= warnThreshold` is flagged `warning`; everything else
   * is `safe`. A symbol with zero references is always `safe`, regardless
   * of threshold — including `warnThreshold: 0`. Omitted → reference default
   * (`DEFAULT_BLAST_RADIUS_WARN_THRESHOLD`).
   */
  warnThreshold: z.number().int().nonnegative().optional(),
});
export type AnalyzeBlastRadiusRequest = z.infer<
  typeof AnalyzeBlastRadiusRequestSchema
>;
