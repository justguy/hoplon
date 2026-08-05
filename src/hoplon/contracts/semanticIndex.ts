import { z } from 'zod';

export const SemanticSourceCommitOidSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u);
export type SemanticSourceCommitOid = z.infer<
  typeof SemanticSourceCommitOidSchema
>;

export const SemanticSourceBranchKindSchema = z.enum([
  'local_branch',
  'remote_tracking_branch',
]);
export type SemanticSourceBranchKind = z.infer<
  typeof SemanticSourceBranchKindSchema
>;

export const SemanticSourceStaleStateSchema = z.enum([
  'fresh',
  'stale',
  'unindexed',
  'missing',
]);
export type SemanticSourceStaleState = z.infer<
  typeof SemanticSourceStaleStateSchema
>;

export const SemanticLineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    if (value.endLine < value.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endLine must be greater than or equal to startLine',
        path: ['endLine'],
      });
    }
  });
export type SemanticLineRange = z.infer<typeof SemanticLineRangeSchema>;

export const SemanticSourceCommitSnapshotSchema = z
  .object({
    sourceSnapshotId: z.string().min(1),
    projectId: z.string().min(1),
    commitOid: SemanticSourceCommitOidSchema,
    corpusSchemaVersion: z.string().min(1),
    embeddingProfileHash: z.string().min(1).optional(),
    modelProfileHash: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.embeddingProfileHash === undefined &&
      value.modelProfileHash === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'source commit snapshot requires embeddingProfileHash or modelProfileHash',
        path: ['embeddingProfileHash'],
      });
    }
  });
export type SemanticSourceCommitSnapshot = z.infer<
  typeof SemanticSourceCommitSnapshotSchema
>;

export const SemanticBranchAliasSchema = z.object({
  projectId: z.string().min(1),
  sourceSnapshotId: z.string().min(1),
  branchName: z.string().min(1),
  branchKind: SemanticSourceBranchKindSchema,
  commitOid: SemanticSourceCommitOidSchema,
  observedAtIso: z.string().datetime({ offset: true }),
  isDefault: z.boolean(),
  isCurrent: z.boolean(),
  staleState: SemanticSourceStaleStateSchema,
  remote: z.string().min(1).optional(),
});
export type SemanticBranchAlias = z.infer<typeof SemanticBranchAliasSchema>;

export const SemanticChunkIdentitySchema = z.object({
  projectId: z.string().min(1),
  sourceSnapshotId: z.string().min(1),
  chunkId: z.string().min(1),
  canonicalPath: z.string().min(1).refine(isRepoRelativePath, {
    message: 'canonicalPath must be repository-relative',
  }),
  contentHash: z.string().min(1),
  chunkHash: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  lineRange: SemanticLineRangeSchema.optional(),
  sourceProvenance: z.object({
    commitOid: SemanticSourceCommitOidSchema,
    branchNames: z.array(z.string().min(1)).optional(),
  }),
  embeddingCacheKey: z.string().min(1),
});
export type SemanticChunkIdentity = z.infer<
  typeof SemanticChunkIdentitySchema
>;

function isRepoRelativePath(path: string): boolean {
  if (path.startsWith('/')) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '..') return false;
  }
  return true;
}
