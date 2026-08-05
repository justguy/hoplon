/**
 * parseOutput.ts — Parse gitleaks JSON output into GitleaksFinding[].
 *
 * Gitleaks writes its findings as a JSON array to stdout when invoked with
 * `--report-format json --report-path -`. This module converts that raw JSON
 * into the `GitleaksFinding` shape expected by the GL1 adapter seam.
 *
 * ## Gitleaks JSON shape (per gitleaks v8 schema)
 *
 * ```json
 * [
 *   {
 *     "RuleID": "aws-access-token",
 *     "StartLine": 3,
 *     "Line": "const key = \"AKIAIOSFODNN7EXAMPLE\";",
 *     "Secret": "AKIAIOSFODNN7EXAMPLE",
 *     ...
 *   }
 * ]
 * ```
 *
 * Unknown fields are ignored. Required fields missing → `ParseOutputError`.
 * Empty output (`""` or `"[]"`) → empty array.
 *
 * ## Error policy
 * - Malformed JSON → `ParseOutputError`
 * - Top-level value is not an array → `ParseOutputError`
 * - Individual finding missing required fields → `ParseOutputError` (fail fast;
 *   a partial result is worse than surfacing the bug)
 */

import type { GitleaksFinding } from '@phalanx/hoplon';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when gitleaks JSON output cannot be parsed into findings.
 * Carries the offending raw output as `rawOutput` for diagnostics.
 */
export class ParseOutputError extends Error {
  /** The raw string that failed to parse. */
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string, cause?: unknown) {
    super(message);
    this.name = 'ParseOutputError';
    this.rawOutput = rawOutput;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal raw-finding type (gitleaks v8 JSON schema)
// ---------------------------------------------------------------------------

// Raw JSON object treated as a plain record; we access fields by name after
// runtime type-checking in validateRawFinding.
type RawFindingRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function validateRawFinding(raw: unknown, index: number): GitleaksFinding {
  if (!isObject(raw)) {
    throw new ParseOutputError(
      `Finding at index ${index} is not an object`,
      JSON.stringify(raw),
    );
  }

  const finding = raw as RawFindingRecord;

  const ruleId = finding['RuleID'];
  if (typeof ruleId !== 'string' || ruleId.length === 0) {
    throw new ParseOutputError(
      `Finding at index ${index} missing required string field "RuleID"`,
      JSON.stringify(raw),
    );
  }

  const startLine = finding['StartLine'];
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    throw new ParseOutputError(
      `Finding at index ${index} missing required positive-integer field "StartLine"`,
      JSON.stringify(raw),
    );
  }

  const line = finding['Line'];
  if (typeof line !== 'string') {
    throw new ParseOutputError(
      `Finding at index ${index} missing required string field "Line"`,
      JSON.stringify(raw),
    );
  }

  const secret = finding['Secret'];
  if (typeof secret !== 'string') {
    throw new ParseOutputError(
      `Finding at index ${index} missing required string field "Secret"`,
      JSON.stringify(raw),
    );
  }

  return {
    ruleId,
    lineNumber: startLine,
    line,
    secret,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the raw stdout string from `gitleaks detect --report-format json
 * --report-path -` into an array of `GitleaksFinding` objects.
 *
 * Findings are returned sorted by `lineNumber` ascending, then by `ruleId`
 * ascending for determinism when multiple findings share the same line.
 *
 * @throws {ParseOutputError} if the output is not valid JSON, not a JSON
 *   array, or any finding is missing required fields.
 */
export function parseGitleaksOutput(rawOutput: string): GitleaksFinding[] {
  const trimmed = rawOutput.trim();

  // Empty output means no findings (gitleaks exits 0 with empty output when
  // no leaks found and report-path is '-').
  if (trimmed.length === 0 || trimmed === 'null') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ParseOutputError(
      'Failed to parse gitleaks output as JSON',
      rawOutput,
      err,
    );
  }

  // Gitleaks outputs `[]` when no findings — treat as empty array.
  if (Array.isArray(parsed) && parsed.length === 0) {
    return [];
  }

  if (!Array.isArray(parsed)) {
    throw new ParseOutputError(
      `Expected gitleaks output to be a JSON array, got: ${typeof parsed}`,
      rawOutput,
    );
  }

  const findings: GitleaksFinding[] = parsed.map((item, index) =>
    validateRawFinding(item, index),
  );

  // Sort by lineNumber ascending, then ruleId ascending for determinism.
  findings.sort((a, b) => {
    if (a.lineNumber !== b.lineNumber) {
      return a.lineNumber - b.lineNumber;
    }
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  return findings;
}
