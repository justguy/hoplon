/**
 * adapters/secretScanner/patterns.ts — Built-in regex pattern set for secret scanning.
 *
 * Each pattern is documented with what it catches and known false-positive
 * categories. This set is intentionally broad: detection is non-blocking
 * (always returns findings, never throws), so false positives surface as
 * warnings the host can inspect — they never block a snapshot commit.
 *
 * Phase 2+ swap target: Gitleaks (MIT) — all patterns are replaced when the
 * Gitleaks adapter is installed. The pattern set here is the Phase 1 default.
 */

export interface BuiltinPattern {
  /** Stable identifier used as `patternName` in SecretFinding. */
  name: string;
  /**
   * The compiled regex. Must use the `g` flag so exec() advances through
   * the string during scanning. The regex must be cloned per-scan via
   * `new RegExp(r.source, r.flags)` to reset lastIndex for each content
   * string — see builtin.ts.
   */
  regex: RegExp;
}

/**
 * BUILTIN_PATTERNS — default pattern set shipped with Phase 1.
 *
 * Ordering is deterministic (insertion order) but has no semantic meaning.
 * Each regex uses the `g` (global) flag; some also use `i` (case-insensitive)
 * where noted.
 *
 * False-positive classification legend:
 *   HIGH   — common in non-secret contexts; expect noise on large codebases
 *   MEDIUM — occasional noise; review before acting on findings
 *   LOW    — rare false positives; almost always real secrets when matched
 */
export const BUILTIN_PATTERNS: Array<BuiltinPattern> = [
  {
    /**
     * AWS_ACCESS_KEY_ID
     * Catches: Amazon Web Services access key IDs (20-char AKIA… identifiers).
     * Format: AKIA followed by exactly 16 uppercase alphanumeric characters.
     * False-positive risk: LOW — the prefix "AKIA" is highly distinctive;
     * accidental collisions are extremely rare in non-AWS code.
     */
    name: 'AWS_ACCESS_KEY_ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    /**
     * AWS_SECRET_ACCESS_KEY
     * Catches: Amazon Web Services secret access keys (40-char base64 strings).
     * Heuristic: any 40-character string drawn from the base64 alphabet
     * (A–Z, a–z, 0–9, /, +, =).
     * False-positive risk: HIGH — SHA-1 hashes, bcrypt cost strings, and
     * other 40-char base64/hex values will match. This is acknowledged and
     * intentional: it is a warning, not a block.
     */
    name: 'AWS_SECRET_ACCESS_KEY',
    regex: /\b[A-Za-z0-9/+=]{40}\b/g,
  },
  {
    /**
     * GITHUB_PAT_CLASSIC
     * Catches: GitHub classic personal access tokens.
     * Format: "ghp_" followed by exactly 36 alphanumeric characters.
     * False-positive risk: LOW — the "ghp_" prefix is GitHub-specific.
     */
    name: 'GITHUB_PAT_CLASSIC',
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
  },
  {
    /**
     * GITHUB_PAT_FINE_GRAINED
     * Catches: GitHub fine-grained personal access tokens (post-2022 format).
     * Format: "github_pat_" followed by exactly 82 alphanumeric/underscore chars.
     * False-positive risk: LOW — the "github_pat_" prefix is GitHub-specific
     * and the 82-char suffix length is highly distinctive.
     */
    name: 'GITHUB_PAT_FINE_GRAINED',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  },
  {
    /**
     * GITHUB_APP_TOKEN
     * Catches: GitHub App installation tokens.
     * Format: "ghs_" followed by exactly 36 alphanumeric characters.
     * False-positive risk: LOW — the "ghs_" prefix is GitHub-specific.
     */
    name: 'GITHUB_APP_TOKEN',
    regex: /\bghs_[A-Za-z0-9]{36}\b/g,
  },
  {
    /**
     * PRIVATE_KEY_PEM
     * Catches: PEM-encoded private key headers (RSA, DSA, EC, OPENSSH, PGP,
     * or generic PRIVATE KEY block headers).
     * Pattern: "-----BEGIN [optional type] PRIVATE KEY [optional BLOCK]-----"
     * False-positive risk: LOW — this exact string only appears in PEM key
     * material or test fixtures that embed PEM keys. Both cases warrant a
     * warning.
     */
    name: 'PRIVATE_KEY_PEM',
    regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    /**
     * SLACK_TOKEN
     * Catches: Slack API tokens (bot, app, user, OAuth, and legacy types).
     * Format: "xox" followed by one of a/b/p/o/s, a dash, and alphanumeric
     * segments separated by dashes.
     * False-positive risk: LOW — the "xox[abpos]-" prefix is Slack-specific.
     */
    name: 'SLACK_TOKEN',
    regex: /\bxox[abpos]-[A-Za-z0-9-]+\b/g,
  },
  {
    /**
     * STRIPE_SECRET_KEY
     * Catches: Stripe secret API keys (test and live environments).
     * Format: "sk_test_" or "sk_live_" followed by 24+ alphanumeric characters.
     * False-positive risk: LOW — the "sk_test_"/"sk_live_" prefixes are
     * Stripe-specific and the minimum length adds entropy.
     */
    name: 'STRIPE_SECRET_KEY',
    regex: /\bsk_(?:test|live)_[A-Za-z0-9]{24,}\b/g,
  },
  {
    /**
     * GENERIC_API_KEY
     * Catches: Common assignment patterns for API keys and access tokens
     * in source code (e.g. `api_key = "abc123..."`, `ACCESS_TOKEN: 'xyz...'`).
     * Pattern: the keyword (api_key, apikey, access_token, access-token)
     * followed by an assignment-like separator and a value of 20+ chars.
     * False-positive risk: HIGH — any config key assignment near these
     * keywords will match. Common noise: documentation examples, env-var
     * placeholders, test stubs. Values of 20+ chars are chosen to reduce
     * noise on trivially short strings; this is a heuristic, not a guarantee.
     * Uses `i` flag for case-insensitive match on keyword.
     */
    name: 'GENERIC_API_KEY',
    regex: /\b(?:api[_-]?key|apikey|access[_-]?token)['":\s=]+[A-Za-z0-9_\-]{20,}/gi,
  },
  {
    /**
     * GENERIC_HIGH_ENTROPY_HEX
     * Catches: High-entropy hexadecimal strings of 40 or more characters.
     * Common real secrets: OAuth client secrets, webhook secrets, HMAC keys,
     * symmetric encryption keys stored as hex.
     * False-positive risk: HIGH — SHA-1/SHA-256 digests, content-addressable
     * hashes (git SHAs), and UUID-derived hex strings all match. This pattern
     * is cheap to run and catches a broad class of hex-encoded secrets. Callers
     * should treat findings as "possible" rather than "confirmed".
     */
    name: 'GENERIC_HIGH_ENTROPY_HEX',
    regex: /\b[a-fA-F0-9]{40,}\b/g,
  },
];
