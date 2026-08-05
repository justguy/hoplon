/**
 * adapters/lock.ts — LockProvider interface and Release type.
 *
 * The Release callback is idempotent — calling it twice must be a no-op, never a throw.
 * Phase 1 default: AsyncMutex (in-process per-key mutex map).
 * Phase 3 swap: RedisRedlock adapter satisfying this same interface.
 */

/** Calling release() returns the lock. Idempotent — safe to call multiple times. */
export type Release = () => void;

export interface LockProvider {
  /** Acquire an exclusive lock on the given key. Resolves when acquired. */
  acquire(key: string): Promise<Release>;
}
