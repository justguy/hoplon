/**
 * session/unifiedDiff.ts — deterministic line-based unified diff (t-072).
 *
 * Emits standard unified-diff text:
 *
 *   --- a/<aLabel>
 *   +++ b/<bLabel>
 *   @@ -<aStart>,<aCount> +<bStart>,<bCount> @@
 *   <context/added/removed lines>
 *
 * Scope:
 *   - Pure string arithmetic over two input texts. No adapter calls, no I/O.
 *   - Line-based Longest-Common-Subsequence (LCS). Deterministic for any given
 *     `(a, b, contextLines, aLabel, bLabel)` tuple.
 *   - Only emits a diff body for files whose `a !== b`; an identical pair
 *     returns the headers and zero hunks so the caller can still anchor the
 *     header in the review payload.
 *
 * This module owns line-level diffing only. Boundary resolution (which symbol
 * the diff belongs to) lives in `session/reviewBoundaries.ts`; the review
 * payload composer stitches the two together.
 */

export interface UnifiedDiffOptions {
  readonly aLabel: string;
  readonly bLabel: string;
  /** Number of context lines around each hunk. Default: 3. */
  readonly contextLines?: number;
  /**
   * Include the `--- a/… / +++ b/…` header lines in the emitted diff. Defaults
   * to true. Callers rendering the diff inside a logical-boundary block pass
   * false so only the hunk bodies appear under the symbol header.
   */
  readonly includeHeader?: boolean;
}

/**
 * Generate a deterministic unified diff for two UTF-8 text inputs.
 *
 * If `a === b` returns the unchanged-file header when `includeHeader` is true
 * and an empty string otherwise; it never fabricates a hunk.
 */
export function renderUnifiedDiff(
  a: string,
  b: string,
  opts: UnifiedDiffOptions,
): string {
  const contextLines = opts.contextLines ?? 3;
  const includeHeader = opts.includeHeader ?? true;

  const aLines = splitLinesPreservingFinal(a);
  const bLines = splitLinesPreservingFinal(b);
  const edits = computeEdits(aLines, bLines);
  const hunks = groupHunks(edits, contextLines);
  const bodyLines: string[] = [];
  for (const hunk of hunks) {
    bodyLines.push(formatHunkHeader(hunk));
    for (const entry of hunk.entries) {
      bodyLines.push(formatEntry(entry));
    }
  }

  if (!includeHeader) {
    return bodyLines.join('\n');
  }

  const headerLines: string[] = [];
  headerLines.push(`--- a/${opts.aLabel}`);
  headerLines.push(`+++ b/${opts.bLabel}`);
  return [...headerLines, ...bodyLines].join('\n');
}

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

/**
 * Split a text into lines, preserving whether the final line had a trailing
 * newline. A trailing newline produces an empty final line so that
 * appending a line differs from not appending one in the diff.
 */
function splitLinesPreservingFinal(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(/\r?\n/);
  return parts;
}

// ---------------------------------------------------------------------------
// LCS edit script
// ---------------------------------------------------------------------------

type Op = 'eq' | 'del' | 'add';
interface Edit {
  readonly op: Op;
  readonly aIndex: number; // 0-based index into aLines, -1 for adds
  readonly bIndex: number; // 0-based index into bLines, -1 for deletes
  readonly text: string;
}

function computeEdits(aLines: readonly string[], bLines: readonly string[]): Edit[] {
  const n = aLines.length;
  const m = bLines.length;

  // Dynamic programming LCS. Values stored as 32-bit ints in a flat buffer for
  // memory efficiency on large inputs.
  const dp = new Int32Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (aLines[i] === bLines[j]) {
        dp[i * width + j] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * width + j] ?? 0;
        const right = dp[i * width + (j + 1)] ?? 0;
        dp[i * width + j] = down >= right ? down : right;
      }
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      edits.push({ op: 'eq', aIndex: i, bIndex: j, text: aLines[i]! });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      edits.push({ op: 'del', aIndex: i, bIndex: -1, text: aLines[i]! });
      i += 1;
    } else {
      edits.push({ op: 'add', aIndex: -1, bIndex: j, text: bLines[j]! });
      j += 1;
    }
  }
  while (i < n) {
    edits.push({ op: 'del', aIndex: i, bIndex: -1, text: aLines[i]! });
    i += 1;
  }
  while (j < m) {
    edits.push({ op: 'add', aIndex: -1, bIndex: j, text: bLines[j]! });
    j += 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Hunk grouping
// ---------------------------------------------------------------------------

interface Hunk {
  readonly aStart: number;
  readonly aCount: number;
  readonly bStart: number;
  readonly bCount: number;
  readonly entries: readonly Edit[];
}

function groupHunks(edits: readonly Edit[], contextLines: number): Hunk[] {
  if (edits.length === 0) return [];
  const hasDiff = edits.some((e) => e.op !== 'eq');
  if (!hasDiff) return [];

  const hunks: Hunk[] = [];
  let idx = 0;
  while (idx < edits.length) {
    if (edits[idx]!.op === 'eq') {
      idx += 1;
      continue;
    }

    // Extend backwards by up to `contextLines` equal lines.
    let startIdx = idx;
    let contextBefore = 0;
    while (startIdx > 0 && edits[startIdx - 1]!.op === 'eq' && contextBefore < contextLines) {
      startIdx -= 1;
      contextBefore += 1;
    }

    let endIdx = idx;
    while (endIdx < edits.length) {
      const entry = edits[endIdx]!;
      if (entry.op !== 'eq') {
        endIdx += 1;
        continue;
      }
      // Extend forward only while we are still within the trailing context budget
      // AND there is another change coming within 2*contextLines eq runs.
      let eqRun = 0;
      let probe = endIdx;
      while (probe < edits.length && edits[probe]!.op === 'eq') {
        eqRun += 1;
        probe += 1;
      }
      if (probe >= edits.length) {
        // trailing tail — include up to contextLines of trailing equals
        endIdx += Math.min(eqRun, contextLines);
        break;
      }
      if (eqRun <= contextLines * 2) {
        endIdx = probe;
        continue;
      }
      endIdx += contextLines;
      break;
    }

    const entries = edits.slice(startIdx, endIdx);
    const hunk = buildHunk(entries);
    if (hunk) hunks.push(hunk);
    idx = endIdx;
  }
  return hunks;
}

function buildHunk(entries: readonly Edit[]): Hunk | null {
  if (entries.length === 0) return null;

  // Determine aStart / bStart. Walk until the first entry that has an
  // a- or b-index to anchor.
  let aStart = 0;
  let bStart = 0;
  let foundStart = false;
  for (const e of entries) {
    if (e.aIndex >= 0) {
      aStart = e.aIndex + 1;
      foundStart = true;
      break;
    }
  }
  for (const e of entries) {
    if (e.bIndex >= 0) {
      bStart = e.bIndex + 1;
      if (foundStart) break;
      foundStart = true;
      break;
    }
  }

  let aCount = 0;
  let bCount = 0;
  for (const e of entries) {
    if (e.op === 'eq') {
      aCount += 1;
      bCount += 1;
    } else if (e.op === 'del') {
      aCount += 1;
    } else {
      bCount += 1;
    }
  }

  if (aCount === 0) aStart = Math.max(aStart, 0);
  if (bCount === 0) bStart = Math.max(bStart, 0);

  return { aStart, aCount, bStart, bCount, entries };
}

function formatHunkHeader(hunk: Hunk): string {
  // When count is 0 unified-diff convention uses a 0-count range with
  // `aStart` possibly 0 to signal empty side.
  return `@@ -${hunk.aStart},${hunk.aCount} +${hunk.bStart},${hunk.bCount} @@`;
}

function formatEntry(entry: Edit): string {
  if (entry.op === 'eq') return ` ${entry.text}`;
  if (entry.op === 'del') return `-${entry.text}`;
  return `+${entry.text}`;
}
