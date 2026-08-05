/**
 * tests/adapters/lockProvider/redisRedlockRenewal.test.ts — GAP G3 regression.
 *
 * Redlock locks previously used a fixed TTL with no renewal, so a critical
 * section longer than the TTL lost the lock (a second holder could acquire the
 * same key mid-section). The adapter now runs a watchdog that extends the lock
 * on an interval well under the TTL, stops on release, and surfaces lost-lock
 * state when a renewal fails.
 *
 * Uses ioredis-mock (no real Redis, no network). TTL wall-clock expiry is not
 * enforced by the mock, so these tests assert on the renewal mechanism itself
 * (extend invocations + lost-lock surfacing) rather than wall-clock expiry.
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

describe('GAP G3 — Redlock lock renewal watchdog', () => {
  it('extends the lock repeatedly across a long critical section', async () => {
    // Explicit 40ms tuning proves the caller-facing interval is load-bearing.
    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      retryCount: 3,
      retryDelayMs: 20,
      renewIntervalMs: 40,
    });
    const extendSpy = vi.spyOn(Lock.prototype, 'extend');

    const release = await provider.acquire('g3-long');
    await delay(220);
    release();

    // The watchdog kept renewing the lock while it was held.
    expect(extendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a second acquirer cannot obtain the key while the first holds (and renews) it', async () => {
    const shared = makeClient();
    const holder = createRedisRedlockProvider({
      clients: [shared],
      ttlMs: 150,
      retryCount: 3,
      retryDelayMs: 20,
    });
    const contender = createRedisRedlockProvider({
      clients: [shared],
      ttlMs: 150,
      retryCount: 0,
      retryDelayMs: 10,
    });

    const release = await holder.acquire('g3-excl');
    // Let the watchdog tick at least once so renewal is demonstrably active.
    await delay(120);

    await expect(contender.acquire('g3-excl')).rejects.toBeInstanceOf(AdapterError);

    // Once the holder releases, the key is free for the contender.
    release();
    await delay(20);
    const r2 = await contender.acquire('g3-excl');
    expect(typeof r2).toBe('function');
    r2();
  });

  it('surfaces lost-lock state and stops the watchdog when renewal fails', async () => {
    const extendSpy = vi
      .spyOn(Lock.prototype, 'extend')
      .mockRejectedValue(new Error('token no longer matches'));
    const lost: LostLockInfo[] = [];

    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      retryCount: 3,
      retryDelayMs: 20,
      onLostLock: (info) => lost.push(info),
    });

    const release = await provider.acquire('g3-lost');
    await delay(140); // > renewMs (50): first renewal fires and fails.

    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ key: 'g3-lost', reason: 'renewal_failed' });
    expect(lost[0]?.detail).toContain('token no longer matches');

    // Watchdog stopped after the loss — no repeated extend attempts pile up.
    expect(extendSpy).toHaveBeenCalledTimes(1);

    // release() after a lost lock is a safe no-op (does not throw).
    expect(() => release()).not.toThrow();
  });

  it.each([
    ['synchronous throw', () => { throw new Error('callback failed'); }],
    ['asynchronous rejection', async () => { throw new Error('callback failed'); }],
  ])('isolates a %s from the watchdog promise', async (_label, onLostLock) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(Lock.prototype, 'extend').mockRejectedValue(
      new Error('token no longer matches'),
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const provider = createRedisRedlockProvider({
        clients: [makeClient()],
        ttlMs: 150,
        retryCount: 3,
        retryDelayMs: 20,
        renewIntervalMs: 40,
        onLostLock,
      });

      const release = await provider.acquire(`g3-callback-${_label}`);
      vi.advanceTimersByTime(140);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(Lock.prototype.extend).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(() => release()).not.toThrow();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  it('explicitly disables renewal when renewIntervalMs is false', async () => {
    const extendSpy = vi.spyOn(Lock.prototype, 'extend');
    const provider = createRedisRedlockProvider({
      clients: [makeClient()],
      ttlMs: 150,
      retryCount: 3,
      retryDelayMs: 20,
      renewIntervalMs: false,
    });

    const release = await provider.acquire('g3-no-renewal');
    await delay(180);
    release();

    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid renewal configuration with a typed AdapterError', () => {
    for (const renewIntervalMs of [0, -1, 150, Number.NaN]) {
      try {
        createRedisRedlockProvider({
          clients: [makeClient()],
          ttlMs: 150,
          renewIntervalMs,
        });
        throw new Error('expected invalid Redis renewal configuration');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterError);
        expect((error as AdapterError).kind).toBe('lock_acquire_failed');
        expect((error as AdapterError).message).toContain(
          'invalid configuration',
        );
      }
    }
    expect(() =>
      createRedisRedlockProvider({ clients: [makeClient()], ttlMs: 1 }),
    ).toThrow(AdapterError);
  });
});
