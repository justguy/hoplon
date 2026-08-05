import { z } from 'zod';

export const SemanticSearchStatusSchema = z.enum([
  'AVAILABLE',
  'DEGRADED',
  'UNAVAILABLE',
  'EMPTY',
]);
export type SemanticSearchStatus = z.infer<typeof SemanticSearchStatusSchema>;

export const SemanticSidecarStatusSchema = z.enum([
  'AVAILABLE',
  'DEGRADED',
  'UNAVAILABLE',
  'EMPTY',
  'NO_VERDICT',
]);
export type SemanticSidecarStatus = z.infer<typeof SemanticSidecarStatusSchema>;

export const SemanticFreshnessSchema = z.enum([
  'indexed',
  'live_session',
  'stale',
  'unavailable',
]);
export type SemanticFreshness = z.infer<typeof SemanticFreshnessSchema>;

export const SemanticDegradationReasonSchema = z.enum([
  'provider_not_bound',
  'no_indexed_corpus',
  'embedding_unavailable',
  'embedding_cache_unavailable',
  'embedding_profile_unverified',
  'vector_index_unavailable',
  'lexical_only_profile',
  'index_context_mismatch',
  'ignore_rules_changed_full_reconcile_required',
  'index_stale',
  'overlay_reaped',
  'overlay_reaped_inactive_ttl',
  'overlay_never_created',
  'overlay_unavailable_process_local_store',
  'overlay_store_reset',
  'overlay_refresh_failed',
  'overlay_refresh_aborted',
  'overlay_refresh_stale_generation',
  'stale_index',
  'unauthorized_rows_filtered',
  'native_extension_failure',
  'empty_query_vector',
  'unindexable_document',
  'hash_only_manifest_storage',
]);
export type SemanticDegradationReason = z.infer<
  typeof SemanticDegradationReasonSchema
>;

export const SemanticStorageProfileKindSchema = z.enum([
  'wasm_sqlite_fts_vector',
  'durable_js_lexical_vector',
  'lexical_only_degraded',
  'native_sqlite_vec',
]);
export type SemanticStorageProfileKind = z.infer<
  typeof SemanticStorageProfileKindSchema
>;

export const SemanticProviderEnvelopeSchema = z.object({
  providerStatus: SemanticSearchStatusSchema,
  resultCount: z.number().int().nonnegative(),
  freshness: SemanticFreshnessSchema,
  degradationReasons: z.array(SemanticDegradationReasonSchema),
});
export type SemanticProviderEnvelope = z.infer<
  typeof SemanticProviderEnvelopeSchema
>;

export const SemanticSearchMetadataSchema = z.record(
  z.union([z.string(), z.number(), z.boolean()]),
);
export type SemanticSearchMetadata = z.infer<typeof SemanticSearchMetadataSchema>;

export const SemanticIndexingScopeSchema = z.enum([
  'full',
  'dirty_files_only',
]);
export type SemanticIndexingScope = z.infer<typeof SemanticIndexingScopeSchema>;

export const SemanticTombstoneKindSchema = z.enum([
  'deleted',
  'ignored',
  'policy_banned',
]);
export type SemanticTombstoneKind = z.infer<typeof SemanticTombstoneKindSchema>;

export const SemanticIndexContextSchema = z.object({
  worktreeId: z.string().min(1),
  headOid: z.string().min(1),
  ignoreRulesHash: z.string().min(1),
});
export type SemanticIndexContext = z.infer<typeof SemanticIndexContextSchema>;

export const SemanticEmbeddingCachePolicySchema = z
  .object({
    mode: z.enum(['project_scoped', 'shared_physical']).optional(),
    tenantNamespace: z.string().min(1).optional(),
    persistence: z.enum(['disabled', 'read_only', 'write_through']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'shared_physical' && value.tenantNamespace === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'shared_physical cache mode requires tenantNamespace',
        path: ['tenantNamespace'],
      });
    }
  });
export type SemanticEmbeddingCachePolicy = z.infer<
  typeof SemanticEmbeddingCachePolicySchema
>;

export const SemanticTombstoneRequestSchema = z.object({
  id: z.string().min(1),
  kind: SemanticTombstoneKindSchema,
});
export type SemanticTombstoneRequest = z.infer<
  typeof SemanticTombstoneRequestSchema
>;
