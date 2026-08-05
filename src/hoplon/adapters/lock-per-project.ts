/**
 * adapters/lock-per-project.ts — Per-project mutex map (W2).
 *
 * Wraps any LockProvider with a key-namespacing helper so that two operations
 * on different projects never contend on the same underlying mutex, while two
 * operations on the same project are still serialized.
 *
 * The C3 LockProvider contract is unchanged — the returned object is a plain
 * LockProvider that accepts any string key. The namespacing is applied
 * internally by prepending `project:<projectId>:` to every key passed to
 * acquire().
 *
 * Invariants:
 *   - Different project IDs → fully independent lock keyspaces → parallel.
 *   - Same project ID + same key → serialized.
 *   - The baseLockProvider drives all actual serialization; this wrapper
 *     only translates keys.
 *   - Release idempotency is inherited from baseLockProvider.
 */

import type { LockProvider, Release } from './lock.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PerProjectLockProviderOptions {
  /** Underlying LockProvider (e.g. createAsyncMutexLockProvider()). */
  baseLockProvider: LockProvider;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a per-project LockProvider.
 *
 * Keys passed to `acquire()` are expected in the form `<projectId>:<rest>`
 * — the factory namespaces them as `project:<projectId>:<rest>` before
 * delegating to the baseLockProvider. This guarantees that two operations
 * on different project IDs never compete on the same underlying mutex.
 *
 * If a caller passes a plain key with no colon, the entire key is treated
 * as the namespace suffix (safe fallback — isolation is maintained).
 *
 * Usage:
 *   const base = createAsyncMutexLockProvider();
 *   const perProject = createPerProjectLockProvider({ baseLockProvider: base });
 *   const release = await perProject.acquire('proj-a:snapshot');
 *   try { ... } finally { release(); }
 */
export function createPerProjectLockProvider(
  options: PerProjectLockProviderOptions,
): LockProvider {
  const { baseLockProvider } = options;

  async function acquire(key: string): Promise<Release> {
    const namespacedKey = `project:${key}`;
    return baseLockProvider.acquire(namespacedKey);
  }

  return { acquire };
}
