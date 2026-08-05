/**
 * contracts/repairContext.ts — RepairContext DTO for the t-070 reusable
 * failed-audit repair-loop packaging seam.
 *
 * A RepairContext is the packaged, host-facing view of one failed audit
 * (`audited_block`) plus the linkage data needed to drive a retry session
 * without rebuilding that evidence ad hoc from unrelated session fields.
 *
 * This contract is an authoritative-fact-first pointer envelope over:
 *   - `AuditResult` (the BLOCK proof)
 *   - `RollbackTemplate` (the structural baseline after revert)
 *   - `SessionSnapshot.history` (the ordered-loop transition truth)
 *
 * It adds only two things on top of those facts:
 *   1. explicit failed-attempt metadata (sessionId, attemptNumber, snapshotRef,
 *      optional durable trace ids when `traceStore` was injected)
 *   2. next-attempt bookkeeping (attemptNumber, baselineSnapshotRef) so a
 *      retry session can carry forward the cross-session attempt counter
 *
 * What this contract explicitly does NOT carry:
 *   - retry prompt text
 *   - LLM binding / model selection
 *   - escalation policy or retry caps
 *   - any synthesized retry summary that would lose history sequence
 *
 * Those remain host-owned. Hoplon packages the authoritative proof + the
 * linkage; the host composes the retry prompt and owns the LLM call.
 *
 * ## Determinism (H7)
 *   `priorSessionHistory` copies the session transition log in its original
 *   ordered-loop order. Nothing here is reordered or summarised.
 *
 * ## H13 compliance
 *   This DTO is returned to the caller and is never emitted in HoplonEvent
 *   payloads. `AuditResult` violations may carry `sourceSlice` bytes as part
 *   of the existing authoritative proof contract — events stay content-free.
 */

import { z } from 'zod';

import { AuditResultSchema } from './audit.js';
import { DependencyImpactSidecarSchema } from './dependencyImpact.js';
import { RollbackTemplateSchema } from './rollbackTemplate.js';
import { VerificationSemanticGapSidecarSchema } from './verificationIntelligence.js';
import { RetryContextCompressionSchema } from './retryContextCompression.js';
import { VerifyBehaviorResultSchema } from './verifyBehavior.js';
import { RepairSuggestionSchema } from './repairSuggestion.js';

// ---------------------------------------------------------------------------
// FailedAttemptRef — the failed attempt this repair context describes
// ---------------------------------------------------------------------------

/**
 * Identity + linkage for the attempt that blocked.
 *
 * `executionId` / `attemptId` / `auditRef` are only populated when the
 * failed session had a durable substrate bound to it (t-068 `traceStore`
 * and/or the H13-safe `hoplon_audit_log`). They are optional on the
 * contract so the repair-context path functions on the basic session seam
 * without requiring trace infrastructure.
 */
export const FailedAttemptRefSchema = z.object({
  /** The session id that produced the BLOCK. */
  sessionId: z.string().min(1),
  /**
   * 1-based attempt index within the failed session. Matches the session's
   * own `attemptCounter` at the time audit() returned BLOCK.
   */
  attemptNumber: z.number().int().positive(),
  /**
   * The snapshotRef the failed audit was performed against. After revert
   * this is also the restored baseline the retry session will build on.
   */
  snapshotRef: z.string().min(1),
  /** ms-since-epoch of the audit transition that produced the BLOCK. */
  failedAtMs: z.number().int().nonnegative(),
  /**
   * Optional durable trace linkage. Populated when `traceStore` was
   * injected into the failed session. `null` otherwise.
   */
  executionId: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  /** Optional `hoplon_audit_log` ref from the failed audit. */
  auditRef: z.string().min(1).nullable(),
});

export type FailedAttemptRef = z.infer<typeof FailedAttemptRefSchema>;

// ---------------------------------------------------------------------------
// NextAttemptPlan — attempt bookkeeping for the retry
// ---------------------------------------------------------------------------

/**
 * Minimal plan for the retry attempt. This is not a retry policy; it is the
 * numeric bookkeeping the host needs so the retry session's audit() emits
 * the expected next attemptNumber and so the baseline the retry runs
 * against is explicit (and matches the baseline revert restored).
 */
export const NextAttemptPlanSchema = z.object({
  /** Expected attemptNumber for the retry's first audit. Always failedAttempt.attemptNumber + 1. */
  attemptNumber: z.number().int().positive(),
  /**
   * The baseline snapshotRef the retry session should target.
   *
   * On the shipped session seam this is the same ref the failed session
   * captured in `createSnapshot()` — revert restored the working tree to
   * that exact baseline, and a fresh retry session builds a new snapshot
   * from it. The value is echoed here so a host reading repair context
   * through transport has the baseline ref without re-reading session
   * state.
   */
  baselineSnapshotRef: z.string().min(1),
});

export type NextAttemptPlan = z.infer<typeof NextAttemptPlanSchema>;

// ---------------------------------------------------------------------------
// SessionTransitionLite — copy of SessionTransition for cross-module clone
// ---------------------------------------------------------------------------

/**
 * Structural shape of a session transition record. Mirrors the
 * SessionTransition interface in `src/hoplon/session/types.ts` without
 * importing session-layer types into the contracts layer (contracts do not
 * depend on session state machine internals; only on engine-DTO primitives).
 *
 * We intentionally validate shape only. The authoritative session
 * transition union lives in the session layer; this schema is a permissive
 * passthrough so RepairContext preserves history faithfully whatever the
 * session shape is at the time.
 */
const SessionTransitionLiteSchema = z.object({
  op: z.string().min(1),
  fromState: z.string().min(1),
  toState: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  outcome: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// RepairContext — top-level packaged repair context
// ---------------------------------------------------------------------------

export const RepairContextSchema = z.object({
  /** Schema version — never downgraded silently. */
  repairContextSchemaVersion: z.literal(1),
  /** Correlation id threaded from the failed session (H11). */
  correlationId: z.string().min(1),
  /** Project scoping (H14). */
  projectId: z.string().min(1),
  /** Run scoping (AS-2). */
  runId: z.string().min(1),
  /** Identity of the failed attempt this context describes. */
  failedAttempt: FailedAttemptRefSchema,
  /**
   * Full AuditResult from the failed audit. Always `status: 'BLOCK'` — a
   * PASS audit never produces a RepairContext.
   */
  auditResult: AuditResultSchema,
  /** Structural baseline produced by `extractRollbackTemplate`. */
  rollbackTemplate: RollbackTemplateSchema,
  /**
   * Ordered session-history snapshot from the failed session. Preserves
   * the append-only truth of the session's state machine so a host reading
   * repair context still sees the original transition sequence (no
   * summary, no reorder).
   */
  priorSessionHistory: z.array(SessionTransitionLiteSchema),
  /** Attempt bookkeeping for the retry. */
  nextAttempt: NextAttemptPlanSchema,
  /** ISO 8601 UTC timestamp of when this context was packaged. */
  generatedAt: z.string().min(1),
  /**
   * Canonical advisory dependency-impact sidecar shared with the packaged
   * review-payload path (t-077). Composed over the shipped
   * `analyzeBlastRadius` seam using subjects derived from the manifest's
   * declared scope plus the failed audit's violations. Optional on the
   * contract so pre-t-077 repair contexts still validate; packaging after
   * t-077 always emits an explicit `UNAVAILABLE` sidecar when the host did
   * not opt in, never silently omits it.
   */
  dependencyImpact: DependencyImpactSidecarSchema.optional(),
  /**
   * Most recent advisory behavior-verification result from this session, when
   * the host ran `verifyBehavior()` before packaging repair context. Carries
   * raw runner exit/evidence or an honest NOT_RUN reason without making tests
   * part of Hoplon's deterministic repair flow.
   */
  behaviorVerification: VerifyBehaviorResultSchema.optional(),
  /**
   * Optional t-104 advisory verification semantic-gap sidecar. This is copied
   * from a Hoplon-mediated `VerifyBehaviorResult` when the host supplies one
   * for the failed behavior proof; it never exposes raw host reads and never
   * changes retry/audit policy.
   */
  verificationSemanticGap: VerificationSemanticGapSidecarSchema.optional(),
  /**
   * Optional t-107 focused retry payload. It preserves the decisive audit /
   * behavior failure facts while keeping raw runner logs behind a pointer so
   * strict-agent retry context does not default to full noisy output.
   */
  retryContextCompression: RetryContextCompressionSchema.optional(),
  /**
   * Optional advisory repair suggestions derived from the authoritative
   * audit violations. These are never applied automatically and always
   * require caller confirmation before a retry session uses them.
   */
  repairSuggestions: z.array(RepairSuggestionSchema).optional(),
}).superRefine((value, ctx) => {
  if (value.auditResult.status !== 'BLOCK') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auditResult', 'status'],
      message: 'repair context requires an authoritative BLOCK auditResult',
    });
  }

  if (value.nextAttempt.attemptNumber !== value.failedAttempt.attemptNumber + 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextAttempt', 'attemptNumber'],
      message: 'nextAttempt.attemptNumber must equal failedAttempt.attemptNumber + 1',
    });
  }

  if (value.nextAttempt.baselineSnapshotRef !== value.failedAttempt.snapshotRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextAttempt', 'baselineSnapshotRef'],
      message: 'nextAttempt.baselineSnapshotRef must equal failedAttempt.snapshotRef',
    });
  }
});

export type RepairContext = z.infer<typeof RepairContextSchema>;
