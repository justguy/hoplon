/**
 * operations/computeMinimalPatch.ts — LC5 computeMinimalPatch pure function.
 *
 * Replaces full-file regeneration with deterministic byte-range removal for
 * violations that have an extractable byte range.
 *
 * ## Phase 2 scope (REMOVE_NODES only)
 *
 * REMOVE_NODES action (patchable === true):
 *   Handles violations with a `byteRange` field:
 *     - 'out_of_scope_symbol'   — top-level symbol outside contracted scope
 *     - 'uncontracted_file'     — file modification outside manifest
 *       (no byteRange: whole-file removal, byte range = [0, content.byteLength])
 *     - 'DUPLICATE_TARGET'      — symbol that already exists (existingByteRange)
 *
 * PATCH_NOT_COMPUTABLE (patchable === false):
 *   Produced when any violation kind is SCOPE_ESCAPE or STRUCTURAL_CORRUPTION.
 *   These require snapshot-state reads (RESTORE_NODE) or structural reparse —
 *   deferred to Phase 3. Standard retry is the correct fallback.
 *
 * All other violation kinds (parse_failure, snapshot_missing, TARGET_NOT_FOUND,
 * SIGNATURE_MISMATCH, SIGNATURE_UNCERTAIN, IMPORT_*, PATH_ESCAPE) have no
 * extractable byte range for content removal; they fall to PATCH_NOT_COMPUTABLE
 * as well.
 *
 * ## H20 — UTF-8 byte offsets
 *   byteRange values from AuditViolation are already H20-normalised (UTF-8 byte
 *   offsets, not UTF-16 code units). Buffer.from(content, 'utf8').subarray() is
 *   safe to use directly.
 *
 * ## Determinism
 *   Same (content, violations) → byte-identical MinimalPatch (H7-style).
 *   violations are sorted by byteRange[0] ascending before merging, so input
 *   order does not affect output.
 *
 * ## Pure function — no I/O
 *   No filesystem calls, no adapter calls, no async needed.
 *   Caller supplies the proposed content string directly.
 *
 * ## Import wall
 *   Imports only from ../contracts/*. No adapters, no pipeline, no Phalanx layers.
 */

import type { AuditViolation } from '../contracts/audit.js';
import type {
  MinimalPatch,
  ComputeMinimalPatchRequest,
} from '../contracts/computeMinimalPatch.js';
import { ComputeMinimalPatchRequestSchema } from '../contracts/computeMinimalPatch.js';
import { ValidationError } from '../contracts/errors.js';

// ---------------------------------------------------------------------------
// Violation kind classification
// ---------------------------------------------------------------------------

/**
 * Violation kinds that are never byte-range removable (need snapshot read or
 * structural reparse). Any violation of these kinds forces PATCH_NOT_COMPUTABLE.
 */
const UNPATCHABLE_KINDS = new Set<AuditViolation['kind']>([
  'SCOPE_ESCAPE',
  'STRUCTURAL_CORRUPTION',
]);

/**
 * Extract the byte range [start, end) from a violation, if available.
 * Returns null for violations with no extractable range.
 *
 * NOTE on 'uncontracted_file':
 *   This violation covers the whole file but carries no byteRange field.
 *   We return null here; computeMinimalPatch handles it specially by
 *   treating the entire content as the violation range.
 */
function getByteRange(v: AuditViolation): [number, number] | null {
  if (v.kind === 'out_of_scope_symbol') {
    return v.byteRange as [number, number];
  }
  if (v.kind === 'DUPLICATE_TARGET') {
    return v.existingByteRange as [number, number];
  }
  if (v.kind === 'SCOPE_ESCAPE') {
    return v.byteRange as [number, number];
  }
  if (v.kind === 'STRUCTURAL_CORRUPTION') {
    return v.byteRange as [number, number];
  }
  // All other kinds: no byte range
  return null;
}

// ---------------------------------------------------------------------------
// Byte-range utilities
// ---------------------------------------------------------------------------

/**
 * Sort and merge overlapping or adjacent byte ranges.
 * Returns a new sorted, disjoint array of ranges.
 */
function mergeOverlappingRanges(
  ranges: Array<[number, number]>,
): Array<[number, number]> {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  // sorted is non-empty (we checked above); the cast is safe.
  const firstRange = sorted[0] as [number, number];
  const merged: Array<[number, number]> = [firstRange];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1] as [number, number];
    const curr = sorted[i] as [number, number];
    if (curr[0] <= last[1]) {
      // Overlapping or adjacent — extend the end if needed
      if (curr[1] > last[1]) {
        merged[merged.length - 1] = [last[0], curr[1]];
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Compute the complement of mergedRanges within [0, totalByteLength).
 * Returns the byte ranges to KEEP (i.e. everything NOT in mergedRanges).
 */
function invertByteRanges(
  mergedRanges: Array<[number, number]>,
  totalByteLength: number,
): Array<[number, number]> {
  const keep: Array<[number, number]> = [];
  let cursor = 0;

  for (const [start, end] of mergedRanges) {
    if (start > cursor) {
      keep.push([cursor, start]);
    }
    cursor = end;
  }

  if (cursor < totalByteLength) {
    keep.push([cursor, totalByteLength]);
  }

  return keep;
}

/**
 * Build a surgical retry prompt from a set of violations.
 * H13: mentions only structural position (kind + symbolName/path), no raw source content.
 */
function buildRetryPrompt(violations: AuditViolation[]): string {
  const directives = violations.map((v) => `${v.message} ${v.correction}`);
  return directives.join(' ');
}

// ---------------------------------------------------------------------------
// computeMinimalPatch — main entry point (sync, pure)
// ---------------------------------------------------------------------------

/**
 * Compute a minimal patch from proposed content and audit violations.
 *
 * SYNC — pure function over data. No I/O, no async, no adapter calls.
 *
 * Returns MinimalPatch:
 *   - patchable === true  → action === 'REMOVE_NODES', correctedContent populated.
 *   - patchable === false → action === 'PATCH_NOT_COMPUTABLE', correctedContent absent.
 *
 * @throws {ValidationError} kind 'invalid_manifest' — request fails Zod parse.
 */
export function computeMinimalPatch(req: ComputeMinimalPatchRequest): MinimalPatch {
  // -------------------------------------------------------------------------
  // Step 1: Validate request via Zod
  // -------------------------------------------------------------------------
  const parseResult = ComputeMinimalPatchRequestSchema.safeParse(req);
  if (!parseResult.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: 'validator',
        correlationId: 'computeMinimalPatch',
        cause: parseResult.error,
      },
      `computeMinimalPatch: invalid request: ${parseResult.error.message}`,
    );
  }
  const { content, violations } = parseResult.data;

  // -------------------------------------------------------------------------
  // Step 2: Classify violations
  // -------------------------------------------------------------------------
  const unpatchableViolations: AuditViolation[] = violations.filter(
    (v) => UNPATCHABLE_KINDS.has(v.kind),
  );

  // If ANY violation is PATCH_NOT_COMPUTABLE, the entire patch is not computable.
  // We include all violations (including patchable ones) in unpatchableViolations
  // so the caller has the complete picture for the retry prompt.
  if (unpatchableViolations.length > 0) {
    const retryPrompt = buildRetryPrompt(violations);
    return {
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE',
      violationRanges: [],
      keepRanges: [],
      retryPrompt,
      unpatchableViolations: violations,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Collect patchable byte ranges
  //
  // For 'out_of_scope_symbol' and 'DUPLICATE_TARGET': use the byteRange field.
  // For 'uncontracted_file': no byteRange — treat as whole-file violation
  //   (cover [0, content.byteLength)).
  // For all other violation kinds with no byteRange: treat as PATCH_NOT_COMPUTABLE
  //   for the individual violation but only fall through to PATCH_NOT_COMPUTABLE
  //   for the whole result if the entire violation set lacks patchable ranges.
  // -------------------------------------------------------------------------
  const contentBytes = Buffer.from(content, 'utf8');
  const totalByteLength = contentBytes.length;

  const rawRanges: Array<[number, number]> = [];
  const unrangedViolations: AuditViolation[] = [];

  for (const v of violations) {
    if (v.kind === 'uncontracted_file') {
      // Whole-file violation: remove entire content
      rawRanges.push([0, totalByteLength]);
    } else {
      const range = getByteRange(v);
      if (range !== null) {
        rawRanges.push(range);
      } else {
        // Violation kind with no byte range for this phase
        unrangedViolations.push(v);
      }
    }
  }

  // If no patchable range could be extracted at all → PATCH_NOT_COMPUTABLE
  if (rawRanges.length === 0) {
    const retryPrompt = buildRetryPrompt(violations);
    return {
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE',
      violationRanges: [],
      keepRanges: [],
      retryPrompt,
      unpatchableViolations: violations,
    };
  }

  // Partial case: some violations have ranges, some don't.
  // Still apply REMOVE_NODES for the ranged ones and include unranged in unpatchable.
  // The operation is still considered "patchable" (REMOVE_NODES) since at least one
  // fix can be applied, but the caller sees unpatchableViolations for the remainder.

  // -------------------------------------------------------------------------
  // Step 4: Merge overlapping ranges, invert to get keep ranges
  // -------------------------------------------------------------------------
  const mergedRanges = mergeOverlappingRanges(rawRanges);
  const keepRanges = invertByteRanges(mergedRanges, totalByteLength);

  // -------------------------------------------------------------------------
  // Step 5: Reconstruct corrected content from kept ranges
  // -------------------------------------------------------------------------
  const chunks: Buffer[] = keepRanges.map(([start, end]) =>
    Buffer.from(contentBytes.subarray(start, end)),
  );
  const correctedContent = Buffer.concat(chunks).toString('utf8');

  // -------------------------------------------------------------------------
  // Step 6: Build retry prompt
  // -------------------------------------------------------------------------
  const retryPrompt = buildRetryPrompt(violations);

  return {
    patchable: true,
    action: 'REMOVE_NODES',
    violationRanges: mergedRanges,
    keepRanges,
    correctedContent,
    retryPrompt,
    unpatchableViolations: unrangedViolations,
  };
}
