import { z } from 'zod';

import { AuditResultSchema } from '../contracts/audit.js';
import { WritableManifestSchema } from '../contracts/manifest.js';
import { PreflightResultSchema } from '../contracts/preflight.js';
import { RepairContextSchema } from '../contracts/repairContext.js';
import { RevertResultSchema } from '../contracts/revert.js';
import { RollbackTemplateSchema } from '../contracts/rollbackTemplate.js';
import { SessionReviewPayloadSchema } from '../contracts/reviewPayload.js';
import { SemanticOverlayRefreshResultSchema } from '../contracts/semanticSearch.js';
import { SnapshotRefSchema } from '../contracts/snapshot.js';
import { VerifyBehaviorResultSchema } from '../contracts/verifyBehavior.js';
import { SESSION_RECOVERY_CLASSES } from './errors.js';
import { SessionStateSchema } from './transportRequestContracts.js';

export const SessionIdentitySchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
});
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

export const ApplyEditsChangeKindCountsSchema = z.object({
  full_file: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  structural: z.number().int().nonnegative(),
});

const SessionTransitionOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preflight'),
    status: z.enum(['PASS', 'BLOCK']),
    violationCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('createSnapshot'),
    snapshotRefId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('dryRun'),
    status: z.enum(['PASS', 'BLOCK']),
    violationCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('applyEdits'),
    changedFileCount: z.number().int().nonnegative(),
    bytesWritten: z.number().int().nonnegative(),
    changeKindCounts: ApplyEditsChangeKindCountsSchema,
  }),
  z.object({
    kind: z.literal('markEdited'),
    changedFileCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('audit'),
    status: z.enum(['PASS', 'BLOCK']),
    violationCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('revert'),
    revertedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    allowlistSkippedCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('extractRollbackTemplate'),
    fileCount: z.number().int().nonnegative(),
  }),
]);

export const SessionTransitionSchema = z.object({
  op: z.enum([
    'created',
    'preflight',
    'createSnapshot',
    'dryRun',
    'applyEdits',
    'markEdited',
    'audit',
    'revert',
    'extractRollbackTemplate',
    'close',
  ]),
  fromState: SessionStateSchema,
  toState: SessionStateSchema,
  timestampMs: z.number().int().nonnegative(),
  outcome: SessionTransitionOutcomeSchema.optional(),
});

export const SessionSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  state: SessionStateSchema,
  manifest: WritableManifestSchema,
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  engineId: z.string().min(1),
  snapshotRef: SnapshotRefSchema.nullable(),
  changedFiles: z.array(z.string().min(1)),
  lastPreflightResult: PreflightResultSchema.nullable(),
  lastDryRunResult: AuditResultSchema.nullable(),
  lastAuditResult: AuditResultSchema.nullable(),
  lastRevertResult: RevertResultSchema.nullable(),
  lastRollbackTemplate: RollbackTemplateSchema.nullable(),
  priorRepairContext: RepairContextSchema.nullable(),
  nextAttemptNumber: z.number().int().positive(),
  history: z.array(SessionTransitionSchema),
});

export const StartSessionResponseDataSchema = z.object({
  engineId: z.string().min(1),
});
export const PreflightSessionResponseDataSchema = z.object({
  result: PreflightResultSchema,
});
export const CreateSnapshotSessionResponseDataSchema = z.object({
  snapshotRef: SnapshotRefSchema,
});
export const DryRunSessionResponseDataSchema = z.object({
  result: AuditResultSchema,
});
export const ApplyEditsSessionResponseDataSchema = z.object({
  changedFiles: z.array(z.string().min(1)),
  bytesWritten: z.number().int().nonnegative(),
  changeKindCounts: ApplyEditsChangeKindCountsSchema,
  overlayRefresh: SemanticOverlayRefreshResultSchema.optional(),
});
export const StageContentSessionResponseDataSchema = z.object({
  stagingKey: z.string().min(1),
  chunks: z.number().int().nonnegative(),
  bytesStaged: z.number().int().nonnegative(),
  complete: z.boolean(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export const MarkEditedSessionResponseDataSchema = z.object({
  changedFiles: z.array(z.string().min(1)),
  overlayRefresh: SemanticOverlayRefreshResultSchema,
});
export const AuditSessionResponseDataSchema = z.object({
  result: AuditResultSchema,
});
export const RevertSessionResponseDataSchema = z.object({
  result: RevertResultSchema,
});
export const ExtractRollbackTemplateSessionResponseDataSchema = z.object({
  template: RollbackTemplateSchema,
});
export const GetRepairContextSessionResponseDataSchema = z.object({
  repairContext: RepairContextSchema,
});
export const GetReviewPayloadSessionResponseDataSchema = z.object({
  review: SessionReviewPayloadSchema,
});
export const VerifyBehaviorSessionResponseDataSchema = z.object({
  verification: VerifyBehaviorResultSchema,
});
export const CloseSessionResponseDataSchema = z.object({
  closed: z.literal(true),
});

export const SessionErrorTransportDetailsSchema = z.object({
  from: z.string().min(1),
  attempted: z.string().min(1),
  detail: z.string().min(1).optional(),
  recoveryClass: z.enum(SESSION_RECOVERY_CLASSES),
  allowedStates: z.array(SessionStateSchema).optional(),
  prerequisite: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  changeKind: z.enum(['full_file', 'patch', 'structural']).optional(),
  failedChangeIndex: z.number().int().nonnegative().optional(),
  failedHunkIndex: z.number().int().nonnegative().optional(),
  requestedSymbol: z.string().min(1).optional(),
  driftKind: z
    .enum(['bytes_diverged', 'unexpected_creation', 'unexpected_deletion'])
    .optional(),
  byteLengthBefore: z.number().int().nonnegative().nullable().optional(),
  byteLengthLive: z.number().int().nonnegative().nullable().optional(),
});

/**
 * t-079 — response schema for the single-shot quick-edit wrapper. The
 * wrapper runs the full ordered session loop and closes the session before
 * returning, so the payload captures outcome + phase + every reference the
 * caller needs to tie review/audit/rollback evidence back to the underlying
 * session artifacts (snapshotRefId, session history, auditResult,
 * revertResult, rollbackTemplate). Keep the payload content-free — counts
 * and refs only, no source slices beyond what already-shipped engine DTOs
 * permit.
 */
