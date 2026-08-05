import type {
  SemanticBranchAlias,
  SemanticChunkIdentity,
  SemanticSourceCommitSnapshot,
} from '../contracts/semanticSearch.js';

export type SemanticIndexStoreStatus = 'AVAILABLE' | 'UNAVAILABLE';
export type SemanticIndexFreshness = 'indexed' | 'live_session' | 'stale' | 'unavailable';

export interface SemanticIndexDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly contentHash: string;
  readonly sourceSnapshot?: SemanticSourceCommitSnapshot;
  readonly branchAliases?: readonly SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticChunkIdentity;
}

export interface SemanticIndexLookupResult {
  readonly status: SemanticIndexStoreStatus;
  readonly documents: SemanticIndexDocument[];
  readonly freshness: SemanticIndexFreshness;
  readonly degradationReasons: string[];
}

export interface SemanticIndexWriteResult {
  readonly status: SemanticIndexStoreStatus;
  readonly writtenCount: number;
  readonly freshness: SemanticIndexFreshness;
  readonly degradationReasons: string[];
}

export interface SemanticIndexStoreAdapter {
  read(projectId: string): Promise<SemanticIndexLookupResult>;
  write(projectId: string, documents: readonly SemanticIndexDocument[]): Promise<SemanticIndexWriteResult>;
  delete(projectId: string, documentIds: readonly string[]): Promise<SemanticIndexWriteResult>;
}

const NOOP_SEMANTIC_INDEX_STORE_BRAND = Symbol('hoplon.noopSemanticIndexStore');

type BrandedSemanticIndexStoreAdapter = SemanticIndexStoreAdapter & {
  [NOOP_SEMANTIC_INDEX_STORE_BRAND]?: true;
};

function unavailable(writtenCount = 0) {
  return {
    status: 'UNAVAILABLE' as const,
    writtenCount,
    freshness: 'unavailable' as const,
    degradationReasons: ['semantic_index_store_provider_not_bound'],
  };
}

export function createNoopSemanticIndexStore(): SemanticIndexStoreAdapter {
  const adapter: BrandedSemanticIndexStoreAdapter = {
    [NOOP_SEMANTIC_INDEX_STORE_BRAND]: true,
    async read(): Promise<SemanticIndexLookupResult> {
      return { ...unavailable(), documents: [] };
    },
    async write(): Promise<SemanticIndexWriteResult> {
      return unavailable();
    },
    async delete(): Promise<SemanticIndexWriteResult> {
      return unavailable();
    },
  };
  return adapter;
}

export function isNoopSemanticIndexStoreAdapter(
  adapter: SemanticIndexStoreAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedSemanticIndexStoreAdapter | null | undefined)?.[
      NOOP_SEMANTIC_INDEX_STORE_BRAND
    ],
  );
}
