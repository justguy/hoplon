/**
 * contracts/parallelBatchBehaviorVerification.ts — t-091 macro contract.
 *
 * Cross-file semantic drift caused by structurally valid parallel safe-edit
 * sessions is invisible to `auditDiff` by design — auditDiff is a per-file
 * structural gate. To catch behavioral regressions across a batch of
 * resolved parallel sessions, the orchestrator composes:
 *
 *   1. `getRelevantTests` (LC10) over the union of changed files
 *   2. `verifyBehavior` (t-067) via the host-injected
 *      `BehaviorTestRunnerAdapter`
 *
 * This contract is the macro-layer envelope that:
 *
 *   - declares which sessions are in the batch
 *   - records the union of changed files (and the per-session split so a
 *     failure can be linked back to the session(s) that caused it)
 *   - wraps the `VerifyBehaviorResult` verbatim — the macro never
 *     reshapes the runner's evidence
 *   - rolls per-session linkage to per-test linkage when the runner
 *     reports failing test files; maps each failing-test file back to the
 *     session(s) whose changedFiles contributed to its selection
 *
 * Hard contract guarantees:
 *
 *   - This is **not** an `auditDiff` rule. The macro never blocks an audit
 *     PASS; failure is packaged as orchestrator-level rollback/retry
 *     evidence, not as a structural BLOCK.
 *   - PASS is never fabricated. When the runner is unavailable the macro
 *     mirrors `verifyBehavior`'s honesty contract: NOT_RUN with a concrete
 *     `unavailabilityReason`.
 *   - The macro never spawns tests. `verifyBehavior` already calls the
 *     adapter; the macro composes selection + invocation + linkage only.
 *   - The macro never silently truncates evidence. `truncated: true` from
 *     the adapter is surfaced as-is on the wrapped `VerifyBehaviorResult`.
 *   - When sessions in the batch report disjoint changed-file sets, the
 *     macro merges them deterministically (sorted, deduped) and records
 *     the merge plan in `batchSelection.unionedChangedFiles`.
 */

import { z } from 'zod';

import {
  VerifyBehaviorResultSchema,
  VerifyBehaviorOptionsSchema,
} from './verifyBehavior.js';

// ---------------------------------------------------------------------------
// Per-session input — one element per resolved parallel safe-edit session
// ---------------------------------------------------------------------------

/**
 * Minimum information the macro needs about a resolved parallel session.
 * The macro does not consult session state directly; the orchestrator passes
 * each session's identity + changed files + (optional) snapshot/attempt
 * linkage so the macro can package failure evidence with stable back-links.
 */
export const BatchBehaviorVerificationSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  /** Files this specific session modified, relative to projectRoot. */
  changedFiles: z.array(z.string().min(1)),
  /** Optional snapshot the session was audited against. */
  snapshotRefId: z.string().min(1).nullable(),
  /** Cross-session attempt number when the session has advanced past audited_*. */
  attemptNumber: z.number().int().positive().nullable(),
});
export type BatchBehaviorVerificationSessionInput = z.infer<
  typeof BatchBehaviorVerificationSessionInputSchema
>;

// ---------------------------------------------------------------------------
// Batch outcome — closed enum
// ---------------------------------------------------------------------------

export const BATCH_BEHAVIOR_VERIFICATION_OUTCOMES = [
  'PASS',
  'FAIL',
  'NOT_RUN',
] as const;
export const BatchBehaviorVerificationOutcomeSchema = z.enum(
  BATCH_BEHAVIOR_VERIFICATION_OUTCOMES,
);
export type BatchBehaviorVerificationOutcome = z.infer<
  typeof BatchBehaviorVerificationOutcomeSchema
>;

// ---------------------------------------------------------------------------
// Batch selection — union of inputs that drove `getRelevantTests`
// ---------------------------------------------------------------------------

export const BatchBehaviorVerificationSelectionSchema = z.object({
  /** Sorted, deduplicated union of every session's `changedFiles`. */
  unionedChangedFiles: z.array(z.string().min(1)),
  /**
   * Stable ordering of sessions in the batch: `sessionId`s sorted
   * alphabetically. Hoplon guarantees this is the same ordering used to
   * compute `unionedChangedFiles` so reviewers can reproduce the union
   * without re-running the macro.
   */
  sessionIdsInOrder: z.array(z.string().min(1)),
  /**
   * For each unioned changed file, the set of sessions that contributed it.
   * Same file can appear in multiple sessions (e.g. two sessions both
   * imported the same shared interface module); the macro records every
   * contributor so failure linkage can name them all.
   */
  perFileContributingSessions: z.record(z.array(z.string().min(1))),
});
export type BatchBehaviorVerificationSelection = z.infer<
  typeof BatchBehaviorVerificationSelectionSchema
>;

// ---------------------------------------------------------------------------
// Failure linkage — derived from the wrapped VerifyBehaviorResult
// ---------------------------------------------------------------------------

/**
 * One entry per failing test file the runner reported. The macro links it
 * back to the session(s) whose `changedFiles` contributed to its selection
 * via the unioned import graph. The mapping is best-effort: when the runner
 * does not report a `file` for a failure, the entry is omitted (recorded
 * instead under `unattributedFailures`).
 */
export const BatchBehaviorFailureLinkageEntrySchema = z.object({
  testFile: z.string().min(1),
  /** Sessions whose changedFiles imported this test transitively. */
  candidateSessionIds: z.array(z.string().min(1)),
});
export type BatchBehaviorFailureLinkageEntry = z.infer<
  typeof BatchBehaviorFailureLinkageEntrySchema
>;

export const BatchBehaviorFailureLinkageSchema = z.object({
  /**
   * One entry per distinct failing test file the runner reported. Sorted by
   * `testFile` for determinism (H7).
   */
  entries: z.array(BatchBehaviorFailureLinkageEntrySchema),
  /**
   * Failures the runner did not attribute to a file (no `file` in the
   * VerifyBehaviorFailingTest entry). Listed verbatim as testIds so a
   * reviewer can still see they exist.
   */
  unattributedFailureIds: z.array(z.string().min(1)),
});
export type BatchBehaviorFailureLinkage = z.infer<
  typeof BatchBehaviorFailureLinkageSchema
>;

// ---------------------------------------------------------------------------
// Top-level macro result
// ---------------------------------------------------------------------------

export const BatchBehaviorVerificationResultSchema = z
  .object({
    version: z.literal(1),
    /** Schema-pinned: macro behavior verification is advisory. */
    advisory: z.literal(true),
    /**
     * Macro outcome, derived from the wrapped `verifyBehavior`:
     *   - PASS    → wrapped.outcome === 'PASS' (status AVAILABLE)
     *   - FAIL    → wrapped.outcome === 'FAIL'
     *   - NOT_RUN → wrapped.outcome === 'NOT_RUN' (UNAVAILABLE / DEGRADED)
     */
    outcome: BatchBehaviorVerificationOutcomeSchema,
    /** Sessions in the batch (input echo, sorted by sessionId). */
    sessions: z.array(BatchBehaviorVerificationSessionInputSchema),
    selection: BatchBehaviorVerificationSelectionSchema,
    /**
     * The wrapped `VerifyBehaviorResult` — verbatim from the t-067 composer.
     * The macro never modifies it. All evidence (`stdout`, `stderr`,
     * `failingTests`, `structured`, `exitStatus`) is read here.
     */
    verifyBehavior: VerifyBehaviorResultSchema,
    /**
     * Failure linkage derived from `verifyBehavior.evidence.failingTests`.
     * Empty on PASS / NOT_RUN paths. Also empty when the wrapped runner failed
     * without structured failing-test records; in that case callers read the
     * preserved exit status, stdout/stderr, and notes from `verifyBehavior`.
     */
    failureLinkage: BatchBehaviorFailureLinkageSchema,
    correlationId: z.string().min(1),
    generatedAt: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    // Outcome must agree with wrapped verifyBehavior.outcome (closed mirror).
    if (value.outcome !== value.verifyBehavior.outcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'macro outcome must match wrapped verifyBehavior.outcome',
      });
    }
    // PASS / NOT_RUN must not carry failure linkage.
    if (
      value.outcome !== 'FAIL' &&
      (value.failureLinkage.entries.length > 0 ||
        value.failureLinkage.unattributedFailureIds.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureLinkage'],
        message: 'failureLinkage must be empty when outcome is not FAIL',
      });
    }
    // A t-067 degraded FAIL can have no structured failing-test rows. In that
    // case linkage must stay empty and callers use wrapped execution/evidence.
    if (
      value.verifyBehavior.evidence.failingTests.length === 0 &&
      (value.failureLinkage.entries.length > 0 ||
        value.failureLinkage.unattributedFailureIds.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureLinkage'],
        message:
          'failureLinkage must be empty when verifyBehavior has no failingTests',
      });
    }
  });
export type BatchBehaviorVerificationResult = z.infer<
  typeof BatchBehaviorVerificationResultSchema
>;

// ---------------------------------------------------------------------------
// Macro options — caller-supplied tuning (forwarded to verifyBehavior)
// ---------------------------------------------------------------------------

export const BatchBehaviorVerificationOptionsSchema = z.object({
  /**
   * Forwarded to `verifyBehavior`. Most callers leave this at default so the
   * oracle drives selection over `unionedChangedFiles`.
   */
  verify: VerifyBehaviorOptionsSchema.optional(),
});
export type BatchBehaviorVerificationOptions = z.infer<
  typeof BatchBehaviorVerificationOptionsSchema
>;
