/**
 * adapters/vectorStore/inMemory.ts — deterministic in-process reference
 * `VectorStoreAdapter` for the t-034 semantic-search seam.
 *
 * This is NOT a production-quality vector index. It is a small, deterministic
 * store that fulfils the adapter contract so the engine can prove the real
 * Layer 1 retrieval path end-to-end without pulling in SQLite-vec, pgvector,
 * Qdrant, or any other backend.
 *
 * ## Design
 * - Records are held in an in-memory `Map<id, VectorRecord>` — upsert replaces.
 * - `search` computes cosine similarity against every record, applies the
 *   optional metadata-equality filter, and returns the top-K results sorted
 *   descending by score. Ties break on `id` (ascending) so the output is
 *   deterministic.
 * - `delete` removes the record if present; silently succeeds if absent.
 *
 * The store is fully in-process and zero-dependency. Real hosts swap it for
 * SQLite-vec, pgvector, Qdrant, Pinecone, etc. through the same adapter slot.
 */

import type {
  VectorRecord,
  VectorSearchResult,
  VectorStoreAdapter,
} from '../vectorStore.js';

/**
 * Create an in-memory reference vector store.
 *
 * Records are kept in insertion order within the backing `Map`; `search`
 * computes cosine similarity against every record each call (O(n) scan), which
 * is acceptable for proof / test corpora and keeps the implementation trivial.
 */
export function createInMemoryVectorStore(): VectorStoreAdapter {
  const records = new Map<string, VectorRecord>();

  return {
    async upsert(record: VectorRecord): Promise<void> {
      // Clone the record so later caller mutations of metadata/vector do not
      // bleed into stored state (matches the implicit copy semantics callers
      // expect from a persistent store).
      records.set(record.id, {
        id: record.id,
        vector: [...record.vector],
        metadata: { ...record.metadata },
      });
    },

    async search(
      query: number[],
      topK: number,
      filter?: Record<string, string | number | boolean>,
    ): Promise<VectorSearchResult[]> {
      if (topK <= 0 || records.size === 0 || query.length === 0) return [];

      const queryNorm = l2Norm(query);
      if (queryNorm === 0) return [];

      const scored: VectorSearchResult[] = [];
      for (const record of records.values()) {
        if (!matchesFilter(record.metadata, filter)) continue;
        if (record.vector.length !== query.length) continue;

        const recordNorm = l2Norm(record.vector);
        if (recordNorm === 0) continue;

        const dot = dotProduct(query, record.vector);
        // Cosine similarity in [-1, 1]; clamp to [0, 1] for the result schema.
        const cosine = dot / (queryNorm * recordNorm);
        const score = Math.max(0, Math.min(1, cosine));

        scored.push({
          id: record.id,
          score,
          metadata: { ...record.metadata },
        });
      }

      // Deterministic ordering: score desc, id asc on ties.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      return scored.slice(0, topK);
    },

    async delete(id: string): Promise<void> {
      records.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, deterministic)
// ---------------------------------------------------------------------------

function dotProduct(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i]! * b[i]!;
  return sum;
}

function l2Norm(v: readonly number[]): number {
  let sumSquares = 0;
  for (const x of v) sumSquares += x * x;
  return Math.sqrt(sumSquares);
}

function matchesFilter(
  metadata: Record<string, string | number | boolean>,
  filter: Record<string, string | number | boolean> | undefined,
): boolean {
  if (filter === undefined) return true;
  for (const key of Object.keys(filter)) {
    if (metadata[key] !== filter[key]) return false;
  }
  return true;
}
