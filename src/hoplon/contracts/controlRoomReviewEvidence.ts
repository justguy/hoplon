/** contracts/controlRoomReviewEvidence.ts - T-159 review attachment DTOs.
 *
 * Human-review evidence packet for Control Room surfaces. It links an
 * ExecutionBlueprint preview to contract and planning guardrail identities,
 * separates advisory planning outcomes into buckets, and keeps deterministic
 * handoff state as preview-only evidence.
 */

import { z } from 'zod';
import {
  PlanningGuardrailEvidenceAuthoritySchema,
  PlanningGuardrailGeneratedConfigSchema,
  PlanningGuardrailTargetRuntimeSchema,
} from './planningGuardrailBundle.js';
import { PlanningTurnEvidenceSchema } from './planningTurnEvidence.js';

const HashSchema = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'hash must be sha256:<64-hex>');
const NonEmptyStringSchema = z.string().min(1);

export const CONTROL_ROOM_REVIEW_EVIDENCE_SCHEMA_VERSIONS = [
  'hoplon.control-room-review-evidence/v1',
] as const;
export const ControlRoomReviewEvidenceSchemaVersionSchema = z.enum(
  CONTROL_ROOM_REVIEW_EVIDENCE_SCHEMA_VERSIONS,
);
export type ControlRoomReviewEvidenceSchemaVersion = z.infer<
  typeof ControlRoomReviewEvidenceSchemaVersionSchema
>;

export const ReviewControlAuthoritySchema = z.enum([
  'semantic_advisory',
  'deterministic_preview',
]);
export type ReviewControlAuthority = z.infer<typeof ReviewControlAuthoritySchema>;

export const ExecutionBlueprintPreviewSchema = z.object({
  blueprintId: NonEmptyStringSchema,
  contractHash: HashSchema,
  guardrailBundleHash: HashSchema,
  plannedActionRefs: z.array(NonEmptyStringSchema),
}).strict();
export type ExecutionBlueprintPreview = z.infer<
  typeof ExecutionBlueprintPreviewSchema
>;

const PlanningEvidenceRefSchema = z.object({
  evidence: PlanningTurnEvidenceSchema,
  summary: NonEmptyStringSchema,
}).strict();

const AllowedPlanningEvidenceRefSchema = PlanningEvidenceRefSchema
  .superRefine((ref, ctx) => requireOutcome(ref.evidence.outcome, 'allow', ctx));
const BlockedDriftEvidenceRefSchema = PlanningEvidenceRefSchema
  .superRefine((ref, ctx) => requireOutcome(ref.evidence.outcome, 'block', ctx));
const RetryEvidenceRefSchema = PlanningEvidenceRefSchema
  .superRefine((ref, ctx) => requireOutcome(ref.evidence.outcome, 'retry', ctx));
const EscalationEvidenceRefSchema = PlanningEvidenceRefSchema
  .superRefine((ref, ctx) => requireOutcome(ref.evidence.outcome, 'escalate', ctx));

export const ReviewWarningSchema = z.object({
  warningId: NonEmptyStringSchema,
  clauseId: z.string().min(1).optional(),
  railId: z.string().min(1).optional(),
  summary: NonEmptyStringSchema,
  authority: z.literal('semantic_advisory'),
}).strict();
export type ReviewWarning = z.infer<typeof ReviewWarningSchema>;

export const DeterministicHandoffPreviewSchema = z.object({
  policyBundleHash: HashSchema.optional(),
  deterministicControlRefs: z.array(z.object({
    controlId: NonEmptyStringSchema,
    clauseId: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    authority: z.literal('deterministic_preview'),
  }).strict()),
  semanticAdvisoryRefs: z.array(z.object({
    controlId: NonEmptyStringSchema,
    clauseId: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    authority: z.literal('semantic_advisory'),
  }).strict()),
}).strict();
export type DeterministicHandoffPreview = z.infer<
  typeof DeterministicHandoffPreviewSchema
>;

export const ControlRoomReviewEvidenceAttachmentSchema = z.object({
  schemaVersion: ControlRoomReviewEvidenceSchemaVersionSchema,
  attachmentId: NonEmptyStringSchema,
  generatedAt: z.string().datetime({ offset: false }),
  executionBlueprint: ExecutionBlueprintPreviewSchema,
  contractHash: HashSchema,
  guardrailBundleHash: HashSchema,
  guardrailBundleIdentity: z.object({
    compilerId: NonEmptyStringSchema,
    compilerVersion: NonEmptyStringSchema,
    targetRuntime: PlanningGuardrailTargetRuntimeSchema,
    generatedConfigs: z.array(PlanningGuardrailGeneratedConfigSchema).min(1),
  }).strict(),
  plannerTurnIds: z.array(NonEmptyStringSchema),
  allowedPlanning: z.array(AllowedPlanningEvidenceRefSchema),
  blockedDriftAttempts: z.array(BlockedDriftEvidenceRefSchema),
  retries: z.array(RetryEvidenceRefSchema),
  escalations: z.array(EscalationEvidenceRefSchema),
  unresolvedWarnings: z.array(ReviewWarningSchema),
  deterministicHandoffPreview: DeterministicHandoffPreviewSchema,
  requiresHumanApproval: z.literal(true),
  evidenceAuthority: PlanningGuardrailEvidenceAuthoritySchema,
}).strict().superRefine((attachment, ctx) => {
  if (attachment.contractHash !== attachment.executionBlueprint.contractHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'contractHash mismatch between attachment and ExecutionBlueprint',
      path: ['executionBlueprint', 'contractHash'],
    });
  }
  if (attachment.guardrailBundleHash
    !== attachment.executionBlueprint.guardrailBundleHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'guardrailBundleHash mismatch between attachment and ExecutionBlueprint',
      path: ['executionBlueprint', 'guardrailBundleHash'],
    });
  }
});
export type ControlRoomReviewEvidenceAttachment = z.infer<
  typeof ControlRoomReviewEvidenceAttachmentSchema
>;

function requireOutcome(
  actual: string,
  expected: string,
  ctx: z.RefinementCtx,
): void {
  if (actual !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `evidence outcome must be ${expected}`,
      path: ['evidence', 'outcome'],
    });
  }
}
