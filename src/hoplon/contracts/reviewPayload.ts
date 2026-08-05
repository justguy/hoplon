/**
 * contracts/reviewPayload.ts — t-072 canonical review payload DTO.
 *
 * Packages focused review evidence over already-shipped session facts. The
 * payload resolves each touched edit to the nearest logical boundary when a
 * code-intelligence adapter is available, and nests a standard unified diff
 * inside that boundary so a reviewer can approve/reject without leaving the
 * terminal/chat surface.
 *
 * This contract is advisory in the same sense `analyzeBlastRadius` and
 * `getRelevantTests` are advisory: it never drives PASS/BLOCK, never mutates
 * session state, and never imposes a new approval gate. Consumers (hosts,
 * packaged CLI/MCP surfaces) render or forward the payload as-is.
 *
 * Always-present vs. optional (see `t-072` close-out report):
 *
 *   always-present  — version, sessionId, state, phase, generatedAt,
 *                     changedFiles, files[], impact (with explicit
 *                     `UNAVAILABLE` markers), notes[]
 *   session-path    — changeKindCounts (null when the session never ran
 *                     applyEdits)
 *   provider-dep    — impact.blastRadius.entries (only when the configured
 *                     code-intelligence adapter implements findReferences)
 *   oracle-dep      — impact.relevantTests.relevantTests (only when the host
 *                     opted in AND the oracle ran successfully)
 *
 * Honest degradation:
 *
 *   - A file whose boundary cannot be resolved (unsupported language, parse
 *     failure, no enclosing top-level symbol) falls back to a file-level
 *     unified diff with explicit `fallback.reason`.
 *   - Missing providers / oracles surface `status: 'UNAVAILABLE'` with a
 *     specific `reason`; they never collapse silently.
 */

import { z } from 'zod';
import { DependencyImpactSidecarSchema } from './dependencyImpact.js';
import { TestOracleResultSchema } from './getRelevantTests.js';
import { ProposedChangeSchema } from './requests.js';
import { WritePreviewAdvisoryIntelligenceSchema } from './writePreviewIntelligence.js';
import { PostEditPolicyScanSidecarSchema } from './postEditPolicy.js';

// ---------------------------------------------------------------------------
// Review phase and session state mirrors
// ---------------------------------------------------------------------------
export const REVIEW_PAYLOAD_PHASES = ['post-edit', 'preview'] as const;
export const ReviewPayloadPhaseSchema = z.enum(REVIEW_PAYLOAD_PHASES);
export type ReviewPayloadPhase = z.infer<typeof ReviewPayloadPhaseSchema>;

export const ReviewPayloadSessionStateSchema = z.enum([
  'created',
  'preflighted_pass',
  'preflighted_block',
  'snapshotted',
  'edited',
  'audited_pass',
  'audited_block',
  'reverted',
  'rollback_extracted',
  'closed',
]);

// ---------------------------------------------------------------------------
// Change-kind counts (mirrors ApplyEditsChangeKindCounts)
// ---------------------------------------------------------------------------
export const ReviewChangeKindCountsSchema = z.object({
  full_file: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  structural: z.number().int().nonnegative(),
});
export type ReviewChangeKindCounts = z.infer<typeof ReviewChangeKindCountsSchema>;

// ---------------------------------------------------------------------------
// Boundary block — one touched logical unit inside a file
// ---------------------------------------------------------------------------

export const REVIEW_BOUNDARY_CHANGE_MODES = ['modified', 'added', 'removed'] as const;
export const ReviewBoundaryChangeModeSchema = z.enum(REVIEW_BOUNDARY_CHANGE_MODES);
export type ReviewBoundaryChangeMode = z.infer<typeof ReviewBoundaryChangeModeSchema>;

export const REVIEW_BOUNDARY_SIDES = ['before', 'after', 'both'] as const;
export const ReviewBoundarySideSchema = z.enum(REVIEW_BOUNDARY_SIDES);
export type ReviewBoundarySide = z.infer<typeof ReviewBoundarySideSchema>;

/**
 * One bounded review block. The `unifiedDiff` is a standard unified-diff
 * *body* (hunks only, no leading `--- / +++` header) scoped to this
 * boundary's lines — the caller is expected to render the header from
 * `file.path` + `symbol`.
 *
 * `byteRange` is the boundary's byte range on the side named by `side`.
 * For modified symbols that exist on both sides, the range is reported on
 * the `after` side by convention; added symbols report the `after` range;
 * removed symbols report the `before` range. `side = 'both'` is reserved
 * for future widening when a caller needs both ranges and MUST NOT be
 * emitted today — the builder always picks one side deterministically.
 */
export const ReviewBoundarySchema = z.object({
  symbol: z.string().min(1).nullable(),
  symbolKind: z.string().min(1).nullable(),
  side: ReviewBoundarySideSchema,
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  lineRange: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
  changeMode: ReviewBoundaryChangeModeSchema,
  unifiedDiff: z.string(),
});
export type ReviewBoundary = z.infer<typeof ReviewBoundarySchema>;

// ---------------------------------------------------------------------------
// File-level fallback (honest degradation)
// ---------------------------------------------------------------------------

export const REVIEW_FILE_FALLBACK_REASONS = [
  'no_code_intelligence',
  'parse_failure',
  'unsupported_language',
  'no_enclosing_boundary',
  'new_file',
  'deleted_file',
  'binary_content',
] as const;
export const ReviewFileFallbackReasonSchema = z.enum(REVIEW_FILE_FALLBACK_REASONS);
export type ReviewFileFallbackReason = z.infer<typeof ReviewFileFallbackReasonSchema>;

export const ReviewFileFallbackSchema = z.object({
  reason: ReviewFileFallbackReasonSchema,
  message: z.string().min(1),
  unifiedDiff: z.string(),
});
export type ReviewFileFallback = z.infer<typeof ReviewFileFallbackSchema>;

// ---------------------------------------------------------------------------
// File block
// ---------------------------------------------------------------------------

export const ReviewFileSchema = z.object({
  path: z.string().min(1),
  boundaries: z.array(ReviewBoundarySchema),
  fallback: ReviewFileFallbackSchema.nullable(),
});
export type ReviewFile = z.infer<typeof ReviewFileSchema>;

// ---------------------------------------------------------------------------
// Impact sidecars
// ---------------------------------------------------------------------------

export const REVIEW_IMPACT_UNAVAILABLE_REASONS = [
  'not_requested',
  'no_changed_symbols',
  'no_provider',
  'oracle_failure',
  'no_modified_files',
] as const;
export const ReviewImpactUnavailableReasonSchema = z.enum(
  REVIEW_IMPACT_UNAVAILABLE_REASONS,
);
export type ReviewImpactUnavailableReason = z.infer<
  typeof ReviewImpactUnavailableReasonSchema
>;

/**
 * Relevant-tests oracle pane. Still uses its own AVAILABLE/UNAVAILABLE shape
 * because the oracle is owned under t-067 and carries a different payload
 * than the dependency-impact sidecar (test ids, not affected files).
 */
export const ReviewImpactRelevantTestsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('AVAILABLE'),
    result: TestOracleResultSchema,
  }),
  z.object({
    status: z.literal('UNAVAILABLE'),
    reason: ReviewImpactUnavailableReasonSchema,
    detail: z.string().min(1).optional(),
  }),
]);
export type ReviewImpactRelevantTests = z.infer<
  typeof ReviewImpactRelevantTestsSchema
>;

/**
 * `impact.dependencyImpact` is the canonical advisory dependency-impact
 * sidecar shared with the packaged repair-context path (t-077). The
 * previous `impact.blastRadius` field has been replaced by this wider
 * envelope — it still composes `analyzeBlastRadius` under the hood but
 * additionally carries the derived `subjects[]` list and honest
 * `AVAILABLE | DEGRADED | UNAVAILABLE` status so callers no longer have to
 * guess whether a missing result means "we didn't try" or "we tried and
 * couldn't answer".
 */
export const ReviewImpactSchema = z.object({
  dependencyImpact: DependencyImpactSidecarSchema,
  relevantTests: ReviewImpactRelevantTestsSchema,
  advisoryIntelligence: WritePreviewAdvisoryIntelligenceSchema,
  postEditPolicy: PostEditPolicyScanSidecarSchema,
});
export type ReviewImpact = z.infer<typeof ReviewImpactSchema>;

// ---------------------------------------------------------------------------
// Top-level payload
// ---------------------------------------------------------------------------

export const REVIEW_PAYLOAD_NOTES = [
  'markEdited_before_bytes_unavailable',
  'preview_before_bytes_read_from_disk',
  'code_intelligence_unavailable',
  'impact_dependencyImpact_opted_out',
  'impact_violationRisk_opted_out',
  'impact_relevantTests_opted_out',
  /**
   * Post-edit review was requested while the session was still in the
   * `snapshotted` state — no `applyEdits` / `markEdited` transition was ever
   * recorded on this session instance. Rather than throwing
   * `invalid_state_transition` (which a consumer would surface as an EMPTY
   * review), the payload is reconstructed from the contracted writable scope:
   * each in-scope file that exists on disk is reviewed against `before=null`
   * (snapshot before-bytes are not retained in this state), so the reviewer
   * sees the real current contents instead of nothing. Consumers should treat
   * this as "review of the real on-disk files, full-content (no before side)".
   */
  'snapshotted_review_scope_fallback',
  /**
   * The session was in the `snapshotted` state at post-edit review time and
   * none of the contracted writable-scope files exist on disk — i.e. no edit
   * was materialized for this piece. Distinct from
   * `snapshotted_review_scope_fallback` (where real files were found): this
   * note lets a consumer tell "edited but state desynced" apart from
   * "nothing was written" instead of both collapsing to an empty review.
   */
  'snapshotted_review_no_files_on_disk',
] as const;
export const ReviewPayloadNoteSchema = z.enum(REVIEW_PAYLOAD_NOTES);
export type ReviewPayloadNote = z.infer<typeof ReviewPayloadNoteSchema>;

export const SessionReviewPayloadSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  state: ReviewPayloadSessionStateSchema,
  phase: ReviewPayloadPhaseSchema,
  generatedAt: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  /**
   * Null when the session used `markEdited` (host-declared writes) — per-kind
   * counts are only produced by the supervised `applyEdits` path.
   */
  changeKindCounts: ReviewChangeKindCountsSchema.nullable(),
  files: z.array(ReviewFileSchema),
  impact: ReviewImpactSchema,
  notes: z.array(ReviewPayloadNoteSchema),
});
export type SessionReviewPayload = z.infer<typeof SessionReviewPayloadSchema>;

// ---------------------------------------------------------------------------
// Request options (session API consumers + transport callers)
// ---------------------------------------------------------------------------

export const GetReviewPayloadOptionsSchema = z.object({
  /** Defaults to `'post-edit'`. */
  phase: ReviewPayloadPhaseSchema.optional(),
  /** When `phase === 'preview'`, the proposed changes to stage in memory. */
  proposedChanges: z.array(ProposedChangeSchema).optional(),
  /** Number of context lines for unified diffs. Default: 3. */
  contextLines: z.number().int().nonnegative().max(20).optional(),
  /**
   * Opt-in switch for the canonical advisory `dependencyImpact` sidecar
   * (t-077). Omitted/false → the sidecar surfaces
   * `status: 'UNAVAILABLE', reason: 'not_requested'`.
   */
  includeDependencyImpact: z.boolean().optional(),
  /**
   * Opt-in switch for advisory violation-risk metadata inside the shared
   * write-preview intelligence envelope. Omitted/false does not call the
   * predictor and surfaces `provider.status: 'unavailable'`.
   */
  includeViolationRisk: z.boolean().optional(),
  /** Request a relevant-tests oracle pane over changed files. Default: false. */
  includeRelevantTests: z.boolean().optional(),
  /**
   * Opt-in switch for advisory post-edit/proposed-byte content policy scanning.
   * Omitted/false never calls a scanner and surfaces an explicit
   * `not_requested` sidecar.
   */
  includePostEditPolicyScan: z.boolean().optional(),
  /**
   * Optional override for the dependency-impact / blast-radius warn threshold.
   * Echoed on the sidecar so callers cannot be silently re-tuned.
   */
  dependencyImpactWarnThreshold: z.number().int().nonnegative().optional(),
  /** Optional t-128 precomputed changed-file set for dependency-impact sidecars. */
  dependencyImpactPrecomputedChangedFiles: z.array(z.string().min(1)).optional(),
});
export type GetReviewPayloadOptions = z.infer<
  typeof GetReviewPayloadOptionsSchema
>;
