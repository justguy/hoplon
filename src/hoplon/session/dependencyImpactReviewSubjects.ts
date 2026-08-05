/** Review-payload subject derivation for dependency-impact analysis. */

import type {
  DependencyImpactFileFallbackReason,
  DependencyImpactSubject,
} from '../contracts/dependencyImpact.js';
import type { ReviewFile, ReviewFileFallbackReason } from '../contracts/reviewPayload.js';

const REVIEW_FALLBACK_TO_SUBJECT_REASON: Record<
  ReviewFileFallbackReason,
  DependencyImpactFileFallbackReason
> = {
  no_code_intelligence: 'no_code_intelligence',
  parse_failure: 'parse_failure',
  unsupported_language: 'unsupported_language',
  no_enclosing_boundary: 'no_top_level_symbols_changed',
  new_file: 'new_file_no_symbols',
  deleted_file: 'deleted_file_no_symbols',
  binary_content: 'binary_content',
};

export function deriveReviewSubjects(
  reviewFiles: readonly ReviewFile[],
  opts?: { readonly markEditedBeforeBytesUnavailable?: boolean },
): DependencyImpactSubject[] {
  const subjects: DependencyImpactSubject[] = [];
  const seen = new Set<string>();

  for (const file of reviewFiles) {
    for (const boundary of file.boundaries) {
      if (boundary.symbol === null || boundary.symbolKind === null) continue;
      const key = `s::${file.path}::${boundary.symbol}::${boundary.byteRange[0]}::${boundary.byteRange[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push({
        kind: 'symbol',
        path: file.path,
        symbolName: boundary.symbol,
        symbolKind: boundary.symbolKind,
        byteRange: boundary.byteRange,
        changeMode: boundary.changeMode,
        origin: 'review_boundary',
      });
    }

    if (file.boundaries.length === 0 && file.fallback !== null) {
      const reason = REVIEW_FALLBACK_TO_SUBJECT_REASON[file.fallback.reason];
      const key = `f::${file.path}::${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push({
        kind: 'file',
        path: file.path,
        origin: 'review_boundary',
        reason,
      });
    }

    if (
      opts?.markEditedBeforeBytesUnavailable &&
      file.boundaries.length === 0 &&
      file.fallback === null
    ) {
      const key = `f::${file.path}::markEdited_no_before_bytes`;
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push({
        kind: 'file',
        path: file.path,
        origin: 'review_boundary',
        reason: 'markEdited_no_before_bytes',
      });
    }
  }

  return subjects;
}
