/**
 * contracts/verifyBehavior.ts — t-067 host-facing behavior verification contract.
 *
 * Packages a runtime-test-execution result over already-shipped session facts.
 * Test execution stays host-owned: Hoplon selects candidate tests via the
 * shipped `getRelevantTests` static oracle (LC10) and invokes a host-injected
 * `BehaviorTestRunnerAdapter`. The engine core never spawns test processes,
 * never parses test runner output, and never consults this result in any
 * PASS/BLOCK path (`auditDiff`, `createSnapshot`, `dryRun`, `preflight`).
 *
 * This is the explicit non-goal fence the roadmap has always carried:
 *   "Tree-sitter does not replace the test runner or code reviewer. It is the
 *    structural gate only." (docs/HOPLON_PHASED_ARCHITECTURE.md §1)
 * `verify_behavior` closes the structural-to-dynamic loop without redefining
 * Hoplon as the test runner: the adapter runs the tests and reports the raw
 * evidence; this DTO wraps the evidence with linkage back to the session, the
 * snapshot the edits were audited against, and the selection strategy the
 * caller used.
 *
 * Always-present / optional axes (see t-067 close-out report):
 *
 *   always-present — version, advisory:true, status, outcome, selection,
 *                    linkage, execution, evidence, notes[]
 *   caller-choice  — selection.strategy + selection.relevantTests (oracle vs.
 *                    override vs. full-suite fallback; oracle carries through
 *                    even when override was used, so reviewers see the
 *                    structural selection too)
 *   runner-dep     — evidence.failingTests, evidence.stdout/stderr,
 *                    evidence.structured, execution.exitStatus (only when the
 *                    runner actually ran)
 *
 * Honest degradation:
 *
 *   - Runner not injected → status: 'UNAVAILABLE', outcome: 'NOT_RUN',
 *     reason: 'no_runner'. The evidence envelope stays shape-complete with
 *     counts at 0 and stdout/stderr null; never a synthesized pass.
 *   - Oracle returned conservative coverage AND caller did not opt into
 *     full-suite fallback → status: 'UNAVAILABLE', outcome: 'NOT_RUN',
 *     reason: 'selection_empty_conservative'. The oracle result is still
 *     echoed so the caller can see *why* nothing ran.
 *   - Runner threw / timed out → status: 'DEGRADED', outcome: 'NOT_RUN' (or
 *     'FAIL' when the adapter populates failingTests before crashing), with
 *     the concrete execution.exitStatus preserved verbatim.
 *
 * H13 (content-free operational logs) continues to apply to `HoplonEvent`
 * payloads emitted alongside this operation — only counts + kind. The
 * content-bearing fields (`stdout`, `stderr`, `failingTests`, `structured`)
 * live ONLY on this DTO returned to the caller; they never enter the event
 * stream.
 */

import { z } from 'zod';

import { TestOracleResultSchema } from './getRelevantTests.js';
import { VerificationSemanticGapSidecarSchema } from './verificationIntelligence.js';

// ---------------------------------------------------------------------------
import {
  VerifyBehaviorExitKindSchema,
  VerifyBehaviorNoteSchema,
  VerifyBehaviorOutcomeSchema,
  VerifyBehaviorSelectionStrategySchema,
  VerifyBehaviorStatusSchema,
  VerifyBehaviorUnavailabilityReasonSchema,
} from './verifyBehaviorEnums.js';

export * from './verifyBehaviorEnums.js';
// Exit status — preserves the adapter's raw termination signal
// ---------------------------------------------------------------------------

/**
 * Structured execution exit. Preserves exit codes and signals verbatim so the
 * host can route on the concrete failure mode — "process exited 1" is a
 * different recovery story from "SIGKILL after timeout".
 */
export const VerifyBehaviorExitStatusSchema = z.object({
  kind: VerifyBehaviorExitKindSchema,
  /** Process exit code when kind === 'exit_code'. */
  code: z.number().int().nullable(),
  /** Terminating signal when kind === 'signal' (e.g. 'SIGKILL'). */
  signal: z.string().min(1).nullable(),
  /**
   * Closed-text reason for the non-process kinds (`timeout`, `spawn_error`,
   * `runner_error`, `not_run`). For `not_run` the reason mirrors the
   * top-level `unavailabilityReason` so callers do not have to cross-reference.
   */
  reason: z.string().min(1).nullable(),
});
export type VerifyBehaviorExitStatus = z.infer<
  typeof VerifyBehaviorExitStatusSchema
>;

// ---------------------------------------------------------------------------
import { VerifyBehaviorEvidenceSchema } from './verifyBehaviorEvidence.js';

export * from './verifyBehaviorEvidence.js';

// Selection — how the test list was chosen
// ---------------------------------------------------------------------------

export const VerifyBehaviorSelectionSchema = z.object({
  /**
   * How the executed test list was arrived at:
   *   - 'oracle'              — derived from `getRelevantTests`
   *   - 'override'            — caller supplied `testsOverride`
   *   - 'full_suite_fallback' — caller opted in after conservative coverage
   *   - 'none'                — nothing ran (UNAVAILABLE / NOT_RUN path)
   */
  strategy: VerifyBehaviorSelectionStrategySchema,
  /** Sorted test files the runner was asked to execute. Empty on the 'none' path. */
  testsExecuted: z.array(z.string().min(1)),
  /**
   * Oracle result when available — echoed so the reviewer sees the structural
   * selection even when the caller overrode. Null when the oracle was not
   * consulted (override + static-oracle call skipped, or oracle failure).
   */
  oracleResult: TestOracleResultSchema.nullable(),
  /**
   * Coverage confidence of the selection actually used.
   *   - 'exact'           — oracle returned 'exact' and was used
   *   - 'conservative'    — oracle returned 'conservative' (potentially expanded)
   *   - 'override'        — caller-supplied list; no oracle guarantee
   *   - 'full_suite'      — fallback ran the full suite
   *   - 'not_applicable'  — NOT_RUN path
   */
  coverageConfidence: z.enum([
    'exact',
    'conservative',
    'override',
    'full_suite',
    'not_applicable',
  ]),
  /**
   * Source of the oracle call's `modifiedFiles` input, so a reviewer can
   * trace linkage back to `changedFiles` or a caller-supplied override.
   */
  modifiedFilesSource: z.enum([
    'session_changed_files',
    'caller_supplied',
    'none',
  ]),
});
export type VerifyBehaviorSelection = z.infer<
  typeof VerifyBehaviorSelectionSchema
>;

// ---------------------------------------------------------------------------
// Execution — when/how the adapter ran
// ---------------------------------------------------------------------------

export const VerifyBehaviorExecutionSchema = z.object({
  /**
   * Stable identifier the adapter claimed (e.g. 'host-vitest-v1'). Hoplon
   * does not interpret the value; it is preserved so the reviewer knows
   * which runner produced the evidence. `null` on the NOT_RUN path.
   */
  runnerId: z.string().min(1).nullable(),
  /** ISO 8601 UTC. Null when the adapter was never called. */
  startedAt: z.string().min(1).nullable(),
  /** ISO 8601 UTC. Null when the adapter was never called or did not complete. */
  completedAt: z.string().min(1).nullable(),
  /** Wall-clock duration in ms. Null when the adapter was never called. */
  durationMs: z.number().int().nonnegative().nullable(),
  exitStatus: VerifyBehaviorExitStatusSchema,
  /** Timeout the adapter honored (ms). `null` when the caller did not override. */
  timeoutMs: z.number().int().nonnegative().nullable(),
  /** Adapter-reported working directory. `null` when the adapter did not report one. */
  workingDirectory: z.string().min(1).nullable(),
});
export type VerifyBehaviorExecution = z.infer<
  typeof VerifyBehaviorExecutionSchema
>;

// ---------------------------------------------------------------------------
// Linkage — back-reference to the edited session/target
// ---------------------------------------------------------------------------

export const VerifyBehaviorLinkageSchema = z.object({
  sessionId: z.string().min(1).nullable(),
  snapshotRefId: z.string().min(1).nullable(),
  changedFiles: z.array(z.string().min(1)),
  /**
   * Cross-session attempt number (t-070) when the verification was driven from
   * a session that had advanced beyond `audited_*`. Null otherwise.
   */
  attemptNumber: z.number().int().positive().nullable(),
});
export type VerifyBehaviorLinkage = z.infer<typeof VerifyBehaviorLinkageSchema>;

// ---------------------------------------------------------------------------
// VerifyBehaviorResult — the top-level DTO
// ---------------------------------------------------------------------------

export const VerifyBehaviorResultSchema = z
  .object({
    version: z.literal(1),
    /** Schema-pinned: behavior verification is advisory. */
    advisory: z.literal(true),
    status: VerifyBehaviorStatusSchema,
    outcome: VerifyBehaviorOutcomeSchema,
    /** Populated on the UNAVAILABLE / DEGRADED / NOT_RUN paths. Null on AVAILABLE+PASS/FAIL. */
    unavailabilityReason: VerifyBehaviorUnavailabilityReasonSchema.nullable(),
    selection: VerifyBehaviorSelectionSchema,
    linkage: VerifyBehaviorLinkageSchema,
    execution: VerifyBehaviorExecutionSchema,
    evidence: VerifyBehaviorEvidenceSchema,
    /**
     * Optional t-104 advisory semantic-gap metadata. When absent, behavior
     * verification is the pre-t-104 DTO. When present, it is derived only from
     * this DTO's own Hoplon-mediated selection/evidence facts.
     */
    verificationSemanticGap: VerificationSemanticGapSidecarSchema.optional(),
    correlationId: z.string().min(1),
    generatedAt: z.string().min(1),
    notes: z.array(VerifyBehaviorNoteSchema),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'AVAILABLE' && value.outcome === 'NOT_RUN') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'AVAILABLE status cannot pair with NOT_RUN outcome',
      });
    }
    if (value.status === 'UNAVAILABLE' && value.outcome !== 'NOT_RUN') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'UNAVAILABLE status can only pair with NOT_RUN outcome',
      });
    }
    if (value.status === 'DEGRADED' && value.outcome === 'PASS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'DEGRADED status cannot pair with PASS outcome',
      });
    }
    if (value.outcome !== 'NOT_RUN' && value.unavailabilityReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailabilityReason'],
        message:
          'unavailabilityReason must be null when outcome is PASS or FAIL',
      });
    }
    if (value.outcome === 'NOT_RUN' && value.unavailabilityReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailabilityReason'],
        message: 'NOT_RUN outcome requires an explicit unavailabilityReason',
      });
    }
    if (
      value.outcome === 'FAIL' &&
      value.evidence.failingTests.length === 0 &&
      value.execution.exitStatus.kind === 'exit_code' &&
      value.execution.exitStatus.code === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message:
          'FAIL outcome with zero failing tests and exit code 0 is inconsistent',
      });
    }
  });
export type VerifyBehaviorResult = z.infer<typeof VerifyBehaviorResultSchema>;

// ---------------------------------------------------------------------------

export * from './verifyBehaviorOptions.js';
