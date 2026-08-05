/**
 * util/hashManifest.ts — content-addressable snapshot ID generator.
 *
 * Phase 2 HA1: IDs are now prefixed with the algorithm name for hash agility.
 * New format: `sha256:<64-char-hex>` (73 chars total).
 * Old bare-hex IDs (64 chars) are still accepted by the reader for backward compat (H19).
 *
 * hcr-001: snapshot identity now covers manifest JSON PLUS the actual file
 * bytes at snapshot time. The canonical snapshot-ID producer is
 * hashManifestWithContent(manifest, contentHashes) — same manifest with
 * different file bytes yields a different snapshot ID, so a stale committed
 * ref can never be reused for changed content. This is invariant H1. Every
 * other component that computes a snapshot ID must call that function — no
 * inline reimplementations.
 *
 * hashManifest(manifest) remains the manifest-only digest primitive (used by
 * callers that need a manifest fingerprint, not a snapshot ID).
 *
 * Uses Node.js built-in crypto. No external hashing library.
 */

import { createHash } from 'node:crypto';
import { stableStringify } from './stableStringify.js';
import type { WritableManifest } from '../contracts/manifest.js';

/**
 * The hash algorithm used for content-addressable snapshot IDs.
 * Named constant for hash agility — change here to migrate to a new algorithm.
 * Phase 2: 'sha256'. Phase 4 may introduce 'sha3-256' or 'blake3'.
 */
export const HASH_ALGORITHM = 'sha256' as const;

/**
 * Compute the content-addressable snapshot ID for a manifest.
 * Returns a prefixed string: `sha256:<64-char-lowercase-hex>`.
 *
 * Same manifest → same ID (key order is normalised by stableStringify).
 * Different manifest → different ID (sha256 collision resistance).
 *
 * Phase 2 HA1: the `sha256:` prefix is required for new IDs.
 * Old bare-hex IDs remain valid for backward compatibility — the reader
 * (SnapshotStore.get) accepts both forms. See also: addHashPrefix, stripHashPrefix.
 */
export function hashManifest(manifest: WritableManifest): string {
  const serialized = stableStringify(manifest);
  const hexDigest = createHash(HASH_ALGORITHM).update(serialized, 'utf8').digest('hex');
  return `${HASH_ALGORITHM}:${hexDigest}`;
}

/**
 * Per-entry content evidence for snapshot identity (hcr-001).
 * `contentSha256` is the lowercase-hex sha256 of the file bytes read through
 * the fs adapter at snapshot time; `null` means the contracted file was
 * absent at snapshot time (distinct from an empty file's digest).
 */
export interface ManifestContentHash {
  readonly path: string;
  readonly contentSha256: string | null;
}

/**
 * Compute the lowercase-hex sha256 digest of raw file bytes.
 * Shared by the createSnapshot single-read pipeline and by tests that need
 * to predict snapshot identity without reimplementing the digest.
 */
export function hashFileContent(bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM).update(bytes).digest('hex');
}

/**
 * Canonical snapshot-ID producer (H1, hcr-001).
 *
 * Identity = manifest JSON + per-path content digests, so:
 *   - same manifest + same file bytes  → same ID (idempotent reuse preserved)
 *   - same manifest + changed bytes    → different ID (no stale-ref reuse)
 *
 * `contentHashes` are deduplicated by path and sorted before serialization,
 * so entry order (and duplicate manifest entries) cannot perturb the ID.
 * Returns a prefixed string: `sha256:<64-char-lowercase-hex>`.
 */
export function hashManifestWithContent(
  manifest: WritableManifest,
  contentHashes: readonly ManifestContentHash[],
): string {
  const byPath = new Map<string, string | null>();
  for (const entry of contentHashes) {
    byPath.set(entry.path, entry.contentSha256);
  }
  const canonicalContent = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, contentSha256]) => ({ path, contentSha256 }));
  const serialized = stableStringify({ contentHashes: canonicalContent, manifest });
  const hexDigest = createHash(HASH_ALGORITHM).update(serialized, 'utf8').digest('hex');
  return `${HASH_ALGORITHM}:${hexDigest}`;
}

/**
 * Upgrade a legacy bare-hex snapshot ID to the current prefixed format.
 *
 * Migration helper for callers that stored bare IDs before Phase 2 HA1.
 * Idempotent: if the ID is already prefixed, it is returned unchanged.
 *
 * @param oldId  A 64-char bare-hex ID OR an already-prefixed ID.
 * @returns      The same ID with a `sha256:` prefix.
 * @throws       TypeError if the input is neither a valid bare-hex nor prefixed ID.
 */
export function addHashPrefix(oldId: string): string {
  if (oldId.startsWith(`${HASH_ALGORITHM}:`)) {
    // Already prefixed — idempotent
    return oldId;
  }
  if (/^[0-9a-f]{64}$/.test(oldId)) {
    return `${HASH_ALGORITHM}:${oldId}`;
  }
  throw new TypeError(
    `addHashPrefix: expected a 64-char bare hex ID or a prefixed ID, got: ${JSON.stringify(oldId)}`,
  );
}

/**
 * Strip the algorithm prefix from a snapshot ID, returning the bare hex digest.
 *
 * Used internally by the reader to normalize IDs before DB lookup.
 * Accepts both prefixed (`sha256:<hex>`) and bare-hex forms.
 *
 * @param id  A prefixed ID or a bare 64-char hex ID.
 * @returns   The 64-char bare hex digest.
 */
export function stripHashPrefix(id: string): string {
  const prefix = `${HASH_ALGORITHM}:`;
  if (id.startsWith(prefix)) {
    return id.slice(prefix.length);
  }
  return id;
}
