/**
 * adapters/lockProvider/subFileAst.ts — Sub-file AST-node LockProvider (t-041).
 *
 * Wraps any LockProvider with key namespacing at AST-node granularity so that:
 *   - Two operations on different AST subtrees in the same file run in parallel.
 *   - Two operations on the same AST subtree are serialized.
 *   - Two operations on overlapping AST subtrees are serialized (conservative:
 *     overlap is detected via byteRange intersection; BOTH node keys are acquired
 *     in sorted order to prevent deadlock before the operation begins).
 *   - Two operations on the same logical node in different files run in parallel
 *     (the project + path namespace ensures keyspace isolation).
 *
 * Key format:
 *   ast:<projectId>:<filePath>:<kind>@<start>-<end>
 *
 * Design invariants:
 *   - C3 LockProvider contract is unchanged — the returned value is a plain
 *     LockProvider that accepts arbitrary string keys.  The caller may still
 *     call acquire() with a raw key if needed.
 *   - No new npm dependencies.  Pure wrapper — no side effects beyond lock
 *     acquire/release delegated to baseLockProvider.
 *   - Multi-key acquisition order is lexicographic-ascending to guarantee
 *     deadlock freedom when two callers try to lock overlapping ranges.
 *   - Release idempotency is inherited from baseLockProvider (each delegated
 *     release is idempotent; the composite release calls each once).
 *
 * Slice: t-041 Sub-file AST mutexes
 * Future Bucket reference: ARCHITECTURE.md § "Sub-file structural mutexes"
 */

import type { LockProvider, Release } from '../lock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for createSubFileAstLockProvider. */
export interface SubFileAstLockProviderOptions {
  /**
   * Underlying LockProvider (e.g. createAsyncMutexLockProvider() or
   * createRedisRedlockProvider()).  The wrapper delegates all actual
   * serialization to this provider — it only translates keys.
   */
  baseLockProvider: LockProvider;
}

/**
 * Minimal AST-node descriptor required to compute a lock key.
 *
 * `byteRange` — [startByte, endByte] (exclusive upper bound, same convention
 * as tree-sitter's `node.startIndex` / `node.endIndex`).
 *
 * `kind` — optional tree-sitter node type string (e.g. `'function_declaration'`).
 * When omitted the key uses `'node'` as the kind segment, which is still unique
 * by byteRange.
 */
export interface AstNodeDescriptor {
  byteRange: [number, number];
  kind?: string;
}

// ---------------------------------------------------------------------------
// Pure key helper
// ---------------------------------------------------------------------------

/**
 * Computes the canonical lock key string for an AST node.
 *
 * Format: `ast:<projectId>:<filePath>:<kind>@<start>-<end>`
 *
 * This is a pure function — no I/O, no side effects.  Safe to call in tests
 * or any non-adapter layer purely for string inspection.
 *
 * @param projectId  Project identifier (e.g. 'proj-a').
 * @param filePath   File path relative or absolute — used as-is in the key.
 *                   Callers should canonicalize (forward slashes, no trailing
 *                   slash) before calling if path-equivalence matters.
 * @param node       AST node descriptor with a `byteRange` and optional `kind`.
 */
export function astNodeLockKey(
  projectId: string,
  filePath: string,
  node: AstNodeDescriptor,
): string {
  const kind = node.kind ?? 'node';
  const [start, end] = node.byteRange;
  return `ast:${projectId}:${filePath}:${kind}@${start}-${end}`;
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/**
 * Returns true when two byte ranges overlap (share at least one byte).
 * Uses the standard interval overlap predicate: A.start < B.end && B.start < A.end.
 * Ranges that are adjacent but non-overlapping (A.end === B.start) return false.
 */
function byteRangesOverlap(
  a: [number, number],
  b: [number, number],
): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Acquires the lock for an AST node, executes `fn`, then releases the lock.
 *
 * This is a single-node shorthand.  For overlapping-range locking use
 * `lockAstRegionMulti` or call `subFileAstProvider.acquire()` directly.
 *
 * The lock is always released in a `finally` block, so exceptions inside `fn`
 * do not leave the lock dangling.
 *
 * @param provider   A SubFileAstLockProvider (or any LockProvider that
 *                   understands `astNodeLockKey`-format keys).
 * @param projectId  Project identifier.
 * @param filePath   File path.
 * @param node       AST node descriptor.
 * @param fn         Async work to perform while the lock is held.
 */
export async function lockAstRegion<T>(
  provider: LockProvider,
  projectId: string,
  filePath: string,
  node: AstNodeDescriptor,
  fn: () => Promise<T>,
): Promise<T> {
  const key = astNodeLockKey(projectId, filePath, node);
  const release = await provider.acquire(key);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a sub-file AST LockProvider that namespaces lock keys at AST-node
 * granularity.
 *
 * The returned `LockProvider` is a plain LockProvider — callers may use it
 * anywhere a `LockProvider` is expected.  Keys are expected to be computed
 * via `astNodeLockKey(...)` (or the `lockAstRegion` convenience wrapper),
 * but arbitrary string keys also work — they are passed through verbatim.
 *
 * Overlap detection is NOT automatic when calling `acquire(key: string)`
 * directly (the raw key API cannot know about other pending ranges).
 * Use `lockAstRegionMulti` (below) when you need overlap-aware multi-key
 * acquisition.
 *
 * Usage:
 *   const base = createAsyncMutexLockProvider();
 *   const astLock = createSubFileAstLockProvider({ baseLockProvider: base });
 *
 *   // Single node — convenience wrapper:
 *   await lockAstRegion(astLock, 'proj', '/src/a.ts', { byteRange: [0, 100] }, async () => { ... });
 *
 *   // Two overlapping nodes — manual multi-lock:
 *   const keys = [
 *     astNodeLockKey('proj', '/src/a.ts', nodeA),
 *     astNodeLockKey('proj', '/src/a.ts', nodeB),
 *   ];
 *   const releases = await lockAstRegionMulti(base, keys);
 *   try { ... } finally { releases(); }
 */
export function createSubFileAstLockProvider(
  options: SubFileAstLockProviderOptions,
): LockProvider {
  const { baseLockProvider } = options;

  async function acquire(key: string): Promise<Release> {
    return baseLockProvider.acquire(key);
  }

  return { acquire };
}

// ---------------------------------------------------------------------------
// Multi-key acquisition helper (overlap-aware)
// ---------------------------------------------------------------------------

/**
 * Acquires multiple lock keys atomically in sorted lexicographic order,
 * preventing deadlocks when two callers try to lock the same set in different
 * order.
 *
 * Returns a single composite `Release` that releases all acquired locks in
 * reverse-acquisition order.  The composite release is idempotent (calling it
 * twice is a no-op).
 *
 * Typical usage — lock two potentially-overlapping nodes:
 *
 *   const keysToLock = detectOverlappingKeys(provider, projectId, filePath, [nodeA, nodeB]);
 *   const release = await lockAstRegionMulti(base, keysToLock);
 *   try { ... } finally { release(); }
 *
 * @param provider  Any LockProvider.
 * @param keys      Lock keys to acquire (order does not matter — they are
 *                  sorted internally).
 */
export async function lockAstRegionMulti(
  provider: LockProvider,
  keys: string[],
): Promise<Release> {
  // Deduplicate and sort to guarantee consistent acquisition order.
  const sorted = Array.from(new Set(keys)).sort();

  const releases: Release[] = [];
  for (const key of sorted) {
    const r = await provider.acquire(key);
    releases.push(r);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Release in reverse order (mirrors conventional RAII ordering; for
    // in-process AsyncMutex this doesn't matter, but it's correct practice).
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]!();
    }
  };
}

// ---------------------------------------------------------------------------
// Overlap key set builder
// ---------------------------------------------------------------------------

/**
 * Given an array of AST nodes for a single (projectId, filePath), returns
 * the minimal set of lock keys that must be acquired to safely execute a
 * write operation that touches all nodes in `targets`.
 *
 * Conservative strategy:
 *   - Always include the key for each target node.
 *   - Also include the key for every other node in `allNodes` whose byteRange
 *     overlaps with any target node's byteRange.
 *
 * This guarantees that concurrent writers cannot proceed on the same byte
 * span even if they hold different node keys.
 *
 * @param projectId  Project identifier.
 * @param filePath   File path.
 * @param targets    Nodes the caller intends to modify.
 * @param allNodes   All nodes in the relevant scope (used for overlap check).
 *                   Typically the full top-level symbol list from tree-sitter.
 *                   If omitted, only the target nodes' own keys are returned.
 */
export function buildOverlapKeySet(
  projectId: string,
  filePath: string,
  targets: AstNodeDescriptor[],
  allNodes: AstNodeDescriptor[] = [],
): string[] {
  const keySet = new Set<string>();

  for (const target of targets) {
    keySet.add(astNodeLockKey(projectId, filePath, target));
    for (const candidate of allNodes) {
      if (byteRangesOverlap(target.byteRange, candidate.byteRange)) {
        keySet.add(astNodeLockKey(projectId, filePath, candidate));
      }
    }
  }

  return Array.from(keySet);
}
