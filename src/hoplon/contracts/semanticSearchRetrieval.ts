import { z } from 'zod';

import { StrictEngagementContextSchema } from './engagementContext.js';
import {
  SemanticBranchAliasSchema,
  SemanticChunkIdentitySchema,
  SemanticSourceCommitSnapshotSchema,
} from './semanticIndex.js';
import {
  SemanticDegradationReasonSchema,
  SemanticFreshnessSchema,
  SemanticIndexContextSchema,
  SemanticSearchMetadataSchema,
  SemanticSearchStatusSchema,
} from './semanticSearchStatus.js';
import {
  SemanticSearchBranchScopeSchema,
  SemanticSearchStalePolicySchema,
  SemanticSearchSuggestionModeSchema,
} from './semanticSearchRecovery.js';

export const SemanticSearchRequestSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  /**
   * Optional outside the compatibility profile; inert there. Required by
   * strict-agent transport wrappers (together with `engagement`) before
   * semantic dispatch — see transport/strictEngagementCheck.ts.
   */
  runId: z.string().min(1).optional(),
  engagement: StrictEngagementContextSchema.optional(),
  query: z.string().min(1),
  topK: z.number().int().positive(),
  currentContext: SemanticIndexContextSchema.optional(),
  indexedContext: SemanticIndexContextSchema.optional(),
  allowStale: z.boolean().optional(),
  allowDegraded: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  freshness: z.enum(['indexed', 'live_session']).optional(),
  overlayScope: z
    .enum(['baseline_plus_session', 'session_overlay_only'])
    .optional(),
  branchScope: SemanticSearchBranchScopeSchema.optional(),
  stalePolicy: SemanticSearchStalePolicySchema.optional(),
  resultFields: z.enum(['path_only', 'path_and_symbol', 'snippet']).optional(),
  suggestionMode: SemanticSearchSuggestionModeSchema.optional(),
}).strict();
export type SemanticSearchRequest = z.infer<typeof SemanticSearchRequestSchema>;

export const SemanticSearchMatchSchema = z.object({
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
  sourceSnapshot: SemanticSourceCommitSnapshotSchema.optional(),
  branchAliases: z.array(SemanticBranchAliasSchema).optional(),
  chunkIdentity: SemanticChunkIdentitySchema.optional(),
});
export type SemanticSearchMatch = z.infer<typeof SemanticSearchMatchSchema>;

export const SemanticSearchSuggestionSchema = z.object({
  kind: z.enum([
    'branch',
    'pattern',
    'path',
    'query',
    'stale_index',
    'live_session_overlay_missing',
    'indexed_search',
    'provider_binding',
    'no_indexed_corpus',
    'corpus_indexing',
  ]),
  message: z.string().min(1),
  value: z.string().min(1).optional(),
  provenance: z.enum(['deterministic', 'semantic']).default('deterministic'),
});
export type SemanticSearchSuggestion = z.infer<typeof SemanticSearchSuggestionSchema>;

export const SemanticSearchResultSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  advisory: z.literal(true),
  status: SemanticSearchStatusSchema,
  providerStatus: SemanticSearchStatusSchema,
  providerAvailable: z.boolean(),
  resultCount: z.number().int().nonnegative(),
  freshness: SemanticFreshnessSchema,
  degradationReasons: z.array(SemanticDegradationReasonSchema),
  topK: z.number().int().positive(),
  matches: z.array(SemanticSearchMatchSchema),
  suggestions: z.array(SemanticSearchSuggestionSchema).optional(),
});
export type SemanticSearchResult = z.infer<typeof SemanticSearchResultSchema>;
