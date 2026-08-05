/**
 * adapters/vectorStore.ts — VectorStoreAdapter interface (optional).
 *
 * Phase 2 default: createNoopVectorStore() — all operations are no-ops.
 * Phase 3 swap targets: SQLite-vec, pgvector, Qdrant, Pinecone, Chroma.
 *
 * This adapter is optional; the engine substitutes a noop when absent.
 * All ML adapter slots are no-op in Phase 2 — implementations are Phase 3.
 *
 * Used by the semantic discovery layer (CI3 Layer 1) — finds contextually
 * relevant code by meaning rather than by exact name.
 */

// ---------------------------------------------------------------------------
// VectorRecord — the unit of storage
// ---------------------------------------------------------------------------

export interface VectorRecord {
  /** Content-addressable or caller-supplied identifier for this record. */
  id: string;
  /** The dense vector embedding of the content. */
  vector: number[];
  /** Arbitrary metadata stored alongside the vector. */
  metadata: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// SearchResult — returned by VectorStoreAdapter.search
// ---------------------------------------------------------------------------

export interface VectorSearchResult {
  /** Record identifier. */
  id: string;
  /** Cosine or dot-product similarity score in [0, 1]. */
  score: number;
  /** Metadata stored with this record. */
  metadata: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// VectorStoreAdapter interface
// ---------------------------------------------------------------------------

export interface VectorStoreAdapter {
  /**
   * Insert or update a vector record by id.
   * Upsert semantics: if the id already exists, the vector and metadata
   * are replaced. Fire-and-forget for no-op implementations.
   */
  upsert(record: VectorRecord): Promise<void>;

  /**
   * Find the topK most similar records to the query vector.
   * Returns results sorted descending by similarity score.
   *
   * `filter` is an optional metadata equality filter — only records whose
   * stored metadata contains every (key, value) pair in `filter` are
   * considered. Implementations that cannot support a metadata filter natively
   * (including the no-op) may ignore the argument; the `semanticSearch`
   * operation re-verifies project-scoping on the returned records before they
   * reach the caller, so ignoring `filter` can never leak across projects.
   *
   * The noop implementation always returns [].
   */
  search(
    query: number[],
    topK: number,
    filter?: Record<string, string | number | boolean>,
  ): Promise<VectorSearchResult[]>;

  /**
   * Delete the record with the given id.
   * Silently succeeds if the id does not exist.
   * No-op for noop implementations.
   */
  delete(id: string): Promise<void>;
}

const NOOP_VECTOR_STORE_BRAND = Symbol('hoplon.noopVectorStore');

type BrandedVectorStoreAdapter = VectorStoreAdapter & {
  [NOOP_VECTOR_STORE_BRAND]?: true;
};

// ---------------------------------------------------------------------------
// No-op factory — Phase 2 default
// ---------------------------------------------------------------------------

/**
 * Create a no-op VectorStoreAdapter.
 *
 * upsert: discards the record silently.
 * search: always returns an empty results array.
 * delete: silently succeeds.
 *
 * Used as the default when the optional vectorStore adapter is not provided
 * to createHoplonEngine(). Zero cost: no I/O, no model inference.
 * Phase 3 will provide a real implementation behind this same contract.
 */
export function createNoopVectorStore(): VectorStoreAdapter {
  const adapter: BrandedVectorStoreAdapter = {
    [NOOP_VECTOR_STORE_BRAND]: true,
    async upsert(_record: VectorRecord): Promise<void> {
      // noop — discard silently
    },
    async search(
      _query: number[],
      _topK: number,
      _filter?: Record<string, string | number | boolean>,
    ): Promise<VectorSearchResult[]> {
      return [];
    },
    async delete(_id: string): Promise<void> {
      // noop — silently succeeds
    },
  };
  return adapter;
}

export function isNoopVectorStoreAdapter(
  adapter: VectorStoreAdapter | null | undefined,
): boolean {
  return Boolean((adapter as BrandedVectorStoreAdapter | null | undefined)?.[NOOP_VECTOR_STORE_BRAND]);
}
