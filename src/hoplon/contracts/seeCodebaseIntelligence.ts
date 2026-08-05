/**
 * contracts/seeCodebaseIntelligence.ts — AIC-2 read-side advisory payloads.
 *
 * These payloads sit inside the shared `AdvisoryIntelligenceSidecarEnvelope`.
 * They summarize structural read results and optional semantic-search matches
 * without changing seeCodebase routing, fallback, or deterministic verdicts.
 */

import { z } from 'zod';
import { SeeCodebaseReadProvenanceSchema } from './seeCodebaseResults.js';
import {
  SemanticDegradationReasonSchema,
  SemanticFreshnessSchema,
  SemanticSearchMetadataSchema,
  SemanticSearchStatusSchema,
} from './semanticSearch.js';

export const ReadAstNodeIdentitySchema = z.object({
  resultIndex: z.number().int().nonnegative(),
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  kind: z.string().min(1),
  nodeKind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  readProvenance: SeeCodebaseReadProvenanceSchema,
});
export type ReadAstNodeIdentity = z.infer<typeof ReadAstNodeIdentitySchema>;

export const ReadStructuralCompressionEntrySchema = z.object({
  resultIndex: z.number().int().nonnegative(),
  resultKind: z.enum(['structural', 'skeleton']),
  primitive: z.string().min(1),
  readProvenance: SeeCodebaseReadProvenanceSchema,
  rawContentIncluded: z.literal(false),
  payloadShape: z.record(z.number().int().nonnegative()),
  astNodeIdentities: z.array(ReadAstNodeIdentitySchema),
});
export type ReadStructuralCompressionEntry = z.infer<
  typeof ReadStructuralCompressionEntrySchema
>;

export const ReadStructuralCompressionPayloadSchema = z.object({
  compressionKind: z.literal('structural_read_metadata'),
  source: z.literal('seeCodebase'),
  rawContentIncluded: z.literal(false),
  entries: z.array(ReadStructuralCompressionEntrySchema),
  totals: z.object({
    structuralResults: z.number().int().nonnegative(),
    astNodeIdentities: z.number().int().nonnegative(),
  }),
});
export type ReadStructuralCompressionPayload = z.infer<
  typeof ReadStructuralCompressionPayloadSchema
>;

export const ReadSemanticRankedMatchSchema = z.object({
  rank: z.number().int().positive(),
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  metadata: SemanticSearchMetadataSchema,
  source: z.enum(['baseline', 'session_overlay']).optional(),
  rankSource: z
    .enum([
      'overlay_lexical',
      'overlay_vector',
      'baseline_lexical',
      'baseline_vector',
    ])
    .optional(),
  freshness: SemanticFreshnessSchema.optional(),
});
export type ReadSemanticRankedMatch = z.infer<
  typeof ReadSemanticRankedMatchSchema
>;

export const ReadSemanticQueryResultSchema = z.object({
  sourceAstNode: ReadAstNodeIdentitySchema,
  query: z.string().min(1),
  resultStatus: z.union([
    SemanticSearchStatusSchema,
    z.enum(['NOT_REQUESTED', 'FAILED']),
  ]),
  providerStatus: SemanticSearchStatusSchema.optional(),
  freshness: SemanticFreshnessSchema.optional(),
  degradationReasons: z.array(SemanticDegradationReasonSchema).optional(),
  rankedMatches: z.array(ReadSemanticRankedMatchSchema),
  failureReason: z.string().min(1).optional(),
});
export type ReadSemanticQueryResult = z.infer<
  typeof ReadSemanticQueryResultSchema
>;

export const ReadSemanticTwinSchema = z.object({
  sourceAstNode: ReadAstNodeIdentitySchema,
  match: ReadSemanticRankedMatchSchema,
  advisoryOnly: z.literal(true),
});
export type ReadSemanticTwin = z.infer<typeof ReadSemanticTwinSchema>;

export const ReadSemanticSearchPayloadSchema = z.object({
  source: z.literal('seeCodebase.structural_results'),
  advisoryOnly: z.literal(true),
  topK: z.number().int().positive().nullable(),
  topKSource: z.enum(['request', 'not_requested']),
  providerResultStatus: SemanticSearchStatusSchema.nullable(),
  astNodeIdentities: z.array(ReadAstNodeIdentitySchema),
  queries: z.array(ReadSemanticQueryResultSchema),
  semanticTwins: z.array(ReadSemanticTwinSchema),
  deterministicVerdictAuthority: z.literal(
    'structural_manifest_policy_only',
  ),
});
export type ReadSemanticSearchPayload = z.infer<
  typeof ReadSemanticSearchPayloadSchema
>;
