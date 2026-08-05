/** Resolve changed files to bounded top-level review symbols or an honest fallback. */

import type {
  CodeIntelligenceAdapter,
  Symbol as CiSymbol,
} from '../adapters/codeIntelligence.js';
import type { ReviewBoundary, ReviewFileFallback } from '../contracts/reviewPayload.js';
import {
  buildBoundary,
  buildFallback,
  classifyPair,
  collectTouchedSymbolNames,
  decodeOrNull,
  errorMessage,
  groupByName,
  isCoveredLanguage,
  parseTopLevelSymbols,
  reasonForParseFailure,
  sliceBytesAsText,
} from './reviewBoundaryHelpers.js';

export interface ResolveBoundariesOptions {
  readonly path: string;
  readonly before: Uint8Array | null;
  readonly after: Uint8Array | null;
  readonly codeIntelligence: CodeIntelligenceAdapter | null;
  readonly contextLines: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ResolvedBoundaries {
  readonly boundaries: ReviewBoundary[];
  readonly fallback: ReviewFileFallback | null;
}

export async function resolveReviewBoundaries(
  opts: ResolveBoundariesOptions,
): Promise<ResolvedBoundaries> {
  const { path, before, after, codeIntelligence, contextLines } = opts;

  const beforeText = decodeOrNull(before);
  const afterText = decodeOrNull(after);

  // New file
  if (before === null && after !== null) {
    const fallback = buildFallback({
      reason: 'new_file',
      message: `"${path}" is a new file; review payload emits the full add-diff.`,
      before: '',
      after: afterText ?? '',
      path,
      contextLines,
    });
    // Try to render one bounded block per top-level symbol in the new file;
    // that still looks like "add X, add Y" rather than a raw file dump.
    if (codeIntelligence !== null && isCoveredLanguage(path)) {
      try {
        const afterSymbols = await parseTopLevelSymbols(
          codeIntelligence,
          path,
          after,
          opts.signal,
        );
        if (afterSymbols.length > 0) {
          const boundaries: ReviewBoundary[] = [];
          for (const sym of afterSymbols) {
            const afterSlice = sliceBytesAsText(after, sym.byteRange);
            boundaries.push(
              buildBoundary({
                symbol: sym,
                side: 'after',
                changeMode: 'added',
                before: '',
                after: afterSlice,
                afterText: afterText ?? '',
                contextLines,
              }),
            );
          }
          return { boundaries, fallback: null };
        }
      } catch {
        // fall through to file-level fallback
      }
    }
    return { boundaries: [], fallback };
  }

  // Deleted file
  if (before !== null && after === null) {
    const fallback = buildFallback({
      reason: 'deleted_file',
      message: `"${path}" was deleted; review payload emits the full remove-diff.`,
      before: beforeText ?? '',
      after: '',
      path,
      contextLines,
    });
    return { boundaries: [], fallback };
  }

  if (before === null || after === null) {
    // Shouldn't happen — both null means unchanged nothing to review.
    return { boundaries: [], fallback: null };
  }

  if (beforeText === null || afterText === null) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: 'binary_content',
        message: `"${path}" could not be decoded as UTF-8; review payload falls back to a bytes-changed marker.`,
        before: '',
        after: '',
        path,
        contextLines: 0,
      }),
    };
  }

  if (beforeText === afterText) {
    // No textual change — nothing to review.
    return { boundaries: [], fallback: null };
  }

  if (codeIntelligence === null) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: 'no_code_intelligence',
        message: `No code-intelligence adapter available for "${path}"; review payload falls back to a file-level diff.`,
        before: beforeText,
        after: afterText,
        path,
        contextLines,
      }),
    };
  }

  if (!isCoveredLanguage(path)) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: 'unsupported_language',
        message: `"${path}" is not covered by the code-intelligence default; review payload falls back to a file-level diff.`,
        before: beforeText,
        after: afterText,
        path,
        contextLines,
      }),
    };
  }

  let beforeSymbols: CiSymbol[] = [];
  let afterSymbols: CiSymbol[] = [];
  try {
    beforeSymbols = await parseTopLevelSymbols(
      codeIntelligence,
      path,
      before,
      opts.signal,
    );
    afterSymbols = await parseTopLevelSymbols(
      codeIntelligence,
      path,
      after,
      opts.signal,
    );
  } catch (err) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: reasonForParseFailure(err),
        message: `Boundary resolution failed for "${path}": ${errorMessage(err)}`,
        before: beforeText,
        after: afterText,
        path,
        contextLines,
      }),
    };
  }

  const beforeByName = groupByName(beforeSymbols);
  const afterByName = groupByName(afterSymbols);

  const touchedNames = collectTouchedSymbolNames(
    beforeByName,
    afterByName,
    before,
    after,
  );

  if (touchedNames.length === 0) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: 'no_enclosing_boundary',
        message: `"${path}" has textual changes but no enclosing top-level symbol boundary; review payload falls back to a file-level diff.`,
        before: beforeText,
        after: afterText,
        path,
        contextLines,
      }),
    };
  }

  const boundaries: ReviewBoundary[] = [];
  for (const name of touchedNames) {
    const beforeMatches = beforeByName.get(name) ?? [];
    const afterMatches = afterByName.get(name) ?? [];

    // Multiple same-name symbols on either side collapse down to one paired
    // boundary (source order) — we don't try to disambiguate overloads in
    // this slice. The `touchedNames` gating keeps this to symbols that
    // actually differ.
    const count = Math.max(beforeMatches.length, afterMatches.length);
    for (let idx = 0; idx < count; idx += 1) {
      const beforeSym = beforeMatches[idx] ?? null;
      const afterSym = afterMatches[idx] ?? null;
      const { changeMode, side, symbol } = classifyPair(beforeSym, afterSym);
      const beforeSlice = beforeSym ? sliceBytesAsText(before, beforeSym.byteRange) : '';
      const afterSlice = afterSym ? sliceBytesAsText(after, afterSym.byteRange) : '';
      if (beforeSlice === afterSlice) continue;

      boundaries.push(
        buildBoundary({
          symbol,
          side,
          changeMode,
          before: beforeSlice,
          after: afterSlice,
          afterText,
          beforeText,
          contextLines,
        }),
      );
    }
  }

  if (boundaries.length === 0) {
    return {
      boundaries: [],
      fallback: buildFallback({
        reason: 'no_enclosing_boundary',
        message: `"${path}" has textual changes but no touched top-level symbol produced a diff; review payload falls back to a file-level diff.`,
        before: beforeText,
        after: afterText,
        path,
        contextLines,
      }),
    };
  }

  return { boundaries, fallback: null };
}

// ---------------------------------------------------------------------------
// Internal helpers
