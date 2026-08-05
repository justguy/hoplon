/**
 * adapters/dlp.ts — semantic-DLP adapter seam (t-026).
 *
 * Ships additively beside the existing `SecretScannerAdapter`. The secret
 * scanner remains the shipped default path for regex-based credential hunting;
 * the DLP seam targets classified content (PII / financial / healthcare /
 * source-code fragments) via a host-owned provider.
 *
 * Concrete implementations provided here:
 *   - `createNoopDlpAdapter()` — empty-findings default. Bound by the engine
 *     factory when no DLP adapter is supplied, so existing callers see zero
 *     behavior change.
 *   - `createMockPatternDlpAdapter()` — in-memory fixture-driven provider for
 *     targeted proof tests. Matches regex patterns per file and returns
 *     classification-tagged findings with redacted snippets.
 *
 * ## Bounded scope
 * - No external provider (host-owned; outside t-026 scope).
 * - No default blocking; policy mode defaults to `warn` at the operation seam.
 * - No coupling to `auditDiff` — findings surface via `SnapshotWarning` only.
 * - H13-compliant: adapter returns content-redacted findings; the operation
 *   boundary re-validates through Zod before emitting anything.
 */

import {
  DlpFindingSchema,
  type DlpFinding,
  type DlpClassification,
} from '../contracts/dlp.js';

/**
 * Structural input the adapter receives per scan. Intentionally declared as a
 * plain interface (rather than `z.infer<typeof DlpScanInputSchema>`) so the
 * `Uint8Array` type parameter stays compatible with `fs.read` return values
 * across TS lib versions. `DlpScanInputSchema` remains the parse-time source
 * of truth for host-side validation.
 */
export interface DlpScanInput {
  path: string;
  content: Uint8Array;
}

// ---------------------------------------------------------------------------
// DlpAdapter interface
// ---------------------------------------------------------------------------

export interface DlpAdapter {
  /**
   * Scan the given file for classified DLP findings.
   *
   * Implementations MUST return findings with the raw match redacted. The
   * operation boundary re-validates each finding through `DlpFindingSchema`
   * before surfacing it — an adapter that leaks raw values still cannot break
   * the H13 contract past the operation edge, but the adapter is expected to
   * redact at its own source for defense in depth.
   *
   * Returns an empty array when no patterns match. Never throws on a finding.
   * Adapter implementation errors (provider unavailable, config malformed)
   * surface as adapter errors at the operation boundary, not as findings.
   */
  scan(input: DlpScanInput, signal?: AbortSignal): Promise<DlpFinding[]>;
}

// ---------------------------------------------------------------------------
// Noop adapter — shipped default when no DLP provider is wired
// ---------------------------------------------------------------------------

export function createNoopDlpAdapter(): DlpAdapter {
  return {
    async scan(): Promise<DlpFinding[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Mock pattern adapter — fixture-driven provider for proof tests
// ---------------------------------------------------------------------------

export interface MockDlpRule {
  /** Rule identifier surfaced in the finding. */
  ruleId: string;
  /** Closed-enum classification assigned when this rule matches. */
  classification: DlpClassification;
  /**
   * Regex applied per line of the scanned file. Must carry the global flag if
   * the caller wants per-line match iteration; the adapter itself walks lines.
   */
  pattern: RegExp;
  /**
   * Optional confidence in [0, 1]. When present, attached verbatim to every
   * finding this rule produces.
   */
  confidence?: number;
}

export interface MockPatternDlpAdapterOptions {
  rules: readonly MockDlpRule[];
  /**
   * Optional per-path allow-list. When provided, only paths present in the
   * list are scanned; other paths return no findings. Defaults to scanning
   * every path the adapter sees.
   */
  onlyPaths?: readonly string[];
}

export function createMockPatternDlpAdapter(
  options: MockPatternDlpAdapterOptions,
): DlpAdapter {
  const allowPaths =
    options.onlyPaths !== undefined
      ? new Set(options.onlyPaths)
      : undefined;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return {
    async scan(input: DlpScanInput): Promise<DlpFinding[]> {
      if (allowPaths !== undefined && !allowPaths.has(input.path)) {
        return [];
      }
      const text = decoder.decode(input.content);
      const lines = text.split('\n');
      const findings: DlpFinding[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        for (const rule of options.rules) {
          const match = line.match(rule.pattern);
          if (match === null || match[0] === undefined) continue;
          const redactedSnippet = line.replace(
            rule.pattern,
            `[REDACTED_${rule.classification.toUpperCase()}]`,
          );
          const candidate: DlpFinding = {
            ruleId: rule.ruleId,
            classification: rule.classification,
            lineNumber: i + 1,
            redactedSnippet,
            ...(rule.confidence !== undefined
              ? { confidence: rule.confidence }
              : {}),
          };
          findings.push(DlpFindingSchema.parse(candidate));
        }
      }
      return findings;
    },
  };
}
