import { z } from 'zod';

import { ProposedChangeSchema } from './requests.js';
import { WritableManifestSchema } from './manifest.js';
import {
  DraftWritableManifestResultSchema,
  DraftWritableManifestTargetSchema,
} from './writableManifestDraft.js';
import { EditSliceResultSchema } from './seeCodebaseResults.js';

export const TargetFirstEditSliceRequestSchema = z.object({
  path: z.string().min(1).optional(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((value) => value.endLine >= value.startLine, {
  path: ['endLine'],
  message: 'endLine must be greater than or equal to startLine',
});

export const TargetFirstScopedEditRequestSchema = z
  .object({
    projectId: z.string().min(1),
    runId: z.string().min(1),
    correlationId: z.string().min(1),
    target: DraftWritableManifestTargetSchema,
    readOnlyFiles: z.array(z.string().min(1)).optional(),
    editSlice: TargetFirstEditSliceRequestSchema.optional(),
    proposedChanges: z.array(ProposedChangeSchema).optional(),
    apply: z.boolean().optional(),
    acceptedManifest: WritableManifestSchema.optional(),
    sessionId: z.string().min(1).optional(),
    revertOnBlock: z.boolean().optional(),
    extractRollbackTemplateOnBlock: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.apply !== true) return;
    if (value.acceptedManifest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedManifest'],
        message: 'apply=true requires an explicitly accepted WritableManifest',
      });
    }
    if (value.proposedChanges === undefined || value.proposedChanges.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedChanges'],
        message: 'apply=true requires proposedChanges',
      });
    }
  });
export type TargetFirstScopedEditRequest = z.infer<
  typeof TargetFirstScopedEditRequestSchema
>;

export const TargetFirstProofPlanSchema = z.object({
  phases: z.array(z.enum([
    'identify_target',
    'read_exact_context',
    'draft_manifest',
    'await_manifest_confirmation',
    'preflight',
    'create_snapshot',
    'dry_run',
    'apply_edits',
    'audit',
    'review',
    'close',
  ])),
  notes: z.array(z.string().min(1)),
});

export const TargetFirstScopedEditResultSchema = z.object({
  status: z.enum(['preview', 'applied']),
  manifestDraft: DraftWritableManifestResultSchema,
  editSlice: EditSliceResultSchema.optional(),
  proofPlan: TargetFirstProofPlanSchema,
  quickEditResult: z.unknown().optional(),
});
export type TargetFirstScopedEditResult = z.infer<
  typeof TargetFirstScopedEditResultSchema
>;
