/**
 * adapters/lockProvider/lockWatchdog.ts — per-lock renewal watchdog for RL1.
 *
 * Extracted from redisRedlock.ts to keep that adapter under the 300-line
 * architecture cap. Owns the per-acquisition lifecycle of a single held lock:
 *   - the renewal watchdog interval (extend the lock back to `ttlMs` per tick),
 *   - the max-hold ceiling that stops renewal so TTL reclaims the lock,
 *   - the observable lost/released handle (see renewalPolicy.createLockHandle).
 *
 * The watchdog never silently keeps running as if still exclusive: on an extend
 * failure or once the ceiling is reached it marks the lock lost, stops the
 * interval, and notifies the host (callback failures are isolated).
 */

import type { Lock } from 'redlock';
import { createLockHandle } from './renewalPolicy.js';
import type { LostLockInfo, RedisLockHandle } from './renewalPolicy.js';

export interface RenewalWatchdogParams {
  /** The freshly acquired redlock Lock this watchdog will renew. */
  lock: Lock;
  /** Un-namespaced key (as passed to acquire()) — surfaced in LostLockInfo. */
  key: string;
  /** Lock TTL in ms; each renewal extends the lock back to this duration. */
  ttlMs: number;
  /** Renewal interval in ms, or null to disable renewal (fixed TTL). */
  renewMs: number | null;
  /** Max successful renewals before the ceiling trips, or null when uncapped. */
  maxRenewals: number | null;
  /** Host notification when the lock is lost/surrendered. Optional. */
  onLostLock?: ((info: LostLockInfo) => void | Promise<void>) | undefined;
}

/**
 * Attach a renewal watchdog to an acquired lock and return an observable
 * release handle. The handle is idempotent (C3 contract) and exposes
 * `lost` / `status` so a host that did not wire `onLostLock` can still detect
 * lost exclusivity.
 */
export function attachRenewalWatchdog(
  params: RenewalWatchdogParams,
): RedisLockHandle {
  const { lock, key, ttlMs, renewMs, maxRenewals, onLostLock } = params;

  let released = false;
  let lost = false;
  let lostReason: LostLockInfo['reason'] | null = null;
  let renewing = false;
  let renewalCount = 0;
  let currentLock: Lock = lock;

  // Watchdog: extend the lock back to `ttlMs` on each tick so it survives a
  // critical section longer than the TTL. On failure — or once the max-hold
  // ceiling is reached — we surface lost-lock state and stop. We never
  // silently keep running as if still exclusive.
  const watchdog: ReturnType<typeof setInterval> | null =
    renewMs === null
      ? null
      : setInterval(() => {
          void renew();
        }, renewMs);
  // Do not let the watchdog keep the process alive on its own.
  if (watchdog !== null && typeof watchdog.unref === 'function') {
    watchdog.unref();
  }

  // Mark the lock lost/surrendered, stop the watchdog, and notify the host.
  // Callback failures are isolated — they must never become an unhandled
  // rejection, and the lost state stands regardless of the callback outcome.
  async function markLost(
    reason: LostLockInfo['reason'],
    detail: string,
  ): Promise<void> {
    lost = true;
    lostReason = reason;
    if (watchdog !== null) clearInterval(watchdog);
    try {
      await onLostLock?.({ key, reason, detail });
    } catch {
      // Non-authoritative: the lock is already marked lost and the interval
      // is already stopped, so a diagnostics callback failure is swallowed.
    }
  }

  async function renew(): Promise<void> {
    if (released || lost || renewing) return;
    renewing = true;
    try {
      // Max-hold ceiling: stop renewing so a deadlocked-but-alive holder
      // cannot renew forever. TTL then expires the lock — restoring the
      // TTL-bounded liveness backstop.
      if (maxRenewals !== null && renewalCount >= maxRenewals) {
        await markLost(
          'max_hold_exceeded',
          `max-hold ceiling reached after ${renewalCount} renewals; renewal stopped so TTL (${ttlMs}ms) reclaims the lock`,
        );
        return;
      }
      const extended = await currentLock.extend(ttlMs);
      if (!released && !lost) {
        currentLock = extended;
        renewalCount += 1;
      }
    } catch (cause) {
      if (released || lost) return;
      await markLost(
        'renewal_failed',
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      renewing = false;
    }
  }

  return createLockHandle(
    () => {
      if (released) {
        // Idempotent: second call is a no-op (C3 contract requirement).
        return;
      }
      released = true;
      if (watchdog !== null) clearInterval(watchdog);

      // If a renewal failed, the stored token is gone — nothing of ours is
      // left to release. For a max-hold surrender the token may still be
      // valid, so a best-effort compare-and-delete frees the key promptly.
      if (lost && lostReason === 'renewal_failed') return;

      // Fire-and-forget: the handle's call signature is `() => void`.
      // If the lock already expired (TTL), Redlock throws ExecutionError —
      // we swallow it. TTL auto-release is the safety fallback in all cases.
      currentLock.release().catch(() => {
        // Intentionally ignored — TTL provides the safety guarantee.
      });
    },
    () => ({ released, lost }),
  );
}
