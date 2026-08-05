import { z } from 'zod';
import type { AuditResult } from './audit.js';

export const InvariantAstTargetSchema = z.object({
  file: z.string().min(1),
  symbolPath: z.array(z.string().min(1)).min(1),
  nodeKind: z.string().min(1).optional(),
  byteRange: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});
export type InvariantAstTarget = z.infer<typeof InvariantAstTargetSchema>;

export const InvariantNodeProvenanceSchema = z.object({
  file: z.string().min(1),
  symbolPath: z.array(z.string().min(1)).min(1),
  nodeKind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  provenanceKind: z.literal('tree_sitter_ast_node'),
});
export type InvariantNodeProvenance = z.infer<
  typeof InvariantNodeProvenanceSchema
>;

const InvariantBaseSchema = z.object({
  id: z.string().min(1),
});

export const ExportedSymbolExistsInvariantSchema = InvariantBaseSchema.extend({
  kind: z.literal('exported_symbol_exists'),
  file: z.string().min(1),
  symbolName: z.string().min(1),
  expectedNodeKind: z.string().min(1).optional(),
});

export const FunctionShapeInvariantSchema = InvariantBaseSchema.extend({
  kind: z.literal('function_shape'),
  target: InvariantAstTargetSchema,
  async: z.boolean().optional(),
  returnAnnotation: z.string().min(1).optional(),
});

export const DtoFieldPresenceInvariantSchema = InvariantBaseSchema.extend({
  kind: z.literal('dto_field_presence'),
  target: InvariantAstTargetSchema,
  fieldName: z.string().min(1),
});

export const RouteToolContractShapeInvariantSchema = InvariantBaseSchema.extend({
  kind: z.literal('route_tool_contract_shape'),
  target: InvariantAstTargetSchema,
  requiredFields: z.array(z.string().min(1)).min(1),
});

export const UnsupportedInvariantSchema = InvariantBaseSchema.extend({
  kind: z.literal('unsupported'),
  requestedKind: z.string().min(1),
  target: InvariantAstTargetSchema.optional(),
});

export const DeclarativeInvariantBindingSchema = z.discriminatedUnion('kind', [
  ExportedSymbolExistsInvariantSchema,
  FunctionShapeInvariantSchema,
  DtoFieldPresenceInvariantSchema,
  RouteToolContractShapeInvariantSchema,
  UnsupportedInvariantSchema,
]);
export type DeclarativeInvariantBinding = z.infer<
  typeof DeclarativeInvariantBindingSchema
>;

export const INVARIANT_CHECK_STATUSES = [
  'PROVED',
  'REJECTED',
  'DEGRADED',
  'UNSUPPORTED',
  'NO_VERDICT',
] as const;
export const InvariantCheckStatusSchema = z.enum(INVARIANT_CHECK_STATUSES);
export type InvariantCheckStatus = z.infer<typeof InvariantCheckStatusSchema>;

export const INVARIANT_CHECK_REASONS = [
  'proved',
  'missing_export',
  'node_kind_mismatch',
  'function_async_mismatch',
  'function_return_mismatch',
  'missing_field',
  'missing_required_field',
  'target_not_in_preview',
  'target_not_resolved',
  'target_ambiguous',
  'target_identity_stale',
  'parse_failed',
  'unsupported_invariant_kind',
] as const;
export const InvariantCheckReasonSchema = z.enum(INVARIANT_CHECK_REASONS);
export type InvariantCheckReason = z.infer<typeof InvariantCheckReasonSchema>;

export const InvariantCheckResultSchema = z.object({
  invariantId: z.string().min(1),
  invariantKind: z.string().min(1),
  status: InvariantCheckStatusSchema,
  reason: InvariantCheckReasonSchema,
  message: z.string().min(1),
  blocking: z.literal(false),
  provenance: InvariantNodeProvenanceSchema.nullable(),
});
export type InvariantCheckResult = z.infer<
  typeof InvariantCheckResultSchema
>;

export const DeclarativeInvariantReportSchema = z.object({
  version: z.literal(1),
  blockingEnabled: z.literal(false),
  results: z.array(InvariantCheckResultSchema),
});
export type DeclarativeInvariantReport = z.infer<
  typeof DeclarativeInvariantReportSchema
>;

export type DryRunResult = AuditResult & {
  readonly invariantReport?: DeclarativeInvariantReport;
};
