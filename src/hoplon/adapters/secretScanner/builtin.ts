/**
 * adapters/secretScanner/builtin.ts — createBuiltinRegexScanner factory.
 *
 * Produces a SecretScannerAdapter that runs a configurable set of regex
 * patterns against file content decoded as UTF-8. Detection is non-blocking:
 * the adapter always returns findings (possibly empty) and never throws on a
 * normal scan — including on invalid/non-UTF-8 byte sequences.
 *
 * ## Non-UTF-8 behavior
 * Content is decoded with `{ fatal: false }` (lossy mode). Invalid byte
 * sequences are replaced by U+FFFD (the Unicode replacement character).
 * Pattern matching then continues on the replacement-char-substituted string.
 * This means:
 *   - The adapter never throws on non-UTF-8 input.
 *   - Binary files with isolated UTF-8 segments may still produce matches.
 *   - Secrets embedded in otherwise-invalid byte sequences may not be detected
 *     if the invalid bytes straddle the match; this is an accepted trade-off
 *     for Phase 1's regex-only scanner (Gitleaks handles binary better).
 *
 * ## Performance
 * Each regex is compiled once at factory construction time (not per scan).
 * A fresh clone (same source + flags) is created per scan so that `lastIndex`
 * resets are isolated — this avoids the classic "stateful regex" bug where a
 * global regex used with exec() remembers its lastIndex across calls.
 * Cloning is O(1) (RegExp constructor from source/flags) and adds negligible
 * overhead versus the per-match cost.
 *
 * ## Redaction format
 * Each match on a line is replaced with `[REDACTED_<PATTERN_NAME>]`. If a
 * single line has multiple matches, each is replaced independently. The raw
 * matched string never appears in any SecretFinding field.
 */

import type { SecretScannerAdapter, SecretFinding } from '../secretScanner.js';
import { BUILTIN_PATTERNS, type BuiltinPattern } from './patterns.js';

// ---------------------------------------------------------------------------
// Decoder (module-level singleton; TextDecoder is stateless)
// ---------------------------------------------------------------------------

const LOSSY_DECODER = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Line utilities
// ---------------------------------------------------------------------------

/**
 * Split content into lines, normalising both `\r\n` and bare `\r` to `\n`
 * before splitting. This ensures line numbers are correct for Windows-style
 * CRLF files.
 *
 * Returns the normalised string AND the array of lines. The normalised string
 * is used for pattern matching (so positions within it can be mapped back to
 * lines via the line array).
 */
function splitLines(text: string): { normalised: string; lines: string[] } {
  // Replace \r\n → \n, then bare \r → \n
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalised.split('\n');
  return { normalised, lines };
}

/**
 * Given a character offset in `normalised`, return the 1-indexed line number.
 * Uses a linear scan; acceptable for Phase 1 (content is decoded to string
 * once per scan, offsets are inspected per match).
 */
function lineNumberAtOffset(normalised: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (normalised[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Replace all occurrences of `matchedText` in `line` with the redaction
 * placeholder for `patternName`.
 *
 * Using replaceAll ensures that if the same secret appears multiple times on
 * one line, all occurrences in the snippet are redacted (the finding still
 * maps to a single match position, but the snippet shown to the caller is
 * fully clean).
 */
function redactLine(line: string, matchedText: string, patternName: string): string {
  const placeholder = `[REDACTED_${patternName}]`;
  // Use a literal-string replaceAll to avoid regex special-char issues in
  // the matched text (e.g. a matched value containing "$1" would mis-behave
  // with a regex replacement).
  return line.split(matchedText).join(placeholder);
}

// ---------------------------------------------------------------------------
// Scanner factory
// ---------------------------------------------------------------------------

export interface BuiltinRegexScannerOptions {
  /**
   * Optional override for the pattern set. When provided, this set is used
   * exclusively (the built-in patterns are not merged in). Pass an empty
   * array to perform no scanning.
   */
  patterns?: Array<BuiltinPattern>;
}

/**
 * Create a SecretScannerAdapter that runs a built-in (or caller-supplied)
 * set of regex patterns against file content.
 *
 * Each pattern's regex is cloned once per scan call (to reset lastIndex) from
 * the compiled RegExp stored on the pattern. Factory construction is O(n)
 * where n = number of patterns; per-scan cost is O(patterns × content_length).
 *
 * @param opts.patterns — Optional replacement pattern set. Defaults to
 *   BUILTIN_PATTERNS when omitted.
 */
export function createBuiltinRegexScanner(
  opts?: BuiltinRegexScannerOptions,
): SecretScannerAdapter {
  // Capture the resolved pattern array at construction time. Each regex is
  // already compiled; cloning per-scan is cheap.
  const patterns: ReadonlyArray<BuiltinPattern> =
    opts?.patterns !== undefined ? opts.patterns : BUILTIN_PATTERNS;

  return {
    async scan(req: { path: string; content: Uint8Array }): Promise<SecretFinding[]> {
      // Decode content lossily. Invalid byte sequences become U+FFFD.
      const raw = LOSSY_DECODER.decode(req.content);

      if (raw.length === 0) {
        return [];
      }

      // Normalise line endings once and build the line array.
      const { normalised, lines } = splitLines(raw);

      const findings: SecretFinding[] = [];

      for (const pattern of patterns) {
        // Clone the regex to reset lastIndex for this scan's content.
        // source and flags are copied verbatim; the clone is not stored back.
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);

        let match: RegExpExecArray | null;
        while ((match = re.exec(normalised)) !== null) {
          const matchedText = match[0];

          // Prevent infinite loop on zero-length matches (shouldn't happen
          // with the built-in patterns, but defensive guard for custom ones).
          if (matchedText.length === 0) {
            re.lastIndex++;
            continue;
          }

          const matchOffset = match.index;
          const lineNum = lineNumberAtOffset(normalised, matchOffset);

          // lines is 0-indexed; lineNum is 1-indexed.
          const lineIndex = lineNum - 1;
          const originalLine = lines[lineIndex] ?? '';

          const redactedSnippet = redactLine(originalLine, matchedText, pattern.name);

          findings.push({
            patternName: pattern.name,
            lineNumber: lineNum,
            redactedSnippet,
          });
        }
      }

      return findings;
    },
  };
}
