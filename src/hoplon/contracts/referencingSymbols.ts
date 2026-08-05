/**
 * contracts/referencingSymbols.ts — t-118 advisory referencing-symbol lookup.
 *
 * This contract exposes an agent-facing lookup over the existing
 * CodeIntelligenceAdapter.findReferences seam. It is advisory-only and never
 * participates in audit PASS/BLOCK decisions.
 */

import { z } from 'zod';

const ByteRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end >= start, 'byteRange end must be >= start');

export const ReferencingSymbolIdentitySchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  byteRange: ByteRangeSchema,
  path: z.string().min(1).optional(),
});
export type ReferencingSymbolIdentity = z.infer<
  typeof ReferencingSymbolIdentitySchema
>;

export const ReferencingSymbolTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('symbol_identity'),
    symbol: ReferencingSymbolIdentitySchema,
  }),
  z.object({
    type: z.literal('symbol_query'),
    path: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1).optional(),
  }),
]);
export type ReferencingSymbolTarget = z.infer<
  typeof ReferencingSymbolTargetSchema
>;

export const FindReferencingSymbolsRequestSchema = z.object({
  projectId: z.string().min(1),
  correlationId: z.string().min(1),
  target: ReferencingSymbolTargetSchema,
});
export type FindReferencingSymbolsRequest = z.infer<
  typeof FindReferencingSymbolsRequestSchema
>;

export const ReferencingSymbolTargetResolutionSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'unresolved', 'unsupported']),
  symbol: ReferencingSymbolIdentitySchema.nullable(),
  candidates: z.array(ReferencingSymbolIdentitySchema),
  reason: z
    .enum([
      'direct_symbol',
      'matched_symbol',
      'file_not_found',
      'file_too_large',
      'parse_failed',
      'no_matching_symbol',
      'multiple_matching_symbols',
      'invalid_path',
    ])
    .optional(),
});
export type ReferencingSymbolTargetResolution = z.infer<
  typeof ReferencingSymbolTargetResolutionSchema
>;

export const ReferencingSymbolReferenceSchema = z.object({
  path: z.string().min(1),
  byteRange: ByteRangeSchema,
  containingSymbol: ReferencingSymbolIdentitySchema.nullable(),
  symbolResolution: z.enum([
    'resolved',
    'file_not_found',
    'file_too_large',
    'parse_failed',
    'no_enclosing_symbol',
    'invalid_path',
  ]),
});
export type ReferencingSymbolReference = z.infer<
  typeof ReferencingSymbolReferenceSchema
>;

export const FindReferencingSymbolsResultSchema = z.object({
  correlationId: z.string().min(1),
  advisory: z.literal(true),
  status: z.enum([
    'AVAILABLE',
    'UNAVAILABLE',
    'AMBIGUOUS_TARGET',
    'UNRESOLVED_TARGET',
    'UNSUPPORTED_TARGET',
    'PROVIDER_ERROR',
  ]),
  providerStatus: z.enum(['available', 'unavailable', 'error']),
  targetResolution: ReferencingSymbolTargetResolutionSchema,
  references: z.array(ReferencingSymbolReferenceSchema),
  files: z.array(z.string().min(1)),
  referenceCount: z.number().int().nonnegative(),
  providerError: z
    .object({ kind: z.literal('find_references_failed') })
    .nullable(),
});
export type FindReferencingSymbolsResult = z.infer<
  typeof FindReferencingSymbolsResultSchema
>;
