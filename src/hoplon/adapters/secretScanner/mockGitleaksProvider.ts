/**
 * adapters/secretScanner/mockGitleaksProvider.ts — In-memory GitleaksProvider
 * for use in unit and contract tests.
 *
 * Returns a fixed set of fixture findings rather than invoking any external
 * binary. Findings are filtered per-filename so tests can target specific
 * scan paths without coupling fixture data to unrelated files.
 *
 * ## Usage
 *
 * ```typescript
 * import { createMockGitleaksProvider } from './mockGitleaksProvider.js';
 * import { createGitleaksSecretScanner } from './gitleaks.js';
 *
 * const provider = createMockGitleaksProvider([
 *   {
 *     filename: 'config.ts',
 *     findings: [
 *       {
 *         ruleId: 'aws-access-token',
 *         lineNumber: 3,
 *         line: 'const key = "AKIAIOSFODNN7EXAMPLE";',
 *         secret: 'AKIAIOSFODNN7EXAMPLE',
 *       },
 *     ],
 *   },
 * ]);
 *
 * const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });
 * const findings = await scanner.scan({
 *   path: 'config.ts',
 *   content: encoder.encode('const key = "AKIAIOSFODNN7EXAMPLE";'),
 * });
 * ```
 *
 * ## Design notes
 * - Findings are matched by exact filename string (the `path` passed to
 *   `scanner.scan()`, which equals the `filename` argument in `scanText`).
 * - Files with no fixture entry return an empty array.
 * - The `configPath` argument is accepted but ignored — mock behaviour is
 *   determined entirely by the fixture table, not by a TOML rule file.
 * - The provider never throws; errors are simulated by returning an empty array.
 */

import type { GitleaksProvider, GitleaksFinding } from './gitleaks.js';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/**
 * A single file's fixture entry for the mock provider.
 */
export interface MockFileFixture {
  /**
   * The filename (path) this fixture applies to.
   * Must exactly match the `filename` argument passed to `scanText`
   * (which equals the `req.path` value the adapter receives).
   */
  filename: string;
  /** The findings the provider will return for this file. */
  findings: GitleaksFinding[];
}

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory GitleaksProvider that returns fixed fixture findings.
 *
 * @param fixtures — Array of per-file fixture entries. Files not present in
 *   the table receive an empty finding array.
 */
export function createMockGitleaksProvider(
  fixtures: MockFileFixture[],
): GitleaksProvider {
  // Build a lookup map keyed by filename for O(1) access per scan.
  const fixtureMap = new Map<string, GitleaksFinding[]>();
  for (const entry of fixtures) {
    fixtureMap.set(entry.filename, entry.findings);
  }

  return {
    async scanText(
      _text: string,
      filename: string,
      _config?: string,
    ): Promise<GitleaksFinding[]> {
      // Return a shallow copy of the fixture so tests cannot mutate provider state.
      return [...(fixtureMap.get(filename) ?? [])];
    },
  };
}
