/**
 * adapters/secretScanner/gitleaks.ts — Gitleaks-backed SecretScannerAdapter.
 *
 * Implements the SecretScannerAdapter contract via an injected GitleaksProvider
 * seam. The provider handles the actual scanning; this adapter enforces
 * the contract properties that must hold regardless of provider:
 *   - Redaction: raw secret values NEVER appear in emitted SecretFinding fields.
 *     Every match value is replaced with `[REDACTED]` before being returned.
 *   - H13 content-free: no scanned text flows into operational events.
 *   - Non-blocking: scan errors are surfaced as empty findings, never thrown.
 *
 * ## Real gitleaks CLI wiring (GL2, Wave 2)
 * This file implements the in-core interface + adapter only. The real gitleaks
 * binary integration (shelling out to `gitleaks detect --no-git`) lives in
 * `@phalanx/hoplon-secret-scanner-gitleaks` (GL2), a separate plugin package.
 * Consumers inject a real `GitleaksProvider` from that package; tests inject
 * `MockGitleaksProvider` from `./mockGitleaksProvider.js`.
 *
 * ## Redaction guarantee
 * The provider returns `GitleaksFinding` objects that include the raw `secret`
 * value. The adapter NEVER passes that value through to `SecretFinding`. It:
 *   1. Uses the `secret` value to locate the match in the decoded line (for
 *      accurate snippet reconstruction).
 *   2. Replaces every occurrence of the raw value in the snippet with `[REDACTED]`.
 *   3. Does NOT store the raw value in any returned or emitted field.
 *
 * ## configPath
 * When `configPath` is provided at construction time, it is forwarded to every
 * `scanText` call. This allows the caller to supply a gitleaks TOML rule file
 * that overrides the default rule set (honoring the gitleaks configuration
 * abstraction from GL2's design).
 */

import type { SecretScannerAdapter, SecretFinding } from '../secretScanner.js';

// ---------------------------------------------------------------------------
// GitleaksProvider seam — injected by consumer
// ---------------------------------------------------------------------------

/**
 * A raw finding as returned by the gitleaks engine (real or mock).
 *
 * The `secret` field carries the actual matched secret value. This value
 * must be redacted before it leaves the adapter boundary — it NEVER appears
 * in a `SecretFinding` returned to callers.
 */
export interface GitleaksFinding {
  /** Gitleaks rule ID (e.g. 'aws-access-token', 'github-pat'). */
  ruleId: string;
  /** 1-indexed line number of the match within the scanned text. */
  lineNumber: number;
  /**
   * The full line of text that contained the match.
   * Used by the adapter to construct the redacted snippet.
   * The adapter replaces `secret` occurrences with `[REDACTED]` before
   * including any substring in the returned `SecretFinding`.
   */
  line: string;
  /**
   * The raw matched secret value.
   * MUST NOT appear in any SecretFinding field returned to callers.
   * The adapter reads this value solely to perform redaction and then discards it.
   */
  secret: string;
}

/**
 * Injected seam for the gitleaks scanning engine.
 *
 * Real implementation lives in GL2 (`@phalanx/hoplon-secret-scanner-gitleaks`).
 * In-core tests use `MockGitleaksProvider` from `./mockGitleaksProvider.js`.
 *
 * @see MockGitleaksProvider for the in-memory implementation used in tests.
 */
export interface GitleaksProvider {
  /**
   * Scan `text` as if it were the content of `filename`.
   * May optionally consult `config` (a path to a gitleaks TOML config file).
   *
   * The returned findings include the raw `secret` value — the adapter
   * is responsible for redacting it before surfacing to callers.
   *
   * Must never throw on a scan attempt; surface errors as empty arrays.
   */
  scanText(text: string, filename: string, config?: string): Promise<GitleaksFinding[]>;
}

// ---------------------------------------------------------------------------
// Decoder (module-level singleton; TextDecoder is stateless)
// ---------------------------------------------------------------------------

const LOSSY_DECODER = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

/**
 * Replace all literal occurrences of `secret` in `line` with `[REDACTED]`.
 *
 * Uses split/join rather than regex replacement to avoid special-character
 * issues (e.g. secrets containing `$1`, `\n`, or regex metacharacters would
 * mis-behave with a regex-based replace).
 *
 * If `secret` is empty, returns `line` unmodified to avoid an infinite split.
 */
function redactSecret(line: string, secret: string): string {
  if (secret.length === 0) return line;
  return line.split(secret).join('[REDACTED]');
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface GitleaksScannerOptions {
  /**
   * The injected gitleaks provider.
   * In tests: `createMockGitleaksProvider(fixtures)`.
   * In production: a provider from `@phalanx/hoplon-secret-scanner-gitleaks`.
   */
  gitleaksProvider: GitleaksProvider;
  /**
   * Optional path to a gitleaks TOML configuration file.
   * When provided, forwarded to every `scanText` call, enabling custom rule sets.
   * When omitted, the provider uses its default rule set.
   */
  configPath?: string;
}

/**
 * Create a SecretScannerAdapter backed by the injected `GitleaksProvider`.
 *
 * Redaction is applied by this adapter — raw secret values from the provider
 * NEVER appear in returned `SecretFinding` objects.
 *
 * H13 compliance: no scanned text or raw secret values flow into operational
 * events. The adapter returns findings as typed DTOs only.
 *
 * @param opts.gitleaksProvider — injected scanning engine
 * @param opts.configPath — optional TOML config path forwarded to every scan
 */
export function createGitleaksSecretScanner(
  opts: GitleaksScannerOptions,
): SecretScannerAdapter {
  const { gitleaksProvider, configPath } = opts;

  return {
    async scan(req: { path: string; content: Uint8Array }): Promise<SecretFinding[]> {
      // Decode content lossily — same policy as the built-in regex scanner.
      // Invalid byte sequences become U+FFFD and scanning continues.
      const text = LOSSY_DECODER.decode(req.content);

      if (text.length === 0) {
        return [];
      }

      // Delegate scanning to the provider. The provider may receive the raw
      // text and the filename; it MUST NOT be called with anything that would
      // cause the scanned content to leak into operational events.
      const rawFindings = await gitleaksProvider.scanText(text, req.path, configPath);

      // Convert each raw finding to a redacted SecretFinding.
      // The `secret` field is consumed here and discarded — it never leaves
      // this function boundary as part of the returned value.
      const findings: SecretFinding[] = rawFindings.map((raw) => {
        const redactedSnippet = redactSecret(raw.line, raw.secret);
        return {
          patternName: raw.ruleId,
          lineNumber: raw.lineNumber,
          redactedSnippet,
        };
      });

      return findings;
    },
  };
}
