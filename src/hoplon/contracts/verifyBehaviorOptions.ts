/** Caller options split from the primary verify-behavior DTO module. */

import { z } from 'zod';

// Request / options — caller-supplied inputs
// ---------------------------------------------------------------------------

/**
 * Caller options for `session.verifyBehavior()` and the packaged transport
 * surface. Every field is optional; the defaults enable the "just use the
 * oracle over the session's changedFiles" path with no explicit wiring.
 */
export const VerifyBehaviorOptionsSchema = z.object({
  /**
   * Explicit test file overrides. When present, the static oracle is still
   * consulted (so `selection.oracleResult` is populated) but the runner is
   * invoked with the caller's list and `selection.strategy === 'override'`.
   */
  testsOverride: z.array(z.string().min(1)).optional(),
  /**
   * Optional override for the files the oracle treats as "modified".
   * Defaults to the session's `changedFiles` when driven through the session.
   */
  modifiedFilesOverride: z.array(z.string().min(1)).optional(),
  /**
   * Substring patterns passed through to `getRelevantTests.testPatterns`.
   * Defaults to the oracle default (`['.test.', '.spec.', '/tests/']`).
   */
  testPatterns: z.array(z.string().min(1)).optional(),
  /** BFS depth for `getRelevantTests.maxDepth`. Default: oracle default (2). */
  maxDepth: z.number().int().min(1).max(10).optional(),
  /**
   * Conservative-coverage handling.
   *   - 'not_run'    — default; when the oracle returns 'conservative',
   *                    verify_behavior records NOT_RUN with
   *                    'selection_empty_conservative' rather than narrowing.
   *   - 'full_suite' — ask the runner to run the full suite; the result is
   *                    labelled `selection.strategy = 'full_suite_fallback'`.
   *   - 'run_anyway' — run whatever the oracle returned when it returned at
   *                    least one relevant test; a zero-test conservative
   *                    result still stays NOT_RUN so callers do not mistake
   *                    an empty run for a synthesized pass.
   */
  onConservativeCoverage: z
    .enum(['not_run', 'full_suite', 'run_anyway'])
    .optional(),
  /** Adapter-honored timeout in ms. Default: adapter-defined. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Opt in to the t-104 advisory semantic-gap sidecar. This does not change
   * relevant-test selection, runner execution, outcome, or PASS/BLOCK policy;
   * unavailable intelligence leaves the base verification DTO unchanged.
   */
  includeSemanticGapIntelligence: z.boolean().optional(),
  /**
   * Free-form tags forwarded to the adapter (e.g. `{ attempt: '3' }`).
   * Content-free: counts + short identifiers only (the adapter is trusted
   * not to introduce PII; Hoplon does not inspect values).
   */
  runnerMeta: z.record(z.string()).optional(),
});
export type VerifyBehaviorOptions = z.infer<typeof VerifyBehaviorOptionsSchema>;
