/**
 * adapters/lock-async-mutex.ts — AsyncMutex implementation of LockProvider.
 *
 * Uses the `async-mutex` package to provide per-key in-process serialization.
 * Phase 1 default implementation. Phase 3 swap target: Redis Redlock.
 *
 * File placement: flat alongside the other adapter files rather than a
 * subdirectory, consistent with the existing adapter layout.
 *
 * Memory hygiene: after each release, if the mutex is no longer locked
 * (and therefore has no pending waiters — safe in JS's cooperative async
 * model since the next queued acquirer takes the lock synchronously on
 * release), the map entry is deleted. This prevents unbounded growth for
 * workloads with high key cardinality.
 *
 * async-mutex API note (v0.5.x): Mutex exposes `isLocked()` but no public
 * `getQueueLength()` / `waitingCount`. The cleanup check relies solely on
 * `isLocked()`: immediately after our `release()` call, if no other waiter
 * was queued, the mutex is unlocked; if a waiter exists, async-mutex
 * synchronously grants the lock to the next waiter during the release, so
 * `isLocked()` remains true. This makes the post-release `isLocked()` check
 * a safe proxy for "has pending waiters or holders".
 */

import { Mutex } from 'async-mutex';
import type { LockProvider, Release } from './lock.js';

// ---------------------------------------------------------------------------
// Internal: mutex-map entry (exported only for __debugSize test helper)
// ---------------------------------------------------------------------------

/**
 * AsyncMutexLockProvider — LockProvider implementation backed by async-mutex.
 *
 * Exported as a named interface so callers can type-assert the debug helper
 * in tests without importing internal details.
 */
export interface AsyncMutexLockProvider extends LockProvider {
  /**
   * TEST-ONLY. Returns the current number of live mutex entries in the map.
   * Do NOT call in production code. Marked with `__debug` prefix to signal
   * test-only intent.
   */
  __debugSize(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new AsyncMutexLockProvider instance.
 *
 * Each instance has its own isolated key → Mutex map; two instances sharing
 * the same key string do NOT interfere with each other.
 *
 * Usage:
 *   const lock = createAsyncMutexLockProvider();
 *   const release = await lock.acquire('my-project');
 *   try { ... } finally { release(); }
 */
export function createAsyncMutexLockProvider(): AsyncMutexLockProvider {
  const mutexes = new Map<string, Mutex>();

  function getMutex(key: string): Mutex {
    let m = mutexes.get(key);
    if (m === undefined) {
      m = new Mutex();
      mutexes.set(key, m);
    }
    return m;
  }

  async function acquire(key: string): Promise<Release> {
    const mutex = getMutex(key);
    const innerRelease = await mutex.acquire();

    let released = false;

    const release: Release = () => {
      if (released) {
        // Idempotent: second call is a no-op.
        return;
      }
      released = true;
      innerRelease();

      // Memory hygiene: if no other waiter grabbed the lock synchronously
      // during innerRelease(), the mutex is now unlocked — safe to evict.
      // async-mutex grants the lock to the next queued waiter as part of
      // the release() call, so isLocked() === true means a waiter exists.
      if (!mutex.isLocked()) {
        mutexes.delete(key);
      }
    };

    return release;
  }

  function __debugSize(): number {
    return mutexes.size;
  }

  return { acquire, __debugSize };
}
