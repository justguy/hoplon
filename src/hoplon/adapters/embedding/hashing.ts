/**
 * adapters/embedding/hashing.ts — deterministic, zero-dependency reference
 * `EmbeddingAdapter` for the t-034 semantic-search seam.
 *
 * This is NOT a production-quality semantic model. It is a small, deterministic
 * embedding that fulfils the adapter contract so the engine can prove the
 * real Layer 1 retrieval path end-to-end without pulling in an external model,
 * a network call, or a native dependency.
 *
 * ## Design
 * The adapter tokenizes the input string on non-alphanumeric-underscore
 * boundaries, lowercases each token, hashes it with FNV-1a into a fixed
 * `dimensions`-wide vector by incrementing the slot at `hash % dimensions`,
 * and L2-normalises the resulting vector so cosine similarity reduces to a
 * dot product.
 *
 * The adapter is deterministic: the same string always maps to the same
 * vector. Two strings that share more tokens land closer together (non-zero
 * dot product), which is exactly what the in-memory vector store needs to
 * produce a meaningful top-K ordering in targeted proof.
 *
 * ## Bounded scope
 * This shipping-optional reference implementation is strictly for the host
 * wire path and for proof. Real hosts swap it for a dense-embedding service
 * (OpenAI, Voyage, local sentence-transformers) through the same adapter slot.
 * No engine operation hard-codes this reference — the factory binds it only
 * when the host does not pass an `embedding` adapter AND opts into the
 * reference by wiring it explicitly.
 */

import type { EmbeddingAdapter } from '../embedding.js';

export interface HashingTextEmbeddingOptions {
  /**
   * Fixed embedding dimension. Must be a positive integer. All vectors the
   * adapter returns have exactly this length.
   *
   * Default: 128. Tokens are hashed modulo `dimensions`; smaller values yield
   * coarser embeddings (more collisions) but smaller vectors.
   */
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 128;

/**
 * Create a deterministic hashing text embedding adapter.
 *
 * The returned adapter is fully in-process, zero-dependency, and deterministic:
 *   - Same input text → same vector (bytewise).
 *   - Two inputs sharing tokens have a non-zero cosine similarity.
 *   - Vectors are L2-normalised (unit length) so a dot product is cosine.
 *
 * Empty strings (after tokenisation) yield a zero vector of the configured
 * `dimensions`. Callers should guard against fully-unindexable inputs at the
 * operation layer (the semanticSearch contract already requires non-empty
 * `query` and non-empty `text` per document).
 */
export function createHashingTextEmbedding(
  options: HashingTextEmbeddingOptions = {},
): EmbeddingAdapter {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new TypeError(
      `createHashingTextEmbedding: dimensions must be a positive integer, got ${dimensions}`,
    );
  }

  return {
    async embed(text: string): Promise<number[]> {
      const vector = new Array<number>(dimensions).fill(0);
      const tokens = tokenize(text);

      for (const token of tokens) {
        const slot = fnv1aHash(token) % dimensions;
        vector[slot]! += 1;
      }

      return l2Normalize(vector);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * Split on any run of non-alphanumeric-underscore characters and lowercase.
 * Empty tokens (produced by the split when the string begins/ends with a
 * separator) are filtered out.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 0);
}

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/**
 * FNV-1a 32-bit hash over the UTF-16 code units of the token. Returns an
 * unsigned 32-bit integer so the `% dimensions` slot lookup is always
 * non-negative regardless of host arithmetic.
 */
function fnv1aHash(token: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  if (sumSquares === 0) return vector;
  const norm = Math.sqrt(sumSquares);
  return vector.map((v) => v / norm);
}
