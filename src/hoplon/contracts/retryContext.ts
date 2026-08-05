/**
 * contracts/retryContext.ts — PriorAttempt and CompressedRetryContext Zod schemas.
 *
 * LC9 — compressRetryContext (Tier 4 capability, §15.9 of recs).
 *
 * PriorAttempt: one agent attempt (N ≥ 1 attempts form the retry history).
 * CompressedRetryContext: structural delta across all attempts.
 *
 * compressRetryContext is synchronous — pure data transform over AuditViolation
 * arrays; no I/O, no async needed. (recs §15.9 + plan § Slice LC9)
 */

import { z } from 'zod';
import { AuditViolationSchema } from './audit.js';

// ---------------------------------------------------------------------------
// PriorAttempt — one attempt in the retry history
// ---------------------------------------------------------------------------

/**
 * One agent attempt, as passed by the Phalanx host to compressRetryContext.
 *
 * proposedContent is the full file content the agent produced.
 * violations is the AuditResult violations list that Hoplon returned for this attempt.
 * Attempts must be ordered by ascending attemptNumber.
 */
export const PriorAttemptSchema = z.object({
  /**
   * 1-based attempt index. Attempts must be ordered by ascending attemptNumber
   * when passed as an array.
   */
  attemptNumber: z.number().int().positive(),
  /**
   * Full UTF-8 source of the proposed file content for this attempt.
   * Used for structural-delta computation; not stored by Hoplon.
   */
  proposedContent: z.string(),
  /** Violations Hoplon returned for this attempt. Empty array = PASS attempt. */
  violations: z.array(AuditViolationSchema),
});

export type PriorAttempt = z.infer<typeof PriorAttemptSchema>;

// ---------------------------------------------------------------------------
// CompressedRetryContext — structural delta across all attempts
// ---------------------------------------------------------------------------

/**
 * The compressed retry history, token-efficient replacement for raw error injection.
 *
 * persistentViolations: violations present in EVERY attempt (never fixed — agent keeps making the same mistake).
 * resolvedViolations:   violations present in earlier attempts but ABSENT in the latest attempt (progress made).
 * newViolations:        violations that only appear in the LATEST attempt (regression introduced).
 * structuralDelta:      human-readable summary injected into the retry prompt.
 * retryDirective:       single action sentence focusing the agent on what to fix next.
 * attemptCount:         total number of attempts in the history.
 */
export const CompressedRetryContextSchema = z.object({
  /** Total number of attempts summarised. */
  attemptCount: z.number().int().nonnegative(),
  /**
   * Human-readable summary of the structural changes between attempts.
   * Injected into the retry prompt as a replacement for raw error history.
   */
  structuralDelta: z.string(),
  /** Violations present in every attempt — the agent has not fixed these. */
  persistentViolations: z.array(AuditViolationSchema),
  /** Violations fixed between any earlier attempt and the latest attempt. */
  resolvedViolations: z.array(AuditViolationSchema),
  /** Violations that only appear in the latest attempt (newly introduced). */
  newViolations: z.array(AuditViolationSchema),
  /** Single action sentence: what the agent should focus on in the next attempt. */
  retryDirective: z.string(),
});

export type CompressedRetryContext = z.infer<typeof CompressedRetryContextSchema>;
