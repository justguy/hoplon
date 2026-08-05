/**
 * contracts/executionTrace.ts — ExecutionTrace durable record (t-068).
 *
 * An ExecutionTrace represents one execution lifecycle. A session-driven
 * edit loop owns one trace; non-session standalone audits produce a
 * single-attempt trace. Traces are durable (stored in a TraceStore adapter)
 * and are the canonical attempt history a viewer or export can read from.
 *
 * The trace object itself is metadata + pointers (id, status, links). The
 * raw proof lives in ProofBundle records (proofBundle.ts). The H13-safe
 * `hoplon_audit_log` is NOT the trace store and stays content-free; the
 * trace store is the explicit raw-proof layer.
 *
 * Writers: session constructor opens a trace; session close updates status.
 * Readers: HTTP/MCP read surfaces, JSON evidence export, future viewer.
 *
 * The V2 operating model distinguishes authoritative Hoplon facts from
 * higher-order-agent recommendations, state-machine decisions, wrapper
 * metadata, and extension advisories. Those distinctions live on
 * DecisionProvenance (decisionProvenance.ts); the ExecutionTrace only
 * carries stable ids + links so the distinctions are reachable without
 * being merged or lost.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Stable id shapes
// ---------------------------------------------------------------------------

/** Execution id: stable across attempts within one execution lifecycle. */
export const ExecutionIdSchema = z.string().min(1);
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

/** Status of the execution as a whole. Distinct from per-attempt status. */
export const ExecutionStatusSchema = z.enum([
  'IN_PROGRESS',
  'PASS',
  'BLOCK',
  'ERROR',
  'ESCALATED',
  'CLOSED',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionTraceSchema = z.object({
  /** Stable execution id, unique across all traces in the store. */
  executionId: ExecutionIdSchema,
  /** Project scoping (H14). */
  projectId: z.string().min(1),
  /** Run scoping — cross-run replay protection (AS-2). */
  runId: z.string().min(1),
  /** Engine identity observed at trace creation (H5). */
  engineId: z.string().min(1),
  /** Correlation id threaded from the host request (H11). */
  correlationId: z.string().min(1),
  /** Optional external plan id (higher-order agent plan ref). Null if absent. */
  planRef: z.string().min(1).nullable(),
  /** Baseline snapshot the execution was contracted against. Null pre-snapshot. */
  baselineSnapshotRef: z.string().min(1).nullable(),
  /** Aggregate execution status. Transitions are written, never overwritten silently. */
  currentStatus: ExecutionStatusSchema,
  /** Origin of this trace (session lifecycle vs standalone audit). */
  origin: z.enum(['session', 'audit_diff', 'external']),
  /** ISO 8601 UTC. */
  createdAt: z.string(),
  /** ISO 8601 UTC — most recent write. */
  updatedAt: z.string(),
});

export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;
