/**
 * contracts/attempt.ts — Attempt durable record (t-068).
 *
 * An Attempt is a first-class, individually inspectable entry inside an
 * ExecutionTrace. Each audit call (session or standalone) appends one
 * immutable Attempt. Blocked attempts MUST remain visible even after a
 * later successful attempt — this is an authoritative contract guarantee,
 * not a UI preference. Retry visibility is enforced by:
 *
 *   - append-only writes (no UPDATE path)
 *   - monotonically increasing attemptNumber per executionId
 *   - status stored on the Attempt itself, not derived from the latest row
 *
 * An Attempt stores the stable refs (auditRef, snapshotRef, proofBundleRef)
 * that let a reader pull the raw proof from the ProofBundle store; it does
 * not itself carry raw violation content. The separation is deliberate so
 * Attempt listings stay cheap and proof inspection stays explicit.
 */

import { z } from 'zod';

export const AttemptStatusSchema = z.enum([
  'PASS',
  'BLOCK',
  'ERROR',
  'DENY',
  'ESCALATED',
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/** Who produced this attempt (audit call origin). */
export const ActorTypeSchema = z.enum([
  'execution_agent',
  'session',
  'host',
  'external',
]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const AttemptSchema = z.object({
  /** Stable attempt id, unique across all attempts in the store. */
  attemptId: z.string().min(1),
  /** Parent execution. */
  executionId: z.string().min(1),
  /** Monotonically increasing per execution. 1-based. */
  attemptNumber: z.number().int().positive(),
  /** Optional contract ref (manifest hash or plan-derived id). */
  contractRef: z.string().min(1).nullable(),
  /** Snapshot the audit was performed against. */
  basedOnSnapshotRef: z.string().min(1),
  /** Resulting post-edit snapshot if one was sealed. Null otherwise. */
  resultSnapshotRef: z.string().min(1).nullable(),
  /** Opaque stable ref back to the AuditLogRecord uuid (H13-safe log). */
  auditRef: z.string().min(1).nullable(),
  /** Pointer to the raw proof bundle (proofBundle.ts). */
  proofBundleRef: z.string().min(1),
  status: AttemptStatusSchema,
  actorType: ActorTypeSchema,
  /** Opaque actor identifier (e.g. agent id, session id). */
  actorRef: z.string().min(1),
  /** Optional pointer to a repair plan issued in response to this attempt. */
  repairPlanRef: z.string().min(1).nullable(),
  /** ISO 8601 UTC. */
  startedAt: z.string(),
  /** ISO 8601 UTC. */
  completedAt: z.string(),
});

export type Attempt = z.infer<typeof AttemptSchema>;
