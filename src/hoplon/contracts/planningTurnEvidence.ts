/** contracts/planningTurnEvidence.ts — PlanningTurnEvidence DTO (T-156).
 *
 * One record per planning LLM turn. Carries hash-pointer references to the
 * FencedContract (`contractHash`) and the planning guardrail bundle
 * (`guardrailBundleHash`), plus an `outcome`, optional `railId`/`clauseId`
 * pointers, a `correctionAttempt` counter, and (only on `escalate`) a
 * structured `escalationReason`.
 *
 * Records are pointers, not transcripts: the schema is `.strict()` and
 * deliberately omits any `reasoningTrace` / `prompt` / `response` / secret
 * fields. There is no length cap on agent-facing strings (`plannerTurnId`,
 * `escalationReason`); identifier fields use the same length-bounded regex
 * as the FencedContract clause-id taxonomy.
 *
 * `evidenceAuthority` is locked to `'advisory'`; this record is never an
 * `auditDiff` PASS/BLOCK input. Promotion to a blocking signal is a separate
 * hard-gate slice.
 */

import { z } from 'zod';
import { PlanningGuardrailEvidenceAuthoritySchema } from './planningGuardrailBundle.js';

export const PLANNING_TURN_EVIDENCE_SCHEMA_VERSIONS = [
  'hoplon.planning-turn-evidence/v1',
] as const;
export const PlanningTurnEvidenceSchemaVersionSchema = z.enum(
  PLANNING_TURN_EVIDENCE_SCHEMA_VERSIONS,
);
export type PlanningTurnEvidenceSchemaVersion = z.infer<
  typeof PlanningTurnEvidenceSchemaVersionSchema
>;

export const PLANNING_TURN_OUTCOMES = [
  'allow',
  'block',
  'retry',
  'escalate',
] as const;
export const PlanningTurnOutcomeSchema = z.enum(PLANNING_TURN_OUTCOMES);
export type PlanningTurnOutcome = z.infer<typeof PlanningTurnOutcomeSchema>;

const ClauseIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
  'clauseId must match /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/',
);
const RailIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/,
  'railId must match /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/',
);
const sha256HexSchema = (label: string) => z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, `${label} must be sha256:<64-hex>`);

const PlanningTurnEvidenceBaseSchema = z.object({
  schemaVersion: PlanningTurnEvidenceSchemaVersionSchema,
  contractHash: sha256HexSchema('contractHash'),
  guardrailBundleHash: sha256HexSchema('guardrailBundleHash'),
  plannerTurnId: z.string().min(1),
  outcome: PlanningTurnOutcomeSchema,
  railId: RailIdSchema.optional(),
  clauseId: ClauseIdSchema.optional(),
  correctionAttempt: z.number().int().nonnegative(),
  escalationReason: z.string().min(1).optional(),
  evidenceAuthority: PlanningGuardrailEvidenceAuthoritySchema,
}).strict();

export const PlanningTurnEvidenceSchema = PlanningTurnEvidenceBaseSchema
  .superRefine((evidence, ctx) => {
    if (evidence.outcome === 'escalate' && !evidence.escalationReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'escalationReason is required when outcome is escalate',
        path: ['escalationReason'],
      });
    }
    if (evidence.outcome !== 'escalate' && evidence.escalationReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'escalationReason is only permitted when outcome is escalate',
        path: ['escalationReason'],
      });
    }
  });
export type PlanningTurnEvidence = z.infer<typeof PlanningTurnEvidenceSchema>;
