/**
 * tests/adapters/lockProvider/redisRedlockMaxHold.test.ts — P3 regression.
 *
 * The renewal watchdog previously renewed a held lock forever with no ceiling,
 * converting a TTL-bounded stuck lock into an indefinitely-held one, and the
 * lost-lock signal was only observable through the optional onLostLock callback.
 *
 * These tests lock in two safety properties:
 *   1. Max-hold ceiling: after a bounded number of renewals the watchdog STOPS
 *      renewing and surfaces a `max_hold_exceeded` lost-lock signal, so TTL can
 *      reclaim the lock (a deadlocked-but-alive holder cannot renew forever).
 *   2. Observable handle: even with NO onLostLock wired, the returned handle
 *      exposes `lost` / `status` so a host cannot keep operating under a false
 *      exclusivity assumption without an observable signal.
 *
 * Uses ioredis-mock (no real Redis, no network). The mock does not enforce TTL
 * wall-clock expiry, so these assert on the renewal mechanism (bounded extend
 * invocations + lost-lock surfacing + observable status), not wall-clock expiry.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Lock } from 'redlock';
import {
  createRedisRedlockProvider,
  type LostLockInfo,
} from '../../../src/hoplon/adapters/lockProvider/redisRedlock.js';
import { AdapterError } from '../../../src/hoplon/contracts/errors.js';

function makeClient(): InstanceType<typeof RedisMock> {
  return new RedisMock();
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P3 — Redlock max-hold ceiling', () => {
  it('stops renewing and surfaces max_hold_exceeded once the ceiling is reached', async () => {
    // maxHoldMs 100 / renewIntervalMs 40 => ceiling after floor(100/40) = 2 renewals.
    const extendSpy = vi.spyOn(Lock.prototype, 'extend');
    const lost: LostLockInfo[] = [];

    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      retryCount: 3,
      retryDelayMs: 20,
      renewIntervalMs: 40,
      maxHoldMs: 100,
      onLostLock: (info) => {
        lost.push(info);
      },
    });

    const release = await provider.acquire('p3-ceiling');
    // Well past the ceiling: ticks at 40/80/120/... — 2 extends then the stop.
    await delay(300);

    // Renewal is bounded — exactly maxRenewals extends, then the watchdog stops.
    expect(extendSpy).toHaveBeenCalledTimes(2);

    // The ceiling surfaced a lost-lock signal so TTL can reclaim the lock.
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      key: 'p3-ceiling',
      reason: 'max_hold_exceeded',
    });

    // The handle is observably lost — a host that ignores onLostLock still sees it.
    expect(release.lost).toBe(true);
    expect(release.status).toBe('lost');

    // release() after the ceiling is a safe no-op (does not throw).
    expect(() => release()).not.toThrow();
  });

  it('does not apply a ceiling when renewal is disabled (fixed TTL bounds the hold)', async () => {
    const extendSpy = vi.spyOn(Lock.prototype, 'extend');
    const lost: LostLockInfo[] = [];

    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      renewIntervalMs: false,
      // maxHoldMs is irrelevant with renewal off — the fixed TTL already bounds it.
      maxHoldMs: 20,
      onLostLock: (info) => {
        lost.push(info);
      },
    });

    const release = await provider.acquire('p3-no-renew');
    await delay(120);

    expect(extendSpy).not.toHaveBeenCalled();
    expect(lost).toHaveLength(0);
    expect(release.lost).toBe(false);
    expect(release.status).toBe('held');
    release();
  });

  it('rejects a max-hold ceiling that is not above the renewal interval', () => {
    expect(() =>
      createRedisRedlockProvider({
        clients: [makeClient()],
        ttlMs: 150,
        renewIntervalMs: 40,
        maxHoldMs: 40, // must strictly exceed the renewal interval
      }),
    ).toThrow(AdapterError);

    try {
      createRedisRedlockProvider({
        clients: [makeClient()],
        ttlMs: 150,
        renewIntervalMs: 40,
        maxHoldMs: 30,
      });
      throw new Error('expected invalid maxHoldMs configuration to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).kind).toBe('lock_acquire_failed');
      expect((error as AdapterError).message).toContain('invalid configuration');
    }
  });

  it('allows explicitly opting out of the ceiling with maxHoldMs=false', async () => {
    const extendSpy = vi.spyOn(Lock.prototype, 'extend');
    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      renewIntervalMs: 40,
      maxHoldMs: false, // unbounded renewal (host owns the risk)
    });

    const release = await provider.acquire('p3-uncapped');
    await delay(220); // would have tripped a 100ms ceiling (~2 renewals) long ago
    release();

    // No ceiling => renewal kept going well past what a 100ms ceiling would allow.
    expect(extendSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('P3 — lost lock is observable via the handle without onLostLock', () => {
  it('exposes lost/status on the handle when renewal fails and no callback is wired', async () => {
    vi.spyOn(Lock.prototype, 'extend').mockRejectedValue(
      new Error('token no longer matches'),
    );

    // Deliberately no onLostLock — the handle must still be observable.
    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      renewIntervalMs: 40,
    });

    const release = await provider.acquire('p3-lost-observable');
    expect(release.status).toBe('held');
    expect(release.lost).toBe(false);

    await delay(120); // first renewal fires and fails => lock is provably lost

    expect(release.lost).toBe(true);
    expect(release.status).toBe('lost');

    // release() after a lost lock is a safe no-op and the lost state persists.
    expect(() => release()).not.toThrow();
    expect(release.lost).toBe(true);
  });

  it('reports status=released after a clean release with no loss', async () => {
    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      renewIntervalMs: false,
    });

    const release = await provider.acquire('p3-clean');
    expect(release.status).toBe('held');
    release();
    expect(release.status).toBe('released');
    expect(release.lost).toBe(false);
  });
});
