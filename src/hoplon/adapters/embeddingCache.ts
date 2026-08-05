export type EmbeddingCacheStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface EmbeddingCacheRecord {
  readonly key: string;
  readonly vector: number[];
  readonly modelId: string;
  readonly contentHash: string;
  readonly updatedAt: string;
}

export interface EmbeddingCacheLookupResult {
  readonly status: EmbeddingCacheStatus;
  readonly record: EmbeddingCacheRecord | null;
  readonly degradationReasons: string[];
}

export interface EmbeddingCacheWriteResult {
  readonly status: EmbeddingCacheStatus;
  readonly degradationReasons: string[];
}

export interface EmbeddingCacheAdapter {
  get(key: string): Promise<EmbeddingCacheLookupResult>;
  put(record: EmbeddingCacheRecord): Promise<EmbeddingCacheWriteResult>;
  delete(key: string): Promise<EmbeddingCacheWriteResult>;
}

const NOOP_EMBEDDING_CACHE_BRAND = Symbol('hoplon.noopEmbeddingCache');

type BrandedEmbeddingCacheAdapter = EmbeddingCacheAdapter & {
  [NOOP_EMBEDDING_CACHE_BRAND]?: true;
};

function unavailable() {
  return {
    status: 'UNAVAILABLE' as const,
    degradationReasons: ['embedding_cache_provider_not_bound'],
  };
}

export function createNoopEmbeddingCache(): EmbeddingCacheAdapter {
  const adapter: BrandedEmbeddingCacheAdapter = {
    [NOOP_EMBEDDING_CACHE_BRAND]: true,
    async get(): Promise<EmbeddingCacheLookupResult> {
      return { ...unavailable(), record: null };
    },
    async put(): Promise<EmbeddingCacheWriteResult> {
      return unavailable();
    },
    async delete(): Promise<EmbeddingCacheWriteResult> {
      return unavailable();
    },
  };
  return adapter;
}

export function isNoopEmbeddingCacheAdapter(
  adapter: EmbeddingCacheAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedEmbeddingCacheAdapter | null | undefined)?.[
      NOOP_EMBEDDING_CACHE_BRAND
    ],
  );
}
