import type { SeeCodebaseResult } from '../contracts/seeCodebase.js';
import {
  buildTokenTelemetry,
  type TokenTelemetry,
} from '../contracts/tokenTelemetry.js';

export function buildSeeCodebaseTokenTelemetry(args: {
  results: readonly SeeCodebaseResult[];
  bytesReturned: number;
}): TokenTelemetry {
  return buildTokenTelemetry({
    rawBytesConsidered: estimateRawBytesConsidered(args.results),
    returnedBytes: args.bytesReturned,
    notes: tokenTelemetryNotes(args.results),
  });
}

function estimateRawBytesConsidered(
  results: readonly SeeCodebaseResult[],
): number | null {
  let total = 0;
  for (const result of results) {
    if (result.kind === 'raw_file') {
      total += result.originalBytes ?? result.bytes;
      continue;
    }
    if (result.kind === 'edit_slice' && result.tokenTelemetry !== undefined) {
      const rawBytes = result.tokenTelemetry.rawBytesConsidered;
      if (rawBytes === null) return null;
      total += rawBytes;
      continue;
    }
    return null;
  }
  return total;
}

function tokenTelemetryNotes(results: readonly SeeCodebaseResult[]): string[] {
  const notes: string[] = [];
  if (
    results.some((result) =>
      result.kind !== 'raw_file' &&
      (result.kind !== 'edit_slice' || result.tokenTelemetry === undefined),
    )
  ) {
    notes.push('raw bytes considered unavailable for one or more results');
  }
  if (results.some((result) => 'truncated' in result && result.truncated)) {
    notes.push('one or more results were truncated by caller-requested bounds');
  }
  return notes;
}
