import type {
  SemanticBranchAlias,
  SemanticChunkIdentity,
  SemanticSourceCommitSnapshot,
} from '../contracts/semanticSearch.js';

export type LexicalIndexStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';
export type LexicalTombstoneKind = 'deleted' | 'ignored' | 'policy_banned';

export interface LexicalIndexDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly sourceSnapshot?: SemanticSourceCommitSnapshot;
  readonly branchAliases?: SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticChunkIdentity;
}

export interface LexicalIndexMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: Record<string, string | number | boolean>;
  readonly sourceSnapshot?: SemanticSourceCommitSnapshot;
  readonly branchAliases?: readonly SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticChunkIdentity;
}

export interface LexicalIndexResult {
  readonly status: LexicalIndexStatus;
  readonly resultCount: number;
  readonly matches: LexicalIndexMatch[];
  readonly degradationReasons: string[];
}

export interface LexicalIndexAdapter {
  upsert(projectId: string, documents: readonly LexicalIndexDocument[]): Promise<LexicalIndexResult>;
  search(projectId: string, query: string, topK: number): Promise<LexicalIndexResult>;
  delete(
    projectId: string,
    documentIds: readonly string[],
    options?: { readonly tombstoneKind?: LexicalTombstoneKind },
  ): Promise<LexicalIndexResult>;
}

const NOOP_LEXICAL_INDEX_BRAND = Symbol('hoplon.noopLexicalIndex');

type BrandedLexicalIndexAdapter = LexicalIndexAdapter & {
  [NOOP_LEXICAL_INDEX_BRAND]?: true;
};

function unavailable(): LexicalIndexResult {
  return {
    status: 'UNAVAILABLE',
    resultCount: 0,
    matches: [],
    degradationReasons: ['lexical_index_provider_not_bound'],
  };
}

export function createNoopLexicalIndex(): LexicalIndexAdapter {
  const adapter: BrandedLexicalIndexAdapter = {
    [NOOP_LEXICAL_INDEX_BRAND]: true,
    async upsert(): Promise<LexicalIndexResult> {
      return unavailable();
    },
    async search(): Promise<LexicalIndexResult> {
      return unavailable();
    },
    async delete(): Promise<LexicalIndexResult> {
      return unavailable();
    },
  };
  return adapter;
}

export function isNoopLexicalIndexAdapter(
  adapter: LexicalIndexAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedLexicalIndexAdapter | null | undefined)?.[
      NOOP_LEXICAL_INDEX_BRAND
    ],
  );
}
