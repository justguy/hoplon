import type {
  SemanticBranchAlias,
  SemanticChunkIdentity,
  SemanticSourceCommitSnapshot,
} from '../contracts/semanticSearch.js';

export type VectorIndexStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';
export type VectorTombstoneKind = 'deleted' | 'ignored' | 'policy_banned';

export interface VectorIndexRecord {
  readonly id: string;
  readonly vector: number[];
  readonly metadata: Record<string, string | number | boolean>;
  readonly sourceSnapshot?: SemanticSourceCommitSnapshot;
  readonly branchAliases?: SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticChunkIdentity;
}

export interface VectorIndexMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: Record<string, string | number | boolean>;
  readonly sourceSnapshot?: SemanticSourceCommitSnapshot;
  readonly branchAliases?: readonly SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticChunkIdentity;
}

export interface VectorIndexResult {
  readonly status: VectorIndexStatus;
  readonly resultCount: number;
  readonly matches: VectorIndexMatch[];
  readonly degradationReasons: string[];
}

export interface VectorIndexAdapter {
  upsert(projectId: string, records: readonly VectorIndexRecord[]): Promise<VectorIndexResult>;
  search(projectId: string, query: readonly number[], topK: number): Promise<VectorIndexResult>;
  delete(
    projectId: string,
    recordIds: readonly string[],
    options?: { readonly tombstoneKind?: VectorTombstoneKind },
  ): Promise<VectorIndexResult>;
}

const NOOP_VECTOR_INDEX_BRAND = Symbol('hoplon.noopVectorIndex');

type BrandedVectorIndexAdapter = VectorIndexAdapter & {
  [NOOP_VECTOR_INDEX_BRAND]?: true;
};

function unavailable(): VectorIndexResult {
  return {
    status: 'UNAVAILABLE',
    resultCount: 0,
    matches: [],
    degradationReasons: ['vector_index_provider_not_bound'],
  };
}

export function createNoopVectorIndex(): VectorIndexAdapter {
  const adapter: BrandedVectorIndexAdapter = {
    [NOOP_VECTOR_INDEX_BRAND]: true,
    async upsert(): Promise<VectorIndexResult> {
      return unavailable();
    },
    async search(): Promise<VectorIndexResult> {
      return unavailable();
    },
    async delete(): Promise<VectorIndexResult> {
      return unavailable();
    },
  };
  return adapter;
}

export function isNoopVectorIndexAdapter(
  adapter: VectorIndexAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedVectorIndexAdapter | null | undefined)?.[
      NOOP_VECTOR_INDEX_BRAND
    ],
  );
}
