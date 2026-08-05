/**
 * contracts/speculativeEditSandbox.ts — t-127 A/B edit sandbox DTO.
 *
 * The sandbox compares candidate edits in host-owned isolated sessions, then
 * optionally adopts the selected candidate through the normal Hoplon session
 * write path. This contract describes the observable result; it does not
 * expose raw git branch/checkout/reset/stash controls to agents.
 */

import { z } from 'zod';

import { ProposedChangeSchema } from './requests.js';

export const SpeculativeEditCandidateSchema = z.object({
  candidateId: z.string().min(1),
  proposedChanges: z.array(ProposedChangeSchema).min(1),
});
export type SpeculativeEditCandidate = z.infer<
  typeof SpeculativeEditCandidateSchema
>;

export const SpeculativeCandidateOutcomeSchema = z.enum([
  'pass',
  'block',
  'failed',
]);
export type SpeculativeCandidateOutcome = z.infer<
  typeof SpeculativeCandidateOutcomeSchema
>;

export const SpeculativeCandidateCleanupStatusSchema = z.enum([
  'CLEANED',
  'FAILED',
  'NOT_APPLICABLE',
]);
export type SpeculativeCandidateCleanupStatus = z.infer<
  typeof SpeculativeCandidateCleanupStatusSchema
>;

export const SpeculativeCandidateEvaluationSchema = z.object({
  candidateId: z.string().min(1),
  outcome: SpeculativeCandidateOutcomeSchema,
  eligibleForAdoption: z.boolean(),
  sessionId: z.string().min(1).nullable(),
  snapshotRefId: z.string().min(1).nullable(),
  changedFiles: z.array(z.string().min(1)),
  auditStatus: z.enum(['PASS', 'BLOCK']).nullable(),
  phase: z.string().min(1).nullable(),
  sandboxId: z.string().min(1).nullable(),
  transcriptRef: z.string().min(1).nullable(),
  cleanupStatus: SpeculativeCandidateCleanupStatusSchema,
  cleanupError: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type SpeculativeCandidateEvaluation = z.infer<
  typeof SpeculativeCandidateEvaluationSchema
>;

export const SpeculativeAdoptionStatusSchema = z.enum([
  'ADOPTED',
  'CONFLICT',
  'FAILED',
  'NOT_REQUESTED',
  'NOT_ATTEMPTED',
]);
export type SpeculativeAdoptionStatus = z.infer<
  typeof SpeculativeAdoptionStatusSchema
>;

export const SpeculativeEditAdoptionSchema = z.object({
  status: SpeculativeAdoptionStatusSchema,
  candidateId: z.string().min(1).nullable(),
  activeBaseRef: z.string().min(1),
  activeRefAtAdoption: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  snapshotRefId: z.string().min(1).nullable(),
  changedFiles: z.array(z.string().min(1)),
  auditStatus: z.enum(['PASS', 'BLOCK']).nullable(),
  phase: z.string().min(1).nullable(),
  error: z.unknown().optional(),
});
export type SpeculativeEditAdoption = z.infer<
  typeof SpeculativeEditAdoptionSchema
>;

export const SpeculativeEditSandboxOutcomeSchema = z.enum([
  'ADOPTED',
  'WINNER_SELECTED',
  'NO_WINNER',
  'ADOPTION_CONFLICT',
  'ADOPTION_FAILED',
]);
export type SpeculativeEditSandboxOutcome = z.infer<
  typeof SpeculativeEditSandboxOutcomeSchema
>;

export const SpeculativeEditSandboxResultSchema = z
  .object({
    version: z.literal(1),
    mechanism: z.literal('isolated_session_sandbox'),
    selectionStrategy: z.literal('first_pass_in_input_order'),
    activeBaseRef: z.string().min(1),
    outcome: SpeculativeEditSandboxOutcomeSchema,
    selectedCandidateId: z.string().min(1).nullable(),
    candidates: z.array(SpeculativeCandidateEvaluationSchema).min(1),
    adoption: SpeculativeEditAdoptionSchema,
    correlationId: z.string().min(1),
    generatedAt: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'NO_WINNER' && value.selectedCandidateId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedCandidateId'],
        message: 'NO_WINNER results must not select a candidate',
      });
    }
    if (value.outcome === 'ADOPTED' && value.adoption.status !== 'ADOPTED') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adoption', 'status'],
        message: 'ADOPTED outcome requires ADOPTED adoption status',
      });
    }
    if (
      value.outcome === 'ADOPTION_CONFLICT' &&
      value.adoption.status !== 'CONFLICT'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adoption', 'status'],
        message: 'ADOPTION_CONFLICT requires CONFLICT adoption status',
      });
    }
  });
export type SpeculativeEditSandboxResult = z.infer<
  typeof SpeculativeEditSandboxResultSchema
>;
