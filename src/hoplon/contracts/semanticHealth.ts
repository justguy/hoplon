import { z } from 'zod';

import { SemanticSearchStatusSchema } from './semanticSearch.js';

export const SemanticCapabilityClassSchema = z.enum([
  'seam_only',
  'contract_only',
  'advisory_ready',
  'degraded',
  'disabled',
]);
export type SemanticCapabilityClass = z.infer<typeof SemanticCapabilityClassSchema>;

export const SemanticRuntimeProfileSchema = z.enum([
  'noop',
  'portable_wasm',
  'native_performance',
  'lexical_only_degraded',
  'hash_only_disabled',
]);
export type SemanticRuntimeProfile = z.infer<typeof SemanticRuntimeProfileSchema>;

export const SemanticPersistenceModeSchema = z.enum([
  'disabled',
  'process_local_overlay',
  'host_snapshot_storage',
  'hash_only_disabled',
]);
export type SemanticPersistenceMode = z.infer<typeof SemanticPersistenceModeSchema>;

export const SemanticBindingStatusSchema = z.enum(['bound', 'noop', 'disabled']);
export type SemanticBindingStatus = z.infer<typeof SemanticBindingStatusSchema>;

export const SemanticArtifactStatusSchema = z.enum([
  'available',
  'missing',
  'unverified',
  'disabled',
]);
export type SemanticArtifactStatus = z.infer<typeof SemanticArtifactStatusSchema>;

export const SemanticNativeExtensionStatusSchema = z.enum([
  'loaded',
  'unavailable',
  'failed',
  'disabled',
]);
export type SemanticNativeExtensionStatus = z.infer<
  typeof SemanticNativeExtensionStatusSchema
>;

export const SemanticAdapterHealthSchema = z.object({
  embedding: SemanticBindingStatusSchema,
  vectorStore: SemanticBindingStatusSchema,
  embeddingCache: SemanticBindingStatusSchema,
  semanticIndexStore: SemanticBindingStatusSchema,
  lexicalIndex: SemanticBindingStatusSchema,
  vectorIndex: SemanticBindingStatusSchema,
  semanticStorageProfile: SemanticBindingStatusSchema,
});
export type SemanticAdapterHealth = z.infer<typeof SemanticAdapterHealthSchema>;

export const SemanticEmbeddingHealthSchema = z.object({
  modelStatus: SemanticArtifactStatusSchema,
  artifactStatus: SemanticArtifactStatusSchema,
  modelHash: z.string().min(1).optional(),
  artifactHash: z.string().min(1).optional(),
});
export type SemanticEmbeddingHealth = z.infer<typeof SemanticEmbeddingHealthSchema>;

export const SemanticRuntimeArtifactHealthSchema = z.object({
  onnxHash: z.string().min(1).optional(),
  wasmHash: z.string().min(1).optional(),
  nativeExtensionStatus: SemanticNativeExtensionStatusSchema,
  nativeExtensionHash: z.string().min(1).optional(),
});
export type SemanticRuntimeArtifactHealth = z.infer<
  typeof SemanticRuntimeArtifactHealthSchema
>;

export const SemanticCacheHealthSchema = z.object({
  reachable: z.boolean(),
  entryCount: z.number().int().nonnegative().optional(),
});
export type SemanticCacheHealth = z.infer<typeof SemanticCacheHealthSchema>;

export const SemanticIndexHealthSchema = z.object({
  reachable: z.boolean(),
  documentCount: z.number().int().nonnegative().optional(),
  lastIndexedAt: z.string().min(1).optional(),
});
export type SemanticIndexHealth = z.infer<typeof SemanticIndexHealthSchema>;

export const SemanticOverlayHealthSchema = z.object({
  activeOverlayCount: z.number().int().nonnegative(),
  reapedOverlayCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  vectorCount: z.number().int().nonnegative(),
  maskCount: z.number().int().nonnegative(),
});
export type SemanticOverlayHealth = z.infer<typeof SemanticOverlayHealthSchema>;

export const SemanticTombstoneHealthSchema = z.object({
  reachable: z.boolean(),
  count: z.number().int().nonnegative().optional(),
});
export type SemanticTombstoneHealth = z.infer<typeof SemanticTombstoneHealthSchema>;

export const SemanticHealthSchema = z.object({
  status: SemanticSearchStatusSchema,
  capabilityClass: SemanticCapabilityClassSchema,
  runtimeProfile: SemanticRuntimeProfileSchema,
  persistenceMode: SemanticPersistenceModeSchema,
  adapters: SemanticAdapterHealthSchema,
  embedding: SemanticEmbeddingHealthSchema,
  runtimeArtifacts: SemanticRuntimeArtifactHealthSchema,
  cache: SemanticCacheHealthSchema,
  index: SemanticIndexHealthSchema,
  overlays: SemanticOverlayHealthSchema,
  tombstones: SemanticTombstoneHealthSchema,
  degradationReasons: z.array(z.string().min(1)),
});
export type SemanticHealth = z.infer<typeof SemanticHealthSchema>;
