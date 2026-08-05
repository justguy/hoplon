import { z } from 'zod';

import { StrictEngagementContextSchema } from '../contracts/engagementContext.js';
import { WritableManifestSchema } from '../contracts/manifest.js';
import { ProposedChangeSchema } from '../contracts/requests.js';
import { DeclarativeInvariantBindingSchema } from '../contracts/invariantBinding.js';
import { RepairContextSchema } from '../contracts/repairContext.js';
import { TargetFirstScopedEditRequestSchema } from '../contracts/targetFirstScopedEdit.js';
import { CloseoutProofBundleSchema } from '../contracts/closeoutProofBundle.js';
import { ProofVerbositySchema } from '../contracts/proofVerbosity.js';
import {
  VerifyBehaviorOptionsSchema,
  VerifyBehaviorResultSchema,
} from '../contracts/verifyBehavior.js';

const StringifiedWritableManifestSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'manifest must be a WritableManifest object or a JSON string containing one',
    });
    return z.NEVER;
  }
}).pipe(WritableManifestSchema);

export const SESSION_TRANSPORT_ERROR_KINDS = [
  'invalid_request',
  'session_not_found',
] as const;

export const SessionStateSchema = z.enum([
  'created',
  'preflighted_pass',
  'preflighted_block',
  'snapshotted',
  'edited',
  'audited_pass',
  'audited_block',
  'reverted',
  'rollback_extracted',
  'closed',
]);

export const StartSessionRequestSchema = z.object({
  manifest: z.union([WritableManifestSchema, StringifiedWritableManifestSchema]),
  correlationId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before creating an edit session.
   */
  engagement: StrictEngagementContextSchema.optional(),
  /**
   * Optional prior repair context (t-070). When the caller is starting a
   * retry session in response to an earlier `audited_block`, passing the
   * packaged `RepairContext` here lets the new session carry the
   * cross-session attemptNumber forward without introducing a parallel
   * retry ledger.
   */
  priorRepairContext: RepairContextSchema.optional(),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

export const SessionRefSchema = z.object({
  sessionId: z.string().min(1),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before session-scoped edit/review/repair calls.
   */
  engagement: StrictEngagementContextSchema.optional(),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;

export const SessionDryRunRequestSchema = SessionRefSchema.extend({
  proposedChanges: z.array(ProposedChangeSchema).min(1),
  invariantBindings: z.array(DeclarativeInvariantBindingSchema).optional(),
});
export type SessionDryRunRequest = z.infer<typeof SessionDryRunRequestSchema>;

export const SessionApplyEditsRequestSchema = SessionRefSchema.extend({
  proposedChanges: z.array(ProposedChangeSchema).min(1),
});
export type SessionApplyEditsRequest = z.infer<
  typeof SessionApplyEditsRequestSchema
>;

/**
 * t-079 — packaged single-shot quick-edit request. The wrapper composes the
 * shipped ordered loop (preflight → createSnapshot → applyEdits | markEdited
 * → audit → [revert → extractRollbackTemplate on audit BLOCK] → close) in
 * one call, without introducing a second write mechanism. The request body
 * carries the manifest + edit payload directly because a quick-edit does
 * not survive past the call: there is no sessionId to pre-register.
 */
export const SessionQuickEditRequestSchema = z
  .object({
    manifest: z.union([WritableManifestSchema, StringifiedWritableManifestSchema]),
    correlationId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    priorRepairContext: RepairContextSchema.optional(),
    editMode: z.enum(['applyEdits', 'markEdited']).optional(),
    proposedChanges: z.array(ProposedChangeSchema).optional(),
    markEditedFiles: z.array(z.string().min(1)).optional(),
    revertOnBlock: z.boolean().optional(),
    extractRollbackTemplateOnBlock: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const editMode = value.editMode ?? 'applyEdits';
    if (editMode === 'applyEdits') {
      if (!value.proposedChanges || value.proposedChanges.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedChanges'],
          message:
            'proposedChanges must be a non-empty array when editMode is applyEdits',
        });
      }
    } else {
      if (!value.markEditedFiles || value.markEditedFiles.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['markEditedFiles'],
          message:
            'markEditedFiles must be a non-empty array when editMode is markEdited',
        });
      }
    }
  });
export type SessionQuickEditRequest = z.infer<
  typeof SessionQuickEditRequestSchema
>;

export const SessionTargetFirstScopedEditRequestSchema =
  TargetFirstScopedEditRequestSchema;
export type SessionTargetFirstScopedEditRequest = z.infer<
  typeof SessionTargetFirstScopedEditRequestSchema
>;

/**
 * t-076 — request body for the chunked staging sub-protocol. Callers
 * upload a non-binary body in ordered chunks keyed by `stagingKey`; the
 * finalized body is referenced from a `ProposedChange.stagedContent`
 * field consumed by a subsequent `session.applyEdits` call. Does not
 * advance session state and never writes to disk.
 */
export const SessionStageContentRequestSchema = SessionRefSchema.extend({
  stagingKey: z.string().min(1),
  seq: z.number().int().nonnegative(),
  /** Base64-encoded raw chunk bytes (non-binary UTF-8 body). */
  chunk: z.string(),
  isFinal: z.boolean(),
  expectedTotalSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  expectedTotalByteLength: z.number().int().nonnegative().optional(),
});
export type SessionStageContentRequest = z.infer<
  typeof SessionStageContentRequestSchema
>;

export const SessionMarkEditedRequestSchema = SessionRefSchema.extend({
  files: z.array(z.string().min(1)),
});
export type SessionMarkEditedRequest = z.infer<
  typeof SessionMarkEditedRequestSchema
>;

export const SessionExtractRollbackTemplateRequestSchema =
  SessionRefSchema.extend({
    files: z.array(z.string().min(1)).optional(),
    contractedChangesMap: z.record(z.string().min(1), z.string()).optional(),
  });
export type SessionExtractRollbackTemplateRequest = z.infer<
  typeof SessionExtractRollbackTemplateRequestSchema
>;

/**
 * t-072 — packaged review payload request. `proposedChanges` is only consulted
 * when `phase === 'preview'`; the schema reuses the widened ProposedChange
 * union so HTTP/MCP and the in-process API share one resolver path.
 *
 * t-077: `includeBlastRadius` / `blastRadiusWarnThreshold` were renamed to
 * `includeDependencyImpact` / `dependencyImpactWarnThreshold` to reflect the
 * canonical shared sidecar that replaces the old `impact.blastRadius` field.
 */
export const SessionGetReviewPayloadRequestSchema = SessionRefSchema.extend({
  phase: z.enum(['post-edit', 'preview']).optional(),
  proposedChanges: z.array(ProposedChangeSchema).optional(),
  contextLines: z.number().int().nonnegative().max(20).optional(),
  includeDependencyImpact: z.boolean().optional(),
  includeRelevantTests: z.boolean().optional(),
  includePostEditPolicyScan: z.boolean().optional(),
  dependencyImpactWarnThreshold: z.number().int().nonnegative().optional(),
  dependencyImpactPrecomputedChangedFiles: z.array(z.string().min(1)).optional(),
});
export type SessionGetReviewPayloadRequest = z.infer<
  typeof SessionGetReviewPayloadRequestSchema
>;

/**
 * t-077 — packaged repair-context request body. Optional options let the
 * caller opt into the advisory dependency-impact sidecar over the packaged
 * `audited_block` / `reverted` / `rollback_extracted` seam.
 */
export const SessionGetRepairContextRequestSchema = SessionRefSchema.extend({
  includeDependencyImpact: z.boolean().optional(),
  warnThreshold: z.number().int().nonnegative().optional(),
  behaviorVerification: VerifyBehaviorResultSchema.optional(),
  includeRetryContextCompression: z.boolean().optional(),
});
export type SessionGetRepairContextRequest = z.infer<
  typeof SessionGetRepairContextRequestSchema
>;

export const SessionGetCloseoutProofBundleRequestSchema =
  SessionRefSchema.extend({
    includeReview: z.boolean().optional(),
    includeBehaviorVerification: z.boolean().optional(),
    proofVerbosity: ProofVerbositySchema.optional(),
  });
export type SessionGetCloseoutProofBundleRequest = z.infer<
  typeof SessionGetCloseoutProofBundleRequestSchema
>;
export const SessionGetCloseoutProofBundleResponseDataSchema = z.object({
  closeoutProofBundle: CloseoutProofBundleSchema,
});

/**
 * t-067 — packaged behavior-verification request body. The options
 * mirror `VerifyBehaviorOptions` so the transport, in-process session, and
 * MCP/HTTP clients share one validation path. Legal from every session
 * state — behavior verification is advisory.
 */
export const SessionVerifyBehaviorRequestSchema = SessionRefSchema.merge(
  VerifyBehaviorOptionsSchema,
);
export type SessionVerifyBehaviorRequest = z.infer<
  typeof SessionVerifyBehaviorRequestSchema
>;
