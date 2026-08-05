import { z } from 'zod';

import { StrictEngagementContextSchema } from './engagementContext.js';
import {
  SemanticBranchAliasSchema,
  SemanticChunkIdentitySchema,
  SemanticSourceCommitSnapshotSchema,
} from './semanticIndex.js';
import {
  SemanticDegradationReasonSchema,
  SemanticEmbeddingCachePolicySchema,
  SemanticFreshnessSchema,
  SemanticIndexContextSchema,
  SemanticIndexingScopeSchema,
  SemanticSearchMetadataSchema,
  SemanticSearchStatusSchema,
  SemanticTombstoneRequestSchema,
} from './semanticSearchStatus.js';

export const SemanticCorpusDocumentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  documentTextHash: z.string().min(1).optional(),
  embeddingProfileHash: z.string().min(1).optional(),
  embeddingProfileVerified: z.boolean().optional(),
  sourceSnapshot: SemanticSourceCommitSnapshotSchema.optional(),
  branchAliases: z.array(SemanticBranchAliasSchema).optional(),
  chunkIdentity: SemanticChunkIdentitySchema.optional(),
  metadata: SemanticSearchMetadataSchema.optional(),
});
export type SemanticCorpusDocument = z.infer<typeof SemanticCorpusDocumentSchema>;

export const IndexSemanticCorpusRequestSchema = z
  .object({
    correlationId: z.string().min(1),
    projectId: z.string().min(1),
    /**
     * Optional outside the compatibility profile; inert there. Required by
     * strict-agent transport wrappers (together with `engagement`) before
     * semantic dispatch — see transport/strictEngagementCheck.ts.
     */
    runId: z.string().min(1).optional(),
    engagement: StrictEngagementContextSchema.optional(),
    documents: z.array(SemanticCorpusDocumentSchema).min(1),
    scope: SemanticIndexingScopeSchema.optional(),
    indexContext: SemanticIndexContextSchema.optional(),
    deletedDocumentIds: z.array(z.string().min(1)).optional(),
    versionDeletedDocumentIds: z.array(z.string().min(1)).optional(),
    tombstones: z.array(SemanticTombstoneRequestSchema).optional(),
    ignoreRulesChanged: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    cache: SemanticEmbeddingCachePolicySchema.optional(),
  })
  .superRefine((value, ctx) => {
    for (let i = 0; i < value.documents.length; i += 1) {
      const document = value.documents[i];
      if (document === undefined) continue;
      if (
        document.sourceSnapshot !== undefined &&
        document.sourceSnapshot.projectId !== value.projectId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sourceSnapshot.projectId must match request projectId',
          path: ['documents', i, 'sourceSnapshot', 'projectId'],
        });
      }
      if (
        document.chunkIdentity !== undefined &&
        document.chunkIdentity.projectId !== value.projectId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'chunkIdentity.projectId must match request projectId',
          path: ['documents', i, 'chunkIdentity', 'projectId'],
        });
      }
      const aliases = document.branchAliases ?? [];
      for (let j = 0; j < aliases.length; j += 1) {
        const alias = aliases[j];
        if (alias === undefined) continue;
        if (alias.projectId !== value.projectId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'branchAliases projectId must match request projectId',
            path: ['documents', i, 'branchAliases', j, 'projectId'],
          });
        }
      }
    }
  });
export type IndexSemanticCorpusRequest = z.infer<
  typeof IndexSemanticCorpusRequestSchema
>;

export const IndexSemanticCorpusResultSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  status: SemanticSearchStatusSchema,
  providerStatus: SemanticSearchStatusSchema,
  providerAvailable: z.boolean(),
  resultCount: z.number().int().nonnegative(),
  freshness: SemanticFreshnessSchema,
  degradationReasons: z.array(SemanticDegradationReasonSchema),
  indexedCount: z.number().int().nonnegative(),
  requestedCount: z.number().int().nonnegative(),
  reusedCount: z.number().int().nonnegative().optional(),
  embeddedCount: z.number().int().nonnegative().optional(),
  cacheHitCount: z.number().int().nonnegative().optional(),
  cacheMissCount: z.number().int().nonnegative().optional(),
  cacheWriteCount: z.number().int().nonnegative().optional(),
  tombstonedCount: z.number().int().nonnegative().optional(),
});
export type IndexSemanticCorpusResult = z.infer<
  typeof IndexSemanticCorpusResultSchema
>;
