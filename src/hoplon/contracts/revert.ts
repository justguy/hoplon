/**
 * revert.ts — RevertResult Zod schema and inferred type.
 *
 * RS-1: full-tree restore inside manifest scope + allowlist.
 * Buckets: reverted, deleted, allowlistSkipped, presenceUnknownSkipped.
 */

import { z } from 'zod';

export const RevertResultSchema = z.object({
  /** Paths that were checked out (restored to snapshotted state). */
  reverted: z.array(z.string().min(1)),
  /**
   * Uncontracted post-snapshot files that did not exist at snapshot time
   * and were deleted (RS-1 destructive cleanup).
   */
  deleted: z.array(z.string().min(1)),
  /**
   * Paths matching the engine's revertAllowlist that were never touched.
   * Includes .git/**, node_modules/**, .hoplon/** by default.
   */
  allowlistSkipped: z.array(z.string().min(1)),
  /**
   * mcr-008 fail-safe bucket: deletion candidates that were SKIPPED because
   * the snapshot carries no presence evidence (created before mcr-008), so
   * "did this file exist at snapshot time" is unanswerable. Unknown-presence
   * files are treated as pre-existing and never deleted. Optional for
   * cross-version transport compatibility; always present (possibly empty)
   * in results produced by this engine.
   */
  presenceUnknownSkipped: z.array(z.string().min(1)).optional(),
});

export type RevertResult = z.infer<typeof RevertResultSchema>;
