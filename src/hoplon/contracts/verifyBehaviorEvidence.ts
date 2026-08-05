/** Runner evidence split from the primary verify-behavior DTO module. */

import { z } from 'zod';

// Failing-test record — one entry per reported failure
// ---------------------------------------------------------------------------

export const VerifyBehaviorFailingTestSchema = z.object({
  /** Stable opaque identifier the runner assigned (e.g. "tests/foo.test.ts > add > handles zero"). */
  testId: z.string().min(1),
  /** Short human-facing name — runner-defined. */
  name: z.string().min(1),
  /** File path the runner attributed the failure to (nullable when the runner does not report it). */
  file: z.string().min(1).nullable(),
  /** Primary failure message — verbatim from the runner; never truncated by Hoplon. */
  failureMessage: z.string(),
  /** Optional stack trace — verbatim when the runner emits one, null otherwise. */
  stack: z.string().nullable(),
  /** Test duration in ms when available. */
  durationMs: z.number().int().nonnegative().nullable(),
  /**
   * Optional structured assertion sub-records (e.g. vitest `expected` /
   * `actual` / `diff` tuples). Shape is runner-defined; Hoplon preserves the
   * JSON verbatim. Null when the runner does not expose structured assertions.
   */
  assertions: z.array(z.record(z.unknown())).nullable(),
});
export type VerifyBehaviorFailingTest = z.infer<
  typeof VerifyBehaviorFailingTestSchema
>;

// ---------------------------------------------------------------------------
// Evidence envelope
// ---------------------------------------------------------------------------

/**
 * Raw runner evidence. Hoplon NEVER truncates `stdout`, `stderr`,
 * `failureMessage`, or `stack` with arbitrary caps. If the adapter capped its
 * own output before returning, it must set `truncated: true` so the host
 * knows the trail is incomplete and can fetch the raw log artifact itself.
 */
export const VerifyBehaviorEvidenceSchema = z.object({
  failingTests: z.array(VerifyBehaviorFailingTestSchema),
  passingTestCount: z.number().int().nonnegative(),
  skippedTestCount: z.number().int().nonnegative(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  /** Adapter-specific JSON payload (e.g. vitest JSON reporter). */
  structured: z.unknown().nullable(),
  /** True iff the adapter capped stdout / stderr / structured itself. */
  truncated: z.boolean(),
});
export type VerifyBehaviorEvidence = z.infer<typeof VerifyBehaviorEvidenceSchema>;

// ---------------------------------------------------------------------------
