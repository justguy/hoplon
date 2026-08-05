/** t-120 typed syntax-node lookup plus advisory parser-health sidecar. */

import { z } from 'zod';
import { StrictEngagementContextSchema } from './engagementContext.js';
import { SUPPORTED_QUERY_LANGUAGES } from './queryStructure.js';

const ByteRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end >= start, 'byteRange end must be >= start');

const PointSchema = z.object({
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});

const SyntaxNodeLookupTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('byte_offset'),
    byteOffset: z.number().int().nonnegative(),
    namedOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('byte_range'),
    byteRange: ByteRangeSchema,
    namedOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('position'),
    position: PointSchema,
    endPosition: PointSchema.optional(),
    namedOnly: z.boolean().optional(),
  }),
]);
export type SyntaxNodeLookupTarget = z.infer<typeof SyntaxNodeLookupTargetSchema>;

export const FindSyntaxNodeRequestSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  engagement: StrictEngagementContextSchema.optional(),
  file: z.string().min(1),
  target: SyntaxNodeLookupTargetSchema,
  includeText: z.boolean().optional(),
});
export type FindSyntaxNodeRequest = z.infer<typeof FindSyntaxNodeRequestSchema>;

export const SyntaxNodeSummarySchema = z.object({
  kind: z.string().min(1),
  byteRange: ByteRangeSchema,
  startPosition: PointSchema,
  endPosition: PointSchema,
  named: z.boolean(),
  missing: z.boolean(),
  error: z.boolean(),
  text: z.string().optional(),
});
export type SyntaxNodeSummary = z.infer<typeof SyntaxNodeSummarySchema>;

export const SyntaxHealthNodeSchema = z.object({
  kind: z.string().min(1),
  byteRange: ByteRangeSchema,
  missing: z.boolean(),
  error: z.boolean(),
});
export type SyntaxHealthNode = z.infer<typeof SyntaxHealthNodeSchema>;

export const SyntaxHealthSidecarSchema = z.object({
  advisory: z.literal(true),
  status: z.enum(['OK', 'SYNTAX_RECOVERED', 'UNAVAILABLE']),
  language: z.enum(SUPPORTED_QUERY_LANGUAGES).nullable(),
  grammarVersion: z.string().nullable(),
  hasError: z.boolean(),
  errorNodes: z.array(SyntaxHealthNodeSchema),
  missingNodes: z.array(SyntaxHealthNodeSchema),
  degradationReason: z
    .enum([
      'unsupported_extension',
      'file_not_found',
      'file_too_large',
      'parse_failed',
      'raw_tree_unavailable',
    ])
    .nullable(),
});
export type SyntaxHealthSidecar = z.infer<typeof SyntaxHealthSidecarSchema>;

export const FindSyntaxNodeResultSchema = z.object({
  correlationId: z.string().min(1),
  advisory: z.literal(true),
  status: z.enum([
    'FOUND',
    'INVALID_TARGET',
    'UNSUPPORTED_FILE',
    'FILE_NOT_FOUND',
    'FILE_TOO_LARGE',
    'PARSE_FAILED',
  ]),
  file: z.string().min(1),
  node: SyntaxNodeSummarySchema.nullable(),
  ancestors: z.array(SyntaxNodeSummarySchema),
  parserStatus: SyntaxHealthSidecarSchema,
  failureReason: z
    .enum([
      'byte_offset_out_of_bounds',
      'byte_range_out_of_bounds',
      'invalid_utf8_byte_boundary',
      'position_out_of_bounds',
      'unsupported_extension',
      'file_not_found',
      'file_too_large',
      'parse_failed',
      'raw_tree_unavailable',
    ])
    .nullable(),
});
export type FindSyntaxNodeResult = z.infer<typeof FindSyntaxNodeResultSchema>;
