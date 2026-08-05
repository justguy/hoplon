/** Closed verify-behavior alphabets split from the primary DTO module. */

import { z } from 'zod';

// Enum alphabets — closed unions pinned as schema invariants
// ---------------------------------------------------------------------------

export const VERIFY_BEHAVIOR_STATUSES = [
  'AVAILABLE',
  'DEGRADED',
  'UNAVAILABLE',
] as const;
export const VerifyBehaviorStatusSchema = z.enum(VERIFY_BEHAVIOR_STATUSES);
export type VerifyBehaviorStatus = z.infer<typeof VerifyBehaviorStatusSchema>;

export const VERIFY_BEHAVIOR_OUTCOMES = ['PASS', 'FAIL', 'NOT_RUN'] as const;
export const VerifyBehaviorOutcomeSchema = z.enum(VERIFY_BEHAVIOR_OUTCOMES);
export type VerifyBehaviorOutcome = z.infer<typeof VerifyBehaviorOutcomeSchema>;

export const VERIFY_BEHAVIOR_SELECTION_STRATEGIES = [
  'oracle',
  'override',
  'full_suite_fallback',
  'none',
] as const;
export const VerifyBehaviorSelectionStrategySchema = z.enum(
  VERIFY_BEHAVIOR_SELECTION_STRATEGIES,
);
export type VerifyBehaviorSelectionStrategy = z.infer<
  typeof VerifyBehaviorSelectionStrategySchema
>;

export const VERIFY_BEHAVIOR_UNAVAILABILITY_REASONS = [
  'not_requested',
  'no_runner',
  'runner_unavailable',
  'selection_empty_exact',
  'selection_empty_conservative',
  'oracle_failure',
  'timeout',
  'runner_error',
  'aborted',
] as const;
export const VerifyBehaviorUnavailabilityReasonSchema = z.enum(
  VERIFY_BEHAVIOR_UNAVAILABILITY_REASONS,
);
export type VerifyBehaviorUnavailabilityReason = z.infer<
  typeof VerifyBehaviorUnavailabilityReasonSchema
>;

export const VERIFY_BEHAVIOR_EXIT_KINDS = [
  'exit_code',
  'signal',
  'timeout',
  'spawn_error',
  'runner_error',
  'not_run',
] as const;
export const VerifyBehaviorExitKindSchema = z.enum(VERIFY_BEHAVIOR_EXIT_KINDS);
export type VerifyBehaviorExitKind = z.infer<typeof VerifyBehaviorExitKindSchema>;

export const VERIFY_BEHAVIOR_NOTES = [
  'runner_not_injected',
  'selection_override',
  'selection_oracle',
  'selection_conservative',
  'oracle_failure',
  'no_selected_tests',
  'full_suite_fallback',
  'runner_exit_nonzero_no_failing_tests',
  'runner_exit_zero_with_failing_tests',
  'session_linkage_unavailable',
] as const;
export const VerifyBehaviorNoteSchema = z.enum(VERIFY_BEHAVIOR_NOTES);
export type VerifyBehaviorNote = z.infer<typeof VerifyBehaviorNoteSchema>;

// ---------------------------------------------------------------------------
