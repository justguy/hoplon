/**
 * requests.ts — Request DTOs for all engine operations.
 *
 * Zod schemas are the single source of truth.
 * TypeScript types are derived via z.infer<typeof schema>.
 *
 * Every request carries correlationId (mandatory, H11) and projectId/runId
 * for AS-2 cross-project/cross-run replay protection.
 */

import { z } from 'zod';
import { WritableManifestSchema } from './manifest.js';
import { ASTStrategySchema } from './astStrategy.js';
import { DeclarativeInvariantBindingSchema } from './invariantBinding.js';

// ---------------------------------------------------------------------------
// PreflightRequest
// ---------------------------------------------------------------------------

/**
 * Request for preflight() — runs all registered Stage 1 gates before any
 * write operation. Gates aggregate violations as structured payload; only
 * unexpected errors (EngineError, AdapterError) are thrown.
 *
 * snapshotRefId is optional because some gates work with just the manifest
 * (e.g. path_traversal), while others need a prior snapshot reference
 * (e.g. check_targets added in Phase 2 Stage B LC1).
 */
export const PreflightRequestSchema = z.object({
  manifest: WritableManifestSchema,
  /** Optional snapshot reference — some gates require it, others skip when absent. */
  snapshotRefId: z.string().optional(),
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
});

export type PreflightRequest = z.infer<typeof PreflightRequestSchema>;

// ---------------------------------------------------------------------------
// CreateSnapshotRequest
// ---------------------------------------------------------------------------

export const CreateSnapshotRequestSchema = z.object({
  /**
   * The contracted writable scope.
   * projectId, runId, correlationId are pulled from the manifest itself.
   */
  manifest: WritableManifestSchema,
});

export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>;

// ---------------------------------------------------------------------------
// AuditRequest
// ---------------------------------------------------------------------------

export const AuditRequestSchema = z.object({
  snapshotRefId: z.string().min(1, 'snapshotRefId must be non-empty'),
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /** Paths to audit, relative to the fs adapter root. */
  files: z.array(z.string().min(1)),
});

export type AuditRequest = z.infer<typeof AuditRequestSchema>;

// ---------------------------------------------------------------------------
// RevertRequest
// ---------------------------------------------------------------------------

export const RevertRequestSchema = z.object({
  snapshotRefId: z.string().min(1, 'snapshotRefId must be non-empty'),
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
});

export type RevertRequest = z.infer<typeof RevertRequestSchema>;

// ---------------------------------------------------------------------------
// PackContextRequest
// ---------------------------------------------------------------------------

export const PackContextRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /** Paths to pack, relative to the fs adapter root. */
  files: z.array(z.string().min(1)),
  strategy: ASTStrategySchema,
});

export type PackContextRequest = z.infer<typeof PackContextRequestSchema>;

// ---------------------------------------------------------------------------
// ProposedChange + DryRunRequest
// ---------------------------------------------------------------------------

/**
 * Reference to a previously staged content body (t-076). Non-binary text
 * only — the staging sub-protocol accumulates base64-encoded UTF-8 bytes under
 * a session-scoped `stagingKey` before `applyEdits` consumes them. Carrying
 * `expectedSha256` + `expectedByteLength` lets the resolver verify the
 * finalized bytes match the body the caller intended before any disk touch.
 */
export const StagedContentRefSchema = z.object({
  stagingKey: z.string().min(1, 'stagingKey must be non-empty'),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'expectedSha256 must be a 64-char lowercase hex sha256'),
  expectedByteLength: z
    .number()
    .int()
    .nonnegative('expectedByteLength must be a non-negative integer'),
});

export type StagedContentRef = z.infer<typeof StagedContentRefSchema>;

/**
 * Legacy full-file shape. Preserved verbatim for compatibility with pre-t-071
 * callers that submit `{ file, content }` without a `kind`. A missing `kind`
 * is interpreted as `full_file`; when `kind` is present it must be the
 * literal `'full_file'`.
 *
 * t-076 additively widens the content carrier so the caller may either:
 *   - supply inline `content: string` (unchanged legacy path), OR
 *   - supply `stagedContent: StagedContentRef` referencing a previously
 *     staged body for large non-binary payloads.
 * Exactly one of `{ content, stagedContent }` must be set. The supervised
 * write path resolves `stagedContent` to a concrete UTF-8 string before the
 * shared resolver runs, so downstream audit/revert semantics stay identical.
 */
export const FullFileProposedChangeSchema = z
  .object({
    kind: z.literal('full_file').optional(),
    file: z.string().min(1, 'file must be non-empty'),
    content: z.string().optional(),
    stagedContent: StagedContentRefSchema.optional(),
  })
  .refine(
    (v) => (v.content !== undefined) !== (v.stagedContent !== undefined),
    {
      message:
        'full_file change must set exactly one of { content, stagedContent }',
    },
  );

export type FullFileProposedChange = z.infer<typeof FullFileProposedChangeSchema>;

/**
 * A single anchored search/replace hunk inside a patch change. The `search`
 * anchor must match the current file bytes exactly once (no line numbers, no
 * ambiguous anchors) so the resolved final bytes remain deterministic.
 */
export const PatchHunkSchema = z.object({
  /** Exact substring that must match the current file bytes exactly once. */
  search: z.string().min(1, 'search must be non-empty'),
  /** Replacement string. May be empty to delete the anchor. */
  replace: z.string(),
});

export type PatchHunk = z.infer<typeof PatchHunkSchema>;

/**
 * Patch-based change. Applies ordered search/replace hunks against the
 * current file bytes to produce one deterministic final file state. Brittle
 * line-number-based range edits are intentionally excluded (t-071 contract).
 */
export const PatchProposedChangeSchema = z.object({
  kind: z.literal('patch'),
  file: z.string().min(1, 'file must be non-empty'),
  hunks: z.array(PatchHunkSchema).min(1, 'hunks must not be empty'),
});

export type PatchProposedChange = z.infer<typeof PatchProposedChangeSchema>;

/**
 * Top-level symbol selector. Must resolve to exactly one top-level symbol in
 * the current file bytes. Preserves the legacy t-071 target shape.
 */
export const StructuralSymbolTargetSchema = z.object({
  /** Top-level symbol name to replace. Must resolve to exactly one symbol. */
  symbol: z.string().min(1, 'symbol must be non-empty'),
});

export type StructuralSymbolTarget = z.infer<typeof StructuralSymbolTargetSchema>;

/**
 * Nested AST-node selector (t-066). Each entry names one named-child symbol
 * along an ancestor chain from the file root — e.g. `['MyClass', 'doThing']`
 * addresses method `doThing` on class `MyClass`. Resolution walks the
 * deterministic Tree-sitter named-child structure; exact byte offsets remain
 * Hoplon-owned.
 *
 * Must resolve to exactly one node. Zero or multiple matches surface as
 * `target_not_resolved`.
 */
export const StructuralSymbolPathTargetSchema = z.object({
  symbolPath: z
    .array(z.string().min(1, 'symbolPath entry must be non-empty'))
    .min(1, 'symbolPath must not be empty'),
});

export type StructuralSymbolPathTarget = z.infer<
  typeof StructuralSymbolPathTargetSchema
>;

/**
 * Structural target. Tree-sitter-backed symbol resolution is the only shipped
 * target mode — line-number ranges and raw byte offsets are intentionally not
 * exposed (t-071 contract: structural replacement targets are resolved from
 * deterministic parse structure, never from agent-supplied byte offsets).
 *
 * t-066 widens the union to also accept a nested symbol path for bounded
 * AST-node targeting beyond single top-level symbols; the resolver still
 * requires exactly one matching node per selector. Multi-target selections
 * are expressed as multiple `structural` ProposedChange entries targeting
 * the same file — each resolves against the running intermediate bytes.
 */
export const StructuralTargetSchema = z.union([
  StructuralSymbolTargetSchema,
  StructuralSymbolPathTargetSchema,
]);

export type StructuralTarget = z.infer<typeof StructuralTargetSchema>;

/**
 * Structural node/symbol-targeted change. Hoplon parses the current file
 * bytes, resolves the target to a single top-level symbol, and replaces that
 * symbol's byte range with `content`. Exact byte offsets stay Hoplon-owned.
 */
export const StructuralProposedChangeSchema = z
  .object({
    kind: z.literal('structural'),
    file: z.string().min(1, 'file must be non-empty'),
    target: StructuralTargetSchema,
    content: z.string().optional(),
    stagedContent: StagedContentRefSchema.optional(),
  })
  .refine(
    (v) => (v.content !== undefined) !== (v.stagedContent !== undefined),
    {
      message:
        'structural change must set exactly one of { content, stagedContent }',
    },
  );

export type StructuralProposedChange = z.infer<typeof StructuralProposedChangeSchema>;

/**
 * A single proposed file change. Additive union over three shapes:
 *
 *   - `patch` — ordered search/replace hunks (preferred for large multi-hunk
 *     edits; deterministic anchor resolution, no line numbers).
 *   - `structural` — Tree-sitter-backed symbol replacement (preferred when
 *     the edit is naturally a whole-symbol rewrite).
 *   - `full_file` — whole-file replacement. Retained as the compatibility
 *     fallback; legacy `{ file, content }` (no `kind`) is still accepted
 *     and treated as `full_file`.
 *
 * Patch and structural variants are resolved to one deterministic final
 * file state inside the session write path before any bytes touch disk; the
 * same rollback semantics that cover full-file writes cover every variant.
 */
export const ProposedChangeSchema = z.union([
  PatchProposedChangeSchema,
  StructuralProposedChangeSchema,
  FullFileProposedChangeSchema,
]);

export type ProposedChange = z.infer<typeof ProposedChangeSchema>;

/**
 * Request for dryRun — evaluate proposed changes in memory without touching disk.
 *
 * Mirrors AuditRequest + RevertRequest identity fields; swaps files[] with
 * proposedChanges[] for pure in-memory evaluation.
 */
export const DryRunRequestSchema = z.object({
  snapshotRefId: z.string().min(1, 'snapshotRefId must be non-empty'),
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /** Proposed changes to evaluate. At least one required. */
  proposedChanges: z.array(ProposedChangeSchema).min(1, 'proposedChanges must not be empty'),
  invariantBindings: z.array(DeclarativeInvariantBindingSchema).optional(),
});

export type DryRunRequest = z.infer<typeof DryRunRequestSchema>;
