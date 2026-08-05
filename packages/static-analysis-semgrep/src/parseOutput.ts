/**
 * parseOutput.ts — Parse semgrep --json output into AnalysisFinding[]
 *
 * Semgrep JSON schema (relevant fields):
 * {
 *   "results": [
 *     {
 *       "check_id": "string",
 *       "path": "string",
 *       "extra": {
 *         "message": "string",
 *         "severity": "ERROR" | "WARNING" | "INFO",
 *         "lines": "string"
 *       },
 *       "start": { "line": number, "col": number, "offset": number },
 *       "end":   { "line": number, "col": number, "offset": number }
 *     }
 *   ],
 *   "errors": [
 *     { "code": number, "level": "string", "message": "string", "type": "string" }
 *   ]
 * }
 *
 * This module is LGPL-2.1-or-later because it is part of the
 * @phalanx/hoplon-static-analysis-semgrep plugin package.
 */

import type { AnalysisFinding } from '@phalanx/hoplon';

// ---------------------------------------------------------------------------
// Raw semgrep JSON shape — typed minimally; we only extract what we need.
// ---------------------------------------------------------------------------

interface SemgrepResult {
  check_id?: unknown;
  path?: unknown;
  extra?: {
    message?: unknown;
    severity?: unknown;
  };
}

interface SemgrepError {
  message?: unknown;
  type?: unknown;
  level?: unknown;
}

interface SemgrepOutput {
  results?: unknown;
  errors?: unknown;
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

/**
 * Map semgrep severity string to AnalysisFinding severity.
 * Semgrep uses "ERROR", "WARNING", "INFO" (all caps).
 * Unknown values fall back to "warning".
 */
export function mapSeverity(raw: unknown): AnalysisFinding['severity'] {
  if (typeof raw !== 'string') return 'warning';
  switch (raw.toUpperCase()) {
    case 'ERROR':
      return 'error';
    case 'WARNING':
      return 'warning';
    case 'INFO':
      return 'info';
    default:
      return 'warning';
  }
}

// ---------------------------------------------------------------------------
// Parse errors from semgrep output
// ---------------------------------------------------------------------------

/**
 * Extract parse/execution errors from semgrep JSON output.
 * Returns a list of descriptive error strings suitable for logging.
 */
export function extractSemgrepErrors(parsed: SemgrepOutput): string[] {
  const errors = parsed.errors;
  if (!Array.isArray(errors)) return [];
  const out: string[] = [];
  for (const err of errors) {
    const e = err as SemgrepError;
    const msg = typeof e.message === 'string' ? e.message : 'unknown semgrep error';
    const type = typeof e.type === 'string' ? e.type : '';
    out.push(type ? `[${type}] ${msg}` : msg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core parse function
// ---------------------------------------------------------------------------

/**
 * Parse a raw semgrep --json stdout string into an array of AnalysisFinding.
 *
 * Throws ParseSemgrepOutputError if the output is not valid JSON or does not
 * contain a "results" array. Callers should catch and wrap in AdapterError.
 *
 * @param stdout  - raw stdout from `semgrep --json`
 * @returns       - array of AnalysisFinding (may be empty on a clean run)
 */
export function parseSemgrepOutput(stdout: string): AnalysisFinding[] {
  let parsed: SemgrepOutput;
  try {
    parsed = JSON.parse(stdout) as SemgrepOutput;
  } catch (cause) {
    throw new ParseSemgrepOutputError(
      `semgrep output is not valid JSON: ${String(cause)}`,
      stdout,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'results')) {
    throw new ParseSemgrepOutputError(
      'semgrep JSON output missing required "results" field',
      stdout,
    );
  }

  const results = parsed.results;
  if (!Array.isArray(results)) {
    throw new ParseSemgrepOutputError(
      `semgrep "results" field must be an array; got ${typeof results}`,
      stdout,
    );
  }

  const findings: AnalysisFinding[] = [];
  for (const raw of results) {
    const result =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as SemgrepResult)
        : {};

    const path = typeof result.path === 'string' ? result.path : '';
    const rule = typeof result.check_id === 'string' ? result.check_id : 'unknown-rule';
    const extra = result.extra ?? {};
    const message = typeof extra.message === 'string' ? extra.message : '';
    const severity = mapSeverity(extra.severity);

    findings.push({ path, rule, message, severity });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when semgrep stdout cannot be parsed into AnalysisFinding[].
 * Callers should catch this and wrap in an AdapterError.
 */
export class ParseSemgrepOutputError extends Error {
  override readonly name = 'ParseSemgrepOutputError';
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.rawOutput = rawOutput;
  }
}
