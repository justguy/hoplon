/**
 * contracts/preflight.ts — PreflightGateResult and PreflightResult schemas.
 *
 * The preflight() operation aggregates structured gate results — not thrown
 * exceptions — for each registered validation gate. Gates that detect issues
 * produce BLOCK status with typed AuditViolations; gates that pass return PASS;
 * gates that are skipped (e.g. v1 manifest for a v2-only gate) return SKIPPED.
 *
 * The overall PreflightResult.status is PASS iff every gate returns PASS or
 * SKIPPED. Any BLOCK gate → overall BLOCK.
 *
 * H13: PreflightResult is content-free; gates carry violations but those never
 * flow into the HoplonEvent stream.
 *
 * ## Extension point
 * Phase 2 Stage B LC1 (checkTargets) will register an additional
 * `checkTargetsGate` in the factory's `gates: [pathTraversalGate, checkTargetsGate]`
 * array. No API change required — only a new gate entry in PreflightDeps.
 */

import { z } from 'zod';
import { AuditViolationSchema } from './audit.js';

// ---------------------------------------------------------------------------
// PreflightGateStatus
// ---------------------------------------------------------------------------

export const PreflightGateStatusSchema = z.enum(['PASS', 'BLOCK', 'SKIPPED']);
export type PreflightGateStatus = z.infer<typeof PreflightGateStatusSchema>;

// ---------------------------------------------------------------------------
// PreflightGateResult — result from a single registered gate
// ---------------------------------------------------------------------------

export const PreflightGateResultSchema = z.object({
  /** Stable identifier for the gate, e.g. 'path_traversal', 'check_targets'. */
  gateName: z.string().min(1),
  status: PreflightGateStatusSchema,
  violations: z.array(AuditViolationSchema),
  /** Wall-clock duration of this gate's run in ms. */
  durationMs: z.number().int().nonnegative(),
});

export type PreflightGateResult = z.infer<typeof PreflightGateResultSchema>;

// ---------------------------------------------------------------------------
// PreflightResult — aggregated result from all registered gates
// ---------------------------------------------------------------------------

export const PreflightResultSchema = z.object({
  /**
   * Overall status: PASS iff all gates are PASS or SKIPPED.
   * BLOCK if any gate returns BLOCK.
   */
  status: z.enum(['PASS', 'BLOCK']),
  /** Gate results in registration order. */
  gates: z.array(PreflightGateResultSchema),
  /** Correlation ID threaded from the request (H11). */
  correlationId: z.string().min(1),
});

export type PreflightResult = z.infer<typeof PreflightResultSchema>;
