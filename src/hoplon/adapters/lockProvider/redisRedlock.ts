/**
 * adapters/lockProvider/redisRedlock.ts — Redis Redlock LockProvider (RL1).
 *
 * Implements the C3 LockProvider contract via the Redlock distributed-locking
 * algorithm (https://redis.io/docs/manual/patterns/distributed-locks/).
 *
 * Algorithm summary:
 *   1. Acquire the lock by setting a key with NX (set-if-not-exists) + TTL.
 *   2. If acquisition fails (key exists), retry with jitter per retryCount/retryDelay.
 *   3. On release, compare-and-delete via Lua script — only deletes if the
 *      stored value matches our token. This prevents releasing another holder's
 *      lock after a TTL expiry.
 *
 * Redlock v5 API:
 *   - `new Redlock([client], options)` — client must implement the command
 *     interface expected by Redlock (compatible with ioredis and ioredis-mock).
 *   - `redlock.acquire([resource], duration)` — acquires; duration is TTL in ms.
 *   - `lock.release()` — compare-and-delete via Lua. Throws `ExecutionError`
 *     if the lock is already gone (expired or released by another holder).
 *
 * Release idempotency: C3 contract requires calling release() twice to be a
 * no-op. We guard with a `released` sentinel and swallow the second call.
 * Errors from the async release fire-and-forget (e.g., expired lock) are also
 * swallowed — TTL auto-release is the safety fallback.
 *
 * Composition with W2 (lock-per-project): The returned LockProvider is a plain
 * LockProvider — createPerProjectLockProvider() wraps it transparently.
 *
 * ioredis-mock compatibility: ioredis-mock implements the same command
 * interface as ioredis, including EVAL (emulated in JS). Multi-node contention
 * tests pass three mock clients pointing at the shared in-process store.
 */

import Redlock from 'redlock';
import type { Lock } from 'redlock';
import { AdapterError } from '../../contracts/errors.js';
import {
  invalidRedisRedlockOption,
  normalizeRenewalPolicy,
} from './renewalPolicy.js';
import { attachRenewalWatchdog } from './lockWatchdog.js';
import type {
  LostLockInfo,
  RedisLockHandle,
  RedisLockProvider,
} from './renewalPolicy.js';

// Re-export the renewal/lost-lock public surface so consumers keep importing it
// from this adapter's module path (single entry point for RL1).
export type {
  LostLockInfo,
  RedisLockHandle,
  RedisLockProvider,
} from './renewalPolicy.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal Redis client interface accepted by this adapter.
 * Satisfied by ioredis and ioredis-mock out of the box.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RedisClient = Record<string, any>;

export interface RedisRedlockOptions {
  /**
   * One or more Redis clients. Single-node deployments pass one client.
   * True Redlock quorum safety requires 2N+1 independent Redis nodes.
   * Tests pass one or more ioredis-mock clients — they share in-process
   * state so multi-client contention is faithfully simulated.
   */
  clients: RedisClient[];

  /**
   * Lock TTL in milliseconds. Redis auto-releases after this duration.
   * Default: 10_000 (10 seconds).
   */
  ttlMs?: number;

  /**
   * Maximum retry attempts before acquire() throws.
   * Default: 10.
   */
  retryCount?: number;

  /**
   * Base delay between retries in milliseconds (Redlock adds jitter).
   * Default: 200.
   */
  retryDelayMs?: number;

  /**
   * Clock drift factor for TTL compensation (Redlock default: 0.01).
   */
  driftFactor?: number;

  /**
   * Watchdog renewal interval in milliseconds. While a lock is held it is
   * extended back to `ttlMs` on this interval so a long critical section does
   * not lose the lock to TTL expiry (a second holder acquiring the same key).
   * Must be a positive integer below `ttlMs`. Set to `false` to explicitly
   * disable renewal and rely on the configured TTL. Default: floor(ttlMs / 3).
   */
  renewIntervalMs?: number | false;

  /**
   * Maximum-hold ceiling in milliseconds. While renewal is active the watchdog
   * stops renewing once the lock has been held for (approximately) this long,
   * then surfaces a `max_hold_exceeded` lost-lock signal and lets TTL reclaim
   * the lock. This restores the TTL-bounded liveness backstop so a
   * deadlocked-but-alive holder cannot renew forever. Must exceed the renewal
   * interval. Set to `false` to disable the ceiling (unbounded renewal — the
   * host then owns the indefinite-hold risk). Ignored when renewal is disabled
   * (the fixed TTL already bounds the hold). Default: 1_800_000 (30 minutes).
   */
  maxHoldMs?: number | false;

  /**
   * Invoked when a held lock is lost (renewal extend failed / token no longer
   * matches) or intentionally surrendered because the max-hold ceiling was
   * reached. The holder should abort its critical section — exclusivity can no
   * longer be guaranteed. Optional: even without it, the returned handle exposes
   * an observable `lost` / `status` so a host cannot keep operating under a
   * false exclusivity assumption. Never invoked after release(). Callback
   * failures are isolated from the renewal watchdog.
   */
  onLostLock?: (info: LostLockInfo) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis Redlock LockProvider satisfying the C3 LockProvider contract.
 *
 * Keys passed to acquire() are namespaced as `hoplon:lock:<key>` to avoid
 * collisions with other Redis consumers on the same instance.
 *
 * Usage:
 *   import Redis from 'ioredis';
 *   const client = new Redis({ host: 'localhost', port: 6379 });
 *   const lock = createRedisRedlockProvider({ clients: [client], ttlMs: 5000 });
 *   const release = await lock.acquire('project-a:snapshot');
 *   try { ... } finally { release(); }
 */
export function createRedisRedlockProvider(
  options: RedisRedlockOptions,
): RedisLockProvider {
  const {
    clients,
    ttlMs = 10_000,
    retryCount = 10,
    retryDelayMs = 200,
    driftFactor = 0.01,
    renewIntervalMs,
    maxHoldMs,
    onLostLock,
  } = options;

  if (clients.length === 0) {
    throw new AdapterError(
      {
        kind: 'lock_acquire_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
      },
      'RedisRedlock: at least one Redis client is required',
    );
  }

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw invalidRedisRedlockOption(
      `ttlMs must be a positive safe integer; received ${String(ttlMs)}`,
    );
  }

  // Resolve the renewal cadence and the max-hold ceiling (throws on invalid
  // configuration). `renewMs === null` means renewal is disabled (fixed TTL);
  // `maxRenewals === null` means the ceiling is disabled (unbounded renewal).
  const { renewMs, maxRenewals } = normalizeRenewalPolicy({
    ttlMs,
    renewIntervalMs,
    maxHoldMs,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redlock = new Redlock(clients as any[], {
    driftFactor,
    retryCount,
    retryDelay: retryDelayMs,
    retryJitter: Math.floor(retryDelayMs / 2),
    automaticExtensionThreshold: 500,
  });

  async function acquire(key: string): Promise<RedisLockHandle> {
    // Namespace the key to avoid collisions with non-Hoplon Redis consumers.
    const resource = `hoplon:lock:${key}`;

    let lock: Lock;
    try {
      lock = await redlock.acquire([resource], ttlMs);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'unknown error during lock acquisition';
      throw new AdapterError(
        {
          kind: 'lock_acquire_failed',
          engineId: 'adapter',
          correlationId: 'adapter',
          cause: cause instanceof Error ? cause : undefined,
        },
        `RedisRedlock: failed to acquire lock for key "${key}": ${message}`,
      );
    }

    // Attach the renewal watchdog + observable lost/released handle. The
    // per-lock lifecycle (renew, max-hold ceiling, lost-lock notification,
    // idempotent release) lives in lockWatchdog.ts to keep this adapter under
    // the architecture line cap.
    return attachRenewalWatchdog({
      lock,
      key,
      ttlMs,
      renewMs,
      maxRenewals,
      onLostLock,
    });
  }

  return { acquire };
}
