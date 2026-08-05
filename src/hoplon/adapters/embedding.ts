/**
 * adapters/embedding.ts — EmbeddingAdapter interface (optional).
 *
 * Phase 2 default: createNoopEmbedding() — returns empty array for any input.
 * Phase 3 swap targets: SQLite-vec, pgvector, OpenAI embeddings API, local
 *   sentence-transformers model. Contract is stable; implementation is swappable.
 *
 * This adapter is optional; the engine substitutes a noop when absent.
 * All ML adapter slots are no-op in Phase 2 — implementations are Phase 3.
 */

// ---------------------------------------------------------------------------
// EmbeddingAdapter interface
// ---------------------------------------------------------------------------

export interface EmbeddingAdapter {
  /**
   * Produce a dense vector embedding of the given text.
   *
   * Returns a fixed-length float array (the embedding).
   * Dimension is implementation-defined and consistent within a deployment.
   *
   * The noop implementation always returns [] (empty array).
   * Phase 3 swap targets: SQLite-vec, pgvector, OpenAI text-embedding-3-small,
   * local sentence-transformers.
   */
  embed(text: string): Promise<number[]>;
}

const NOOP_EMBEDDING_BRAND = Symbol('hoplon.noopEmbedding');

type BrandedEmbeddingAdapter = EmbeddingAdapter & {
  [NOOP_EMBEDDING_BRAND]?: true;
};

// ---------------------------------------------------------------------------
// No-op factory — Phase 2 default
// ---------------------------------------------------------------------------

/**
 * Create a no-op EmbeddingAdapter that always returns an empty vector.
 *
 * Used as the default when the optional embedding adapter is not provided
 * to createHoplonEngine(). Zero cost: no I/O, no model inference.
 * Phase 3 will provide a real implementation behind this same contract.
 */
export function createNoopEmbedding(): EmbeddingAdapter {
  const adapter: BrandedEmbeddingAdapter = {
    [NOOP_EMBEDDING_BRAND]: true,
    async embed(_text: string): Promise<number[]> {
      return [];
    },
  };
  return adapter;
}

export function isNoopEmbeddingAdapter(
  adapter: EmbeddingAdapter | null | undefined,
): boolean {
  return Boolean((adapter as BrandedEmbeddingAdapter | null | undefined)?.[NOOP_EMBEDDING_BRAND]);
}
