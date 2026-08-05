/**
 * contracts/decisionProvenance.ts — DecisionProvenance record (t-068).
 *
 * The V2 operating model explicitly separates:
 *
 *   - Hoplon proved               (authoritative, deterministic)
 *   - Higher-order agent recommended (advisory)
 *   - State machine decided       (workflow transition)
 *   - Wrapper recorded            (derived metadata)
 *   - Extension advised           (advisory, optional)
 *
 * The viewer spec prohibits merging these into a single "system decided"
 * status. This record keeps each decision individually attributable so a
 * reader can tell who proved, who recommended, who decided, and who merely
 * recorded metadata. It is append-only; new provenance rows are added as
 * the lifecycle progresses, existing rows are never rewritten.
 *
 * On this slice, the session writer records exactly one "hoplon_proved"
 * provenance row per audit call. Higher-order / state-machine / wrapper /
 * extension provenance belongs to layers above Hoplon core and is out of
 * scope for t-068; the schema is still defined so callers in those layers
 * can write durable provenance without reopening the contract.
 */

import { z } from 'zod';

export const ProvenanceCategorySchema = z.enum([
  'hoplon_proved',
  'higher_order_agent_recommended',
  'state_machine_decided',
  'wrapper_recorded',
  'extension_advised',
]);
export type ProvenanceCategory = z.infer<typeof ProvenanceCategorySchema>;

export const DecisionProvenanceSchema = z.object({
  /** Stable id. */
  provenanceId: z.string().min(1),
  /** Parent execution. */
  executionId: z.string().min(1),
  /** Optional attempt this provenance row is about. */
  attemptId: z.string().min(1).nullable(),
  /** Which authoritativeness class this provenance row belongs to. */
  category: ProvenanceCategorySchema,
  /** Short summary of what was proved/recommended/decided. Content-free. */
  summary: z.string().min(1),
  /**
   * Optional structured detail. Callers are responsible for keeping this
   * shape stable per category; Hoplon itself only writes 'hoplon_proved'
   * rows and uses detail to point back at the ProofBundle ref + status.
   */
  detail: z.record(z.unknown()).nullable(),
  /** ISO 8601 UTC. */
  createdAt: z.string(),
});

export type DecisionProvenance = z.infer<typeof DecisionProvenanceSchema>;
