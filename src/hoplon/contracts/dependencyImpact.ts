/**
 * contracts/dependencyImpact.ts — t-077 canonical advisory dependency-impact
 * sidecar DTO shared by review-payload and repair-context packaging.
 *
 * Both the packaged review path (t-072) and the packaged repair-context path
 * (t-070) want the same machine-readable answer to one question: "given what
 * this session touched, which symbols or files are up/downstream dependent
 * on the change?" The answer is strictly advisory — it never alters audit
 * PASS/BLOCK, never widens preflight, and never drives approval policy.
 *
 * This module defines:
 *
 *   - `DependencyImpactSubject` — one derived changed subject (symbol or
 *     file fallback) that the host can render without re-parsing bytes.
 *   - `DependencyImpactSidecar` — the composed sidecar that carries subjects
 *     plus the underlying `AnalyzeBlastRadiusResult` when the shipped
 *     `CodeIntelligenceAdapter.findReferences` seam is available.
 *
 * ## Bounded scope (t-077)
 *   - no second cross-file analysis mechanism — the sidecar composes the
 *     already-shipped `analyzeBlastRadius` operation
 *   - no PASS/BLOCK coupling — `advisory: z.literal(true)` is the hard
 *     invariant
 *   - no hidden threshold changes — the effective `warnThreshold` is echoed
 *     back on the sidecar alongside the `blastRadius` result
 *   - no fabricated symbol identity — a subject never exists unless it was
 *     derived from a real boundary, manifest scope, or audit violation
 *   - file-only degradation stays explicit — a file row always carries an
 *     enumerated `reason` so callers can see why no symbol could be derived
 */

import { z } from 'zod';
import { AnalyzeBlastRadiusResultSchema } from './blastRadius.js';
import { AdvisoryEvidenceStateSchema } from './advisoryIntelligence.js';

// ---------------------------------------------------------------------------
// DependencyImpactSubject — one row of the derived changed-subject list
// ---------------------------------------------------------------------------

export const DEPENDENCY_IMPACT_CHANGE_MODES = [
  'modified',
  'added',
  'removed',
] as const;
export const DependencyImpactChangeModeSchema = z.enum(
  DEPENDENCY_IMPACT_CHANGE_MODES,
);
export type DependencyImpactChangeMode = z.infer<
  typeof DependencyImpactChangeModeSchema
>;

/**
 * How the subject was derived. Knowing the origin lets hosts render the
 * sidecar truthfully — a `review_boundary` row came from an actually-edited
 * top-level symbol, while a `manifest_scope` row is the caller's declared
 * intent even if the failed edit never reached that symbol.
 *
 *   - `review_boundary`    — derived from a `ReviewBoundary` after a real
 *     edit (review-payload path)
 *   - `structural_target`  — derived from a structural `ProposedChange`
 *     target the caller asked Hoplon to resolve
 *   - `audit_violation`    — derived from an `AuditViolation` on the
 *     repair-context path
 *   - `manifest_scope`     — declared scope from the `WritableManifest`
 *     (repair-context or review path when no edits landed)
 */
export const DEPENDENCY_IMPACT_SUBJECT_ORIGINS = [
  'review_boundary',
  'structural_target',
  'audit_violation',
  'manifest_scope',
  'tree_diff_precompute',
] as const;
export const DependencyImpactSubjectOriginSchema = z.enum(
  DEPENDENCY_IMPACT_SUBJECT_ORIGINS,
);
export type DependencyImpactSubjectOrigin = z.infer<
  typeof DependencyImpactSubjectOriginSchema
>;

/**
 * Why a file-only row was emitted instead of one or more symbol rows. When
 * symbols cannot be resolved, the sidecar still lists the affected file so a
 * host reviewer sees what changed — marked honestly as a degraded row
 * rather than silently dropped.
 */
export const DEPENDENCY_IMPACT_FILE_FALLBACK_REASONS = [
  'no_code_intelligence',
  'unsupported_language',
  'parse_failure',
  'no_top_level_symbols_changed',
  'new_file_no_symbols',
  'deleted_file_no_symbols',
  'markEdited_no_before_bytes',
  'binary_content',
  'whole_file_manifest_scope',
  'uncontracted_file',
  'parse_failure_violation',
  'tree_diff_changed_file',
] as const;
export const DependencyImpactFileFallbackReasonSchema = z.enum(
  DEPENDENCY_IMPACT_FILE_FALLBACK_REASONS,
);
export type DependencyImpactFileFallbackReason = z.infer<
  typeof DependencyImpactFileFallbackReasonSchema
>;

export const DependencyImpactSymbolSubjectSchema = z.object({
  kind: z.literal('symbol'),
  path: z.string().min(1),
  symbolName: z.string().min(1),
  symbolKind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  changeMode: DependencyImpactChangeModeSchema,
  origin: DependencyImpactSubjectOriginSchema,
});
export type DependencyImpactSymbolSubject = z.infer<
  typeof DependencyImpactSymbolSubjectSchema
>;

export const DependencyImpactFileSubjectSchema = z.object({
  kind: z.literal('file'),
  path: z.string().min(1),
  origin: DependencyImpactSubjectOriginSchema,
  reason: DependencyImpactFileFallbackReasonSchema,
});
export type DependencyImpactFileSubject = z.infer<
  typeof DependencyImpactFileSubjectSchema
>;

export const DependencyImpactSubjectSchema = z.discriminatedUnion('kind', [
  DependencyImpactSymbolSubjectSchema,
  DependencyImpactFileSubjectSchema,
]);
export type DependencyImpactSubject = z.infer<
  typeof DependencyImpactSubjectSchema
>;

// ---------------------------------------------------------------------------
// DependencyImpactSidecar — the composed sidecar envelope
// ---------------------------------------------------------------------------

/**
 * Outer availability of the sidecar. Three-state so callers never have to
 * guess whether `blastRadius: null` means "we didn't try" vs "we tried and
 * couldn't answer":
 *
 *   - `AVAILABLE`: the analyzer ran over at least one symbol subject AND
 *     produced a result whose own `status` is `SAFE` / `WARNING`.
 *   - `DEGRADED`: subjects exist but the analyzer could not produce a full
 *     symbol-level answer (file-only subjects, missing provider, partial
 *     resolution, analyze failure). The sidecar still carries whatever
 *     `blastRadius` it did produce, never fabricates missing rows.
 *   - `UNAVAILABLE`: caller opted out, no engine was available, or nothing
 *     was derivable at all. `blastRadius` is always null in this state.
 */
export const DEPENDENCY_IMPACT_STATUSES = [
  'AVAILABLE',
  'DEGRADED',
  'UNAVAILABLE',
] as const;
export const DependencyImpactStatusSchema = z.enum(DEPENDENCY_IMPACT_STATUSES);
export type DependencyImpactStatus = z.infer<
  typeof DependencyImpactStatusSchema
>;

export const DEPENDENCY_IMPACT_REASONS = [
  /** Caller did not opt in (review/repair `includeDependencyImpact` omitted/false). */
  'not_requested',
  /** No engine was injected at the composition site. */
  'no_engine',
  /** Changed-subject derivation produced zero entries. */
  'no_changed_subjects',
  /** Derivation produced only file-only rows; no symbol query was possible. */
  'no_symbol_subjects',
  /** `findReferences` is not implemented by the injected code-intelligence provider. */
  'no_provider',
  /** analyzeBlastRadius threw; detail carries the truncated error message. */
  'analyze_failed',
  /** Operation was aborted via the caller's AbortSignal. */
  'aborted',
  /** Sidecar ran but at least one subject produced only file-only evidence. */
  'file_only_fallback',
  /** Sidecar ran but the analyzer reported `UNAVAILABLE` for at least one symbol. */
  'partial_symbol_resolution',
] as const;
export const DependencyImpactReasonSchema = z.enum(DEPENDENCY_IMPACT_REASONS);
export type DependencyImpactReason = z.infer<
  typeof DependencyImpactReasonSchema
>;

export const DependencyImpactSidecarSchema = z.object({
  /** Schema version — never downgraded silently. */
  version: z.literal(1),
  /** Pinned advisory — never PASS/BLOCK bearing. */
  advisory: z.literal(true),
  /** Outer availability (see enum comments). */
  status: DependencyImpactStatusSchema,
  /** Shared advisory evidence semantics; never deterministic proof. */
  evidence: AdvisoryEvidenceStateSchema,
  /**
   * Specific reason when !AVAILABLE or DEGRADED. Null when fully AVAILABLE
   * without caveats so that callers can positively assert "no degradation".
   */
  reason: DependencyImpactReasonSchema.nullable(),
  /**
   * Free-form detail for `analyze_failed` / `aborted`. Truncated upstream at
   * composition time to keep the sidecar bounded.
   */
  detail: z.string().min(1).nullable(),
  /** Subjects derived from the changed session state. May be empty. */
  subjects: z.array(DependencyImpactSubjectSchema),
  /** Quick at-a-glance counts consistent with `subjects[]`. */
  subjectCounts: z.object({
    symbol: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
  }),
  /**
   * Full `analyzeBlastRadius` result when the analyzer ran. Null on
   * UNAVAILABLE. On DEGRADED this may be null (no symbols queryable) or
   * carry a partial result where some entries are `missing_provider`.
   */
  blastRadius: AnalyzeBlastRadiusResultSchema.nullable(),
  /** Echoed warn threshold that classified the report. Null when no query ran. */
  warnThreshold: z.number().int().nonnegative().nullable(),
});
export type DependencyImpactSidecar = z.infer<
  typeof DependencyImpactSidecarSchema
>;

// ---------------------------------------------------------------------------
// Caller-facing options (reused by review-payload and repair-context callers)
// ---------------------------------------------------------------------------

/**
 * Composer request knobs. Reused by both review-payload and repair-context
 * callers so the sidecar is shaped identically on both seams.
 */
export const DependencyImpactOptionsSchema = z.object({
  /** Opt-in switch. Omitted/false → sidecar returns `UNAVAILABLE: not_requested`. */
  includeDependencyImpact: z.boolean().optional(),
  /** Optional override for the blast-radius warn threshold. */
  warnThreshold: z.number().int().nonnegative().optional(),
  /**
   * Optional t-128 precomputed changed files from the injected versioning tree
   * diff helper. These enrich the existing advisory sidecar as file subjects;
   * they do not become a second blast-radius authority.
   */
  precomputedChangedFiles: z.array(z.string().min(1)).optional(),
});
export type DependencyImpactOptions = z.infer<
  typeof DependencyImpactOptionsSchema
>;
