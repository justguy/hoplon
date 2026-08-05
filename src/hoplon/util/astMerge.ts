/**
 * util/astMerge.ts — t-040 Multi-agent AST merge.
 *
 * Merges a set of AST-level edits from multiple agents into either a
 * successful merged result (one or more file contents with all edits applied)
 * or a conflict descriptor list when non-equivalent overlapping edits exist.
 *
 * ## Algorithm
 *
 *   1. Group edits by filePath.
 *   2. Within each file:
 *      a. Detect pairs of edits whose byteRanges overlap (same predicate as
 *         subFileAst.ts: A.start < B.end && B.start < A.end).
 *      b. For overlapping pairs: compare replacements via `equivalenceCheck`
 *         (defaults to byte-equality).
 *         - Equivalent replacement → deduplicate (keep first-seen); no conflict.
 *         - Non-equivalent replacement → record as ConflictDescriptor.
 *      c. For non-overlapping edits: apply all, right-to-left by byteRange[0]
 *         (descending start-byte order) so earlier byte-offsets stay valid.
 *   3. If any file produced conflicts, return `{ kind: 'conflict', conflicts }`.
 *      If all files produced clean merges, return `{ kind: 'success', merged }`.
 *
 * ## Invariants
 *
 *   H7  — Pure function. Same edits in any input order → byte-identical output.
 *          Determinism is guaranteed by the explicit right-to-left application
 *          ordering and lexicographic file-path ordering within the result map.
 *   H13 — No I/O; no events emitted; no content enters any log or event stream.
 *
 * ## Import wall
 *
 *   Imports only from node:crypto (for the default byte-equality comparison,
 *   which needs no crypto but is here for future extension).
 *   Never imports adapters, engine, contracts, pipeline, or Phalanx layers.
 *   The byteRange overlap predicate is re-implemented locally (not imported from
 *   adapters/lockProvider/subFileAst.ts) to preserve the adapter/util boundary.
 *
 * ## No new npm dependencies.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

import {
  defaultEquivalenceCheck,
  mergeFileEdits,
} from './astMergeFile.js';
import type {
  AstEdit,
  ConflictDescriptor,
  MergeAstEditsOptions,
  MergeResult,
} from './astMergeTypes.js';

export type {
  AstEdit,
  ConflictDescriptor,
  MergeAstEditsOptions,
  MergeResult,
  MergeResultConflict,
  MergeResultSuccess,
} from './astMergeTypes.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge AST-level edits from multiple agents.
 *
 * @param edits           All proposed edits (any order; any number of files).
 * @param originalContent Map of filePath → original file content string.
 *                        Files mentioned in `edits` that are absent from this
 *                        map are treated as empty strings (new-file creation).
 * @param opts            Optional configuration.
 *
 * @returns
 *   `{ kind: 'success', merged }` — all edits applied cleanly.
 *   `{ kind: 'conflict', conflicts }` — one or more non-resolvable overlaps.
 *
 * ## H7 — Determinism guarantee
 *
 * Given the same `edits` array (same elements, same order), the output is
 * byte-identical on every call.  The right-to-left application order is
 * explicit and stable.  The cluster representative selection uses the lowest
 * index in the input `edits` array (first-seen wins) which is deterministic
 * for a fixed input order.
 *
 * Callers that collect edits from concurrent agents must sort or deduplicate
 * the input before calling if they want order-independent results.
 *
 * ## H13 — Content-free events
 *
 * This function emits no events, logs, or telemetry.  Content flows only via
 * the returned `MergeResult` DTO.
 */
export async function mergeAstEdits(
  edits: AstEdit[],
  originalContent: Record<string, string>,
  opts?: MergeAstEditsOptions,
): Promise<MergeResult> {
  const equivalenceCheck = opts?.equivalenceCheck ?? defaultEquivalenceCheck;

  // Empty edit list — trivially successful, empty merged map.
  if (edits.length === 0) {
    return { kind: 'success', merged: {} };
  }

  // Group edits by filePath, preserving input order within each group (H7).
  const byFile = new Map<string, AstEdit[]>();
  for (const edit of edits) {
    const group = byFile.get(edit.filePath);
    if (group === undefined) {
      byFile.set(edit.filePath, [edit]);
    } else {
      group.push(edit);
    }
  }

  // Process each file.  File order in the result map is insertion order
  // (which reflects first-edit-seen order in the input array — deterministic
  // for a fixed input).
  const allConflicts: ConflictDescriptor[] = [];
  const mergedMap: Record<string, string> = {};

  for (const [filePath, fileEdits] of byFile) {
    const content = originalContent[filePath] ?? '';
    const result = await mergeFileEdits(filePath, fileEdits, content, equivalenceCheck);

    if (result.conflicts.length > 0) {
      allConflicts.push(...result.conflicts);
    } else {
      // mergedContent is always set when conflicts is empty.
      mergedMap[filePath] = result.mergedContent!;
    }
  }

  if (allConflicts.length > 0) {
    return { kind: 'conflict', conflicts: allConflicts };
  }

  return { kind: 'success', merged: mergedMap };
}
