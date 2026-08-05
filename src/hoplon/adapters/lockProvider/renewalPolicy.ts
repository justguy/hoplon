/**
 * adapters/lockProvider/renewalPolicy.ts — renewal + max-hold policy for RL1.
 *
 * Extracted from redisRedlock.ts to keep that adapter's diff surgical while
 * adding the max-hold ceiling and the observable lost-lock handle. This module
 * owns:
 *   - configuration validation/normalization (renew interval + max-hold ceiling),
 *   - the LostLockInfo / RedisLockHandle / RedisLockProvider public types,
 *   - the helper that augments a Release with an observable lost/expired status.
 *
 * Liveness backstop: the renewal watchdog extends a held lock so a long critical
 * section survives TTL expiry. Left unbounded, a deadlocked-but-alive holder
 * would renew forever — converting a TTL-bounded stuck lock into an
 * indefinitely-held one. The max-hold ceiling caps the number of renewals so
 * the watchdog stops and TTL reclaims the lock, restoring bounded liveness.
 */

import { AdapterError } from '../../contracts/errors.js';
import type { LockProvider } from '../lock.js';

/**
 * Emitted when a held lock is lost or intentionally surrendered while its
 * critical section may still be active. The holder MUST treat this as loss of
 * exclusivity and abort — the watchdog does not silently continue.
 *
 *   - `renewal_failed`: a renewal extend failed (the stored token no longer
 *     matches — the lock expired and was re-acquired elsewhere).
 *   - `max_hold_exceeded`: the max-hold ceiling was reached; renewal stopped so
 *     TTL reclaims the lock and a deadlocked holder cannot hold indefinitely.
 */
export interface LostLockInfo {
  /** The un-namespaced key that was lost (as passed to acquire()). */
  key: string;
  reason: 'renewal_failed' | 'max_hold_exceeded';
  /** Human-readable detail (renewal error, or the ceiling that tripped). */
  detail: string;
}

/** Coarse lifecycle status a holder can observe on the lock handle. */
export type LockHoldStatus = 'held' | 'lost' | 'released';

/**
 * A Release callback augmented with an observable lost/expired status. A host
 * that did not wire onLostLock can still read `lost` / `status` to detect that
 * exclusivity was lost — so it cannot keep operating under a false exclusivity
 * assumption without an observable signal. Structurally still a `Release`.
 */
export interface RedisLockHandle {
  (): void;
  /** True once the lock is provably lost or surrendered via the max-hold ceiling. */
  readonly lost: boolean;
  /** Coarse lifecycle status for host observation. */
  readonly status: LockHoldStatus;
}

/** LockProvider specialization whose acquire() resolves to an observable handle. */
export interface RedisLockProvider extends LockProvider {
  acquire(key: string): Promise<RedisLockHandle>;
}

export interface NormalizedRenewalPolicy {
  /** Renewal interval in ms, or null when renewal is disabled (fixed TTL). */
  renewMs: number | null;
  /**
   * Maximum number of successful renewals before the max-hold ceiling trips,
   * or null when the ceiling is disabled (renewal off, or explicit opt-out).
   */
  maxRenewals: number | null;
  /** Resolved max-hold ceiling in ms (for diagnostics), or null when uncapped. */
  maxHoldMs: number | null;
}

/**
 * Default max-hold ceiling: 30 minutes. Generous enough not to trip normal long
 * critical sections, but bounded so a deadlocked-but-alive holder cannot renew
 * forever. Hosts with legitimately longer sections raise `maxHoldMs`; hosts that
 * accept the unbounded-renewal risk set `maxHoldMs: false`.
 */
export const DEFAULT_MAX_HOLD_MS = 1_800_000;

export function invalidRedisRedlockOption(detail: string): AdapterError {
  return new AdapterError(
    {
      kind: 'lock_acquire_failed',
      engineId: 'adapter',
      correlationId: 'adapter',
    },
    `RedisRedlock: invalid configuration: ${detail}`,
  );
}

/**
 * Validates renewal + max-hold configuration and resolves the effective renewal
 * cadence and ceiling. Throws a typed AdapterError on invalid configuration.
 */
export function normalizeRenewalPolicy(params: {
  ttlMs: number;
  renewIntervalMs?: number | false | undefined;
  maxHoldMs?: number | false | undefined;
}): NormalizedRenewalPolicy {
  const { ttlMs, renewIntervalMs, maxHoldMs } = params;

  if (
    renewIntervalMs !== undefined &&
    renewIntervalMs !== false &&
    (!Number.isSafeInteger(renewIntervalMs) ||
      renewIntervalMs <= 0 ||
      renewIntervalMs >= ttlMs)
  ) {
    throw invalidRedisRedlockOption(
      `renewIntervalMs must be false or a positive safe integer below ttlMs (${ttlMs}); received ${String(renewIntervalMs)}`,
    );
  }

  // Renewal cadence: well under the TTL so an extend lands with margin before
  // the lock would otherwise expire. `false` is the explicit host opt-out.
  const renewMs =
    renewIntervalMs === false
      ? null
      : renewIntervalMs ?? Math.max(1, Math.floor(ttlMs / 3));
  if (renewMs !== null && renewMs >= ttlMs) {
    throw invalidRedisRedlockOption(
      `renewal requires ttlMs to exceed the renewal interval (${renewMs}); set renewIntervalMs to false to disable renewal explicitly`,
    );
  }

  if (
    maxHoldMs !== undefined &&
    maxHoldMs !== false &&
    (!Number.isSafeInteger(maxHoldMs) || maxHoldMs <= 0)
  ) {
    throw invalidRedisRedlockOption(
      `maxHoldMs must be false or a positive safe integer; received ${String(maxHoldMs)}`,
    );
  }

  // The ceiling only applies while renewal is active — with renewal disabled the
  // fixed TTL already bounds the hold, so there is nothing left to cap.
  if (renewMs === null) {
    return { renewMs: null, maxRenewals: null, maxHoldMs: null };
  }

  if (maxHoldMs === false) {
    // Explicit opt-out: unbounded renewal (pre-ceiling behavior). Host owns the
    // risk that a deadlocked holder renews indefinitely.
    return { renewMs, maxRenewals: null, maxHoldMs: null };
  }

  const resolvedMaxHoldMs = maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  if (resolvedMaxHoldMs <= renewMs) {
    throw invalidRedisRedlockOption(
      `maxHoldMs (${resolvedMaxHoldMs}) must exceed the renewal interval (${renewMs}) so at least one renewal can occur; set maxHoldMs to false to disable the ceiling`,
    );
  }

  return {
    renewMs,
    maxRenewals: Math.floor(resolvedMaxHoldMs / renewMs),
    maxHoldMs: resolvedMaxHoldMs,
  };
}

/**
 * Augments a plain release function with observable `lost` / `status` getters
 * backed by the caller's live state, producing an observable RedisLockHandle.
 */
export function createLockHandle(
  releaseImpl: () => void,
  readState: () => { released: boolean; lost: boolean },
): RedisLockHandle {
  const handle = releaseImpl as unknown as RedisLockHandle;
  Object.defineProperty(handle, 'lost', {
    get: (): boolean => readState().lost,
    enumerable: true,
  });
  Object.defineProperty(handle, 'status', {
    get: (): LockHoldStatus => {
      const state = readState();
      return state.lost ? 'lost' : state.released ? 'released' : 'held';
    },
    enumerable: true,
  });
  return handle;
}
