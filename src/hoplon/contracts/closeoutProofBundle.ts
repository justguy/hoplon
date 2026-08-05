import { z } from 'zod';

import { SessionReviewPayloadSchema } from './reviewPayload.js';
import { VerifyBehaviorResultSchema } from './verifyBehavior.js';
import { ProofVerbositySchema } from './proofVerbosity.js';

export const CloseoutProofBundleSchema = z.object({
  closeoutProofBundleSchemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  state: z.string().min(1),
  generatedAt: z.string().min(1),
  proofVerbosity: ProofVerbositySchema,
  snapshotRefId: z.string().min(1).nullable(),
  changedFiles: z.array(z.string().min(1)),
  historyLength: z.number().int().nonnegative(),
  proofRefs: z.object({
    auditRef: z.string().min(1).nullable(),
    snapshotRef: z.string().min(1).nullable(),
    rollbackSnapshotRef: z.string().min(1).nullable(),
  }),
  results: z.object({
    preflightStatus: z.enum(['PASS', 'BLOCK']).nullable(),
    auditStatus: z.enum(['PASS', 'BLOCK']).nullable(),
    violationCount: z.number().int().nonnegative(),
    revertAvailable: z.boolean(),
    rollbackTemplateAvailable: z.boolean(),
    behaviorVerificationOutcome: z.enum(['PASS', 'FAIL', 'NOT_RUN']).nullable(),
  }),
  review: SessionReviewPayloadSchema.optional(),
  behaviorVerification: VerifyBehaviorResultSchema.optional(),
  notes: z.array(z.string().min(1)),
});
export type CloseoutProofBundle = z.infer<typeof CloseoutProofBundleSchema>;
