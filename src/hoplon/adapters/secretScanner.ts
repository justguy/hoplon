/**
 * adapters/secretScanner.ts — SecretScannerAdapter interface and SecretFinding schema.
 *
 * Phase 1 default: createBuiltinRegexScanner (small built-in pattern set:
 *   AWS access keys, GitHub PATs, private-key PEM headers, high-entropy hex).
 * Phase 2+ swap target: Gitleaks (MIT) — embed as library or call as subprocess.
 *
 * SecretFinding NEVER contains the raw secret — only the redacted snippet.
 * Secret scanning is non-blocking: warnings are returned, never thrown.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SecretFinding
// ---------------------------------------------------------------------------

export const SecretFindingSchema = z.object({
  /** Name of the pattern that matched (e.g. 'aws_access_key', 'github_pat'). */
  patternName: z.string().min(1),
  /** 1-indexed line number of the match within the file. */
  lineNumber: z.number().int().positive(),
  /** The matched line with the secret characters replaced by [REDACTED]. */
  redactedSnippet: z.string(),
});

export type SecretFinding = z.infer<typeof SecretFindingSchema>;

// ---------------------------------------------------------------------------
// SecretScannerAdapter interface
// ---------------------------------------------------------------------------

export interface SecretScannerAdapter {
  /**
   * Scan the given file content for secrets.
   * Returns findings — never throws on a potential secret.
   * Returns an empty array when no patterns match.
   */
  scan(req: { path: string; content: Uint8Array }): Promise<SecretFinding[]>;
}
