import { z } from 'zod';
import { InvariantNodeProvenanceSchema } from './invariantBinding.js';

export const RETRY_CONTEXT_COMPRESSION_STATUSES = [
  'AVAILABLE',
  'DEGRADED',
] as const;
export const RetryContextCompressionStatusSchema = z.enum(
  RETRY_CONTEXT_COMPRESSION_STATUSES,
);
export type RetryContextCompressionStatus = z.infer<
  typeof RetryContextCompressionStatusSchema
>;

export const RETRY_CONTEXT_COMPRESSION_DEGRADED_REASONS = [
  'no_ast_node_provenance',
  'no_behavior_verification',
  'no_raw_log_pointer',
] as const;
export const RetryContextCompressionDegradedReasonSchema = z.enum(
  RETRY_CONTEXT_COMPRESSION_DEGRADED_REASONS,
);
export type RetryContextCompressionDegradedReason = z.infer<
  typeof RetryContextCompressionDegradedReasonSchema
>;

export const RetryContextPrimaryFailureSchema = z.object({
  source: z.enum(['audit', 'behavior']),
  kind: z.string().min(1),
  path: z.string().min(1).nullable(),
  message: z.string().min(1),
  correction: z.string().min(1).nullable(),
});
export type RetryContextPrimaryFailure = z.infer<
  typeof RetryContextPrimaryFailureSchema
>;

export const RetryContextFocusedDiagnosticSchema = z.object({
  source: z.enum(['audit', 'behavior']),
  kind: z.string().min(1),
  path: z.string().min(1).nullable(),
  message: z.string().min(1),
  nodeProvenance: InvariantNodeProvenanceSchema.nullable(),
});
export type RetryContextFocusedDiagnostic = z.infer<
  typeof RetryContextFocusedDiagnosticSchema
>;

export const RetryContextRawLogPointerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('verify_behavior_evidence'),
    runnerId: z.string().min(1).nullable(),
    generatedAt: z.string().min(1),
    evidenceFields: z.array(z.enum(['stdout', 'stderr', 'structured'])),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal('not_provided'),
    reason: z.literal('behavior_verification_not_supplied'),
  }),
  z.object({
    kind: z.literal('selection_not_run_policy'),
    reason: z.literal('selection_empty_conservative'),
    runnerId: z.string().min(1).nullable(),
    generatedAt: z.string().min(1),
  }),
]);
export type RetryContextRawLogPointer = z.infer<
  typeof RetryContextRawLogPointerSchema
>;

export const RetryContextCompressionSchema = z.object({
  version: z.literal(1),
  status: RetryContextCompressionStatusSchema,
  degradedReasons: z.array(RetryContextCompressionDegradedReasonSchema),
  primaryFailure: RetryContextPrimaryFailureSchema,
  focusedDiagnostics: z.array(RetryContextFocusedDiagnosticSchema),
  runnerStatus: z.object({
    status: z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']).nullable(),
    outcome: z.enum(['PASS', 'FAIL', 'NOT_RUN']).nullable(),
    exitKind: z.string().min(1).nullable(),
  }),
  rawLogPointer: RetryContextRawLogPointerSchema,
  decisiveEvidence: z.object({
    primaryFailurePreserved: z.literal(true),
    runnerStatusPreserved: z.boolean(),
    editedNodeProvenancePreserved: z.boolean(),
    rawLogPointerPreserved: z.boolean(),
  }),
});
export type RetryContextCompression = z.infer<
  typeof RetryContextCompressionSchema
>;
