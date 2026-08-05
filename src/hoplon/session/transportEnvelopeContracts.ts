import { z } from 'zod';

import { AuditResultSchema } from '../contracts/audit.js';
import { PreflightResultSchema } from '../contracts/preflight.js';
import { RevertResultSchema } from '../contracts/revert.js';
import { RollbackTemplateSchema } from '../contracts/rollbackTemplate.js';
import { SemanticOverlayRefreshResultSchema } from '../contracts/semanticSearch.js';
import { SnapshotRefSchema } from '../contracts/snapshot.js';
import { SESSION_ERROR_KINDS } from './errors.js';
import type { SessionSnapshot, SessionState } from './types.js';
import {
  SESSION_TRANSPORT_ERROR_KINDS,
  SessionStateSchema,
} from './transportRequestContracts.js';
import {
  ApplyEditsChangeKindCountsSchema,
  SessionErrorTransportDetailsSchema,
  SessionIdentitySchema,
  SessionSnapshotSchema,
  SessionTransitionSchema,
  type SessionIdentity,
} from './transportResponseContracts.js';

const QuickEditSessionTraceSchema = z.object({
  sessionId: z.string().min(1),
  finalState: SessionStateSchema,
  history: z.array(SessionTransitionSchema),
  preflightResult: PreflightResultSchema.nullable(),
  snapshotRef: SnapshotRefSchema.nullable(),
  changedFiles: z.array(z.string().min(1)),
  applyEdits: z
    .object({
      changedFiles: z.array(z.string().min(1)),
      bytesWritten: z.number().int().nonnegative(),
      changeKindCounts: ApplyEditsChangeKindCountsSchema,
      overlayRefresh: SemanticOverlayRefreshResultSchema.optional(),
    })
    .nullable(),
});

const QuickEditFailureErrorSchema = z.object({
  class: z.string().min(1),
  kind: z.string().min(1),
  message: z.string().min(1),
  details: SessionErrorTransportDetailsSchema.nullable(),
});

const QuickEditPassResultSchema = QuickEditSessionTraceSchema.extend({
  outcome: z.literal('pass'),
  auditResult: AuditResultSchema,
});

const QuickEditPreflightBlockResultSchema = QuickEditSessionTraceSchema.extend({
  outcome: z.literal('block'),
  phase: z.literal('preflight'),
  preflightResult: PreflightResultSchema,
});

const QuickEditAuditBlockResultSchema = QuickEditSessionTraceSchema.extend({
  outcome: z.literal('block'),
  phase: z.literal('audit'),
  auditResult: AuditResultSchema,
  revertResult: RevertResultSchema.nullable(),
  rollbackTemplate: RollbackTemplateSchema.nullable(),
});

const QuickEditFailureResultSchema = QuickEditSessionTraceSchema.extend({
  outcome: z.literal('failed'),
  phase: z.enum([
    'preflight',
    'createSnapshot',
    'applyEdits',
    'markEdited',
    'audit',
    'revert',
    'extractRollbackTemplate',
    'close',
  ]),
  error: QuickEditFailureErrorSchema,
  auditResult: AuditResultSchema.nullable(),
  revertResult: RevertResultSchema.nullable(),
  rollbackTemplate: RollbackTemplateSchema.nullable(),
});

/**
 * zod's `discriminatedUnion` requires unique values on a single discriminator.
 * Our shape is doubly-discriminated (`outcome` + `phase`), so we use a plain
 * union — runtime validation still exhausts all branches and the inferred
 * TypeScript type remains a discriminated union over `outcome` / `phase`.
 */
export const QuickEditResultDataSchema = z.union([
  QuickEditPassResultSchema,
  QuickEditPreflightBlockResultSchema,
  QuickEditAuditBlockResultSchema,
  QuickEditFailureResultSchema,
]);

export type QuickEditResultData = z.infer<typeof QuickEditResultDataSchema>;

export function createSessionResponseSchema<T extends z.ZodTypeAny>(
  dataSchema: T,
) {
  return z.object({
    session: SessionIdentitySchema,
    state: SessionStateSchema,
    historyLength: z.number().int().nonnegative(),
    data: dataSchema,
  });
}

export const InspectSessionResponseSchema = z.object({
  session: SessionIdentitySchema,
  state: SessionStateSchema,
  snapshot: SessionSnapshotSchema,
});
export interface InspectSessionResponse {
  session: SessionIdentity;
  state: SessionState;
  snapshot: SessionSnapshot;
}

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionIdentitySchema),
});
export interface ListSessionsResponse {
  sessions: readonly SessionIdentity[];
}

export const SessionErrorEnvelopeSchema = z.object({
  error: z.object({
    class: z.literal('SessionError'),
    kind: z.enum(SESSION_ERROR_KINDS),
    message: z.string().min(1),
    correlationId: z.string().min(1),
    details: SessionErrorTransportDetailsSchema,
  }),
});

export const SessionTransportErrorEnvelopeSchema = z.object({
  error: z.object({
    class: z.literal('SessionTransportError'),
    kind: z.enum(SESSION_TRANSPORT_ERROR_KINDS),
    message: z.string().min(1),
    correlationId: z.string().min(1),
  }),
});

export const AnySessionErrorEnvelopeSchema = z.object({
  error: z.discriminatedUnion('class', [
    SessionErrorEnvelopeSchema.shape.error,
    SessionTransportErrorEnvelopeSchema.shape.error,
  ]),
});

export interface SessionResponse<T> {
  session: SessionIdentity;
  state: SessionState;
  historyLength: number;
  data: T;
}

export type SessionSnapshotResponse = z.infer<typeof SessionSnapshotSchema>;
export type SessionErrorEnvelope = z.infer<typeof SessionErrorEnvelopeSchema>;
export type SessionTransportErrorEnvelope = z.infer<
  typeof SessionTransportErrorEnvelopeSchema
>;
export type AnySessionErrorEnvelope = z.infer<
  typeof AnySessionErrorEnvelopeSchema
>;
