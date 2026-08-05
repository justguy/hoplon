/**
 * contracts/rollbackTemplate.ts — RollbackTemplate and
 * ExtractRollbackTemplateRequest Zod schemas + inferred types.
 *
 * LC11 — Phase 2 Stage C additive slice.
 *
 * RollbackTemplate is the result of engine.extractRollbackTemplate().
 * It composes extractStructuralTemplate (LC4) to produce a per-file
 * structural skeleton of the reverted state, alongside:
 *   - contractedChanges: what the manifest scope said to modify in the file
 *   - injectionHint: a directive sentence for the retry prompt, telling the
 *     agent to re-apply only the contracted change to the reverted baseline
 *
 * ## Purpose (recs §15.11)
 *   After revertUncontracted(), the agent retrying a failed piece lacks a
 *   concrete positive reference: "here is exactly how the file looked before
 *   your failed edit." The retry prompt typically only contains the violation
 *   description (negative signal). RollbackTemplate provides the structural
 *   baseline (positive signal) so the retry prompt is substantially more
 *   directive: what the file looked like + what to change + what to leave alone.
 *
 * ## Determinism (H7)
 *   files in RollbackTemplate are sorted alphabetically (ascending path).
 *   structuralSkeleton is derived from extractStructuralTemplate which is H7.
 *
 * ## H13 compliance
 *   injectionHint and contractedChanges are per-file prose directives, not raw
 *   source content. They are stored in the DTO (returned to caller) but never
 *   emitted in HoplonEvents. Events carry structure only (counts, status).
 *
 * ## snapshotRef
 *   The snapshotRef field echoes the snapshotRefId from the request,
 *   confirming which snapshot the structural skeleton was read from.
 */

import { z } from 'zod';
import { StructuralTemplateFileSchema } from './structuralTemplate.js';

// ---------------------------------------------------------------------------
// RollbackTemplateFile — per-file entry in the template
// ---------------------------------------------------------------------------

export const RollbackTemplateFileSchema = z.object({
  /** File path, relative to the fs adapter root. Sorted ascending in parent template. */
  path: z.string().min(1),
  /**
   * Structural skeleton of the file at the reverted state.
   * Serialized summary of exports, imports, and type declarations (from LC4).
   * Gives the agent a compact positive reference of the baseline structure.
   *
   * H13: this field is stored in the DTO and returned to caller;
   * it is never included in HoplonEvent payloads.
   */
  structuralSkeleton: z.string(),
  /**
   * Human-readable description of the contracted change scope for this file,
   * derived from the manifest entry. Tells the agent what the manifest
   * permitted for this file (e.g. "Modify symbol: processPayment; Modify symbol: validateInput").
   *
   * H13: stored in DTO only; not in events.
   */
  contractedChanges: z.string(),
  /**
   * Injection hint — directive sentence for the retry prompt.
   * Always non-empty (invariant LC11-H1).
   * Example: "Return to this structure, then apply ONLY the contracted change."
   *
   * H13: stored in DTO only; not in events.
   */
  injectionHint: z.string().min(1),
});

export type RollbackTemplateFile = z.infer<typeof RollbackTemplateFileSchema>;

// ---------------------------------------------------------------------------
// RollbackTemplate — top-level result
// ---------------------------------------------------------------------------

export const RollbackTemplateSchema = z.object({
  /**
   * Per-file rollback template entries.
   * Sorted by path ascending (H7 determinism).
   */
  files: z.array(RollbackTemplateFileSchema),
  /**
   * The snapshotRefId that the structural skeletons were read from.
   * Confirms which snapshot state the template represents.
   */
  snapshotRef: z.string().min(1),
  /**
   * ISO 8601 timestamp of when this template was generated.
   * Wall-clock time — not pinned to a git epoch.
   */
  generatedAt: z.string().min(1),
});

export type RollbackTemplate = z.infer<typeof RollbackTemplateSchema>;

// ---------------------------------------------------------------------------
// ExtractRollbackTemplateRequest
// ---------------------------------------------------------------------------

export const ExtractRollbackTemplateRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * The snapshot reference ID to read structural skeletons from.
   * Must be a committed snapshot (status === 'committed').
   * This is the snapshot that revertUncontracted() restored the files to.
   */
  snapshotRefId: z.string().min(1, 'snapshotRefId must be non-empty'),
  /**
   * Files to extract templates for, relative to the fs adapter root.
   * At least one file required.
   * Results are returned in sorted file order (H7 determinism).
   */
  files: z.array(z.string().min(1)).min(1, 'files must not be empty'),
  /**
   * Optional: per-file contracted change descriptions.
   * Keys are relative file paths; values are human-readable scope descriptions.
   * When provided, contractedChanges for each file is set from this map.
   * When absent for a file, contractedChanges defaults to a generic description.
   */
  contractedChangesMap: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type ExtractRollbackTemplateRequest = z.infer<
  typeof ExtractRollbackTemplateRequestSchema
>;

// ---------------------------------------------------------------------------
// Re-export StructuralTemplateFile for internal use
// ---------------------------------------------------------------------------

export type { StructuralTemplateFile } from './structuralTemplate.js';
export { StructuralTemplateFileSchema };
