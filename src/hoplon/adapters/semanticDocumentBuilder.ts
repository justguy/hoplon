export type SemanticDocumentBuilderStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';

export interface SemanticDocumentBuildInput {
  readonly projectId: string;
  readonly files: readonly string[];
}

export interface SemanticDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly contentHash: string;
}

export interface SemanticDocumentBuildResult {
  readonly status: SemanticDocumentBuilderStatus;
  readonly documents: SemanticDocument[];
  readonly resultCount: number;
  readonly degradationReasons: string[];
}

export interface SemanticDocumentBuilderAdapter {
  build(input: SemanticDocumentBuildInput): Promise<SemanticDocumentBuildResult>;
}

const NOOP_SEMANTIC_DOCUMENT_BUILDER_BRAND = Symbol(
  'hoplon.noopSemanticDocumentBuilder',
);

type BrandedSemanticDocumentBuilderAdapter = SemanticDocumentBuilderAdapter & {
  [NOOP_SEMANTIC_DOCUMENT_BUILDER_BRAND]?: true;
};

export function createNoopSemanticDocumentBuilder(): SemanticDocumentBuilderAdapter {
  const adapter: BrandedSemanticDocumentBuilderAdapter = {
    [NOOP_SEMANTIC_DOCUMENT_BUILDER_BRAND]: true,
    async build(): Promise<SemanticDocumentBuildResult> {
      return {
        status: 'UNAVAILABLE',
        documents: [],
        resultCount: 0,
        degradationReasons: ['semantic_document_builder_provider_not_bound'],
      };
    },
  };
  return adapter;
}

export function isNoopSemanticDocumentBuilderAdapter(
  adapter: SemanticDocumentBuilderAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedSemanticDocumentBuilderAdapter | null | undefined)?.[
      NOOP_SEMANTIC_DOCUMENT_BUILDER_BRAND
    ],
  );
}
