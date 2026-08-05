/**
 * contracts/computeMinimalPatch.ts — MinimalPatch result and ComputeMinimalPatchRequest schemas.
 *
 * PHASE 2 SCOPE (LC5):
 *   - action: 'REMOVE_NODES' — deterministic byte-range removal.
 *       Covers 'out_of_scope_symbol' and 'uncontracted_file' violations (~70% of all blocks).
 *       correctedContent is always populated when action === 'REMOVE_NODES'.
 *   - action: 'PATCH_NOT_COMPUTABLE' — produced when any violation kind is SCOPE_ESCAPE or
 *       STRUCTURAL_CORRUPTION, which require snapshot-state reads or structural reparse.
 *       patchable === false; correctedContent is absent; retryPrompt guides the retry.
 *
 * PHASE 3 (deferred):
 *   - action: 'RESTORE_NODE' — SCOPE_ESCAPE case: restore node to snapshotted state via
 *       git.readBlob + byte-range splice.
 *
 * ## H20 guarantee
 *   All byte positions in violationRanges and keepRanges are UTF-8 byte offsets
 *   (matching Buffer.byteLength semantics). They come from AuditViolation.byteRange which
 *   is already H20-normalised by charPosToBytePos in the tree-sitter adapter.
 *
 * ## Determinism
 *   Same (content, violations) → byte-identical MinimalPatch. violationRanges are sorted
 *   ascending, overlaps merged, keepRanges are the complement.
 */

import { z } from 'zod';
import { AuditViolationSchema } from './audit.js';

// ---------------------------------------------------------------------------
// MinimalPatchAction
// ---------------------------------------------------------------------------

export const MinimalPatchActionSchema = z.enum([
  'REMOVE_NODES',
  'RESTORE_NODE',
  'PATCH_NOT_COMPUTABLE',
]);
export type MinimalPatchAction = z.infer<typeof MinimalPatchActionSchema>;

// ---------------------------------------------------------------------------
// MinimalPatch — the result returned by computeMinimalPatch
// ---------------------------------------------------------------------------

export const MinimalPatchSchema = z.object({
  /**
   * true iff action === 'REMOVE_NODES' (deterministic fix available).
   * false iff action === 'PATCH_NOT_COMPUTABLE' (fallback to retry prompt).
   */
  patchable: z.boolean(),

  /**
   * The action to apply:
   *   'REMOVE_NODES'        — remove violation byte ranges from content.
   *   'RESTORE_NODE'        — Phase 3 deferred.
   *   'PATCH_NOT_COMPUTABLE'— cannot deterministically fix (SCOPE_ESCAPE, STRUCTURAL_CORRUPTION).
   */
  action: MinimalPatchActionSchema,

  /**
   * UTF-8 byte-range pairs [start, end) to remove/replace. Sorted ascending, non-overlapping.
   * Empty when action === 'PATCH_NOT_COMPUTABLE'.
   */
  violationRanges: z.array(z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ])),

  /**
   * UTF-8 byte-range pairs [start, end) to keep. Complement of violationRanges over content length.
   * Empty when action === 'PATCH_NOT_COMPUTABLE'.
   */
  keepRanges: z.array(z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ])),

  /**
   * The reconstructed source after removing violation ranges.
   * Only present when action === 'REMOVE_NODES'.
   */
  correctedContent: z.string().optional(),

  /**
   * Surgical retry prompt for cases where an LLM correction is still needed.
   * Always non-empty — even REMOVE_NODES emits a confirmation prompt.
   */
  retryPrompt: z.string().min(1),

  /**
   * Violations that could not be mechanically patched (action !== 'REMOVE_NODES').
   * Empty when all violations are patchable. Non-empty when action === 'PATCH_NOT_COMPUTABLE'.
   */
  unpatchableViolations: z.array(AuditViolationSchema),
});

export type MinimalPatch = z.infer<typeof MinimalPatchSchema>;

// ---------------------------------------------------------------------------
// ComputeMinimalPatchRequest
// ---------------------------------------------------------------------------

export const ComputeMinimalPatchRequestSchema = z.object({
  /**
   * UTF-8 string of the proposed file content that triggered the BLOCK.
   * computeMinimalPatch performs no I/O — caller supplies content directly.
   */
  content: z.string(),

  /**
   * The AuditViolation array from the BLOCK AuditResult.
   * Must be non-empty (a PASS result has no violations to patch).
   */
  violations: z.array(AuditViolationSchema).min(1),
});

export type ComputeMinimalPatchRequest = z.infer<typeof ComputeMinimalPatchRequestSchema>;
