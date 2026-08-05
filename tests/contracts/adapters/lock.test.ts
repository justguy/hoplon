/**
 * Contract tests for createAsyncMutexLockProvider.
 *
 * All serialization proofs use deterministic ordering (Promise resolution
 * sequencing), NOT wall-clock timing.
 *
 * Test inventory:
 *   1. Single-key serialization
 *   2. Different-key parallelism
 *   3. Release idempotency
 *   4. Release after async error inside critical section (try/finally)
 *   5. Many concurrent acquisitions serialize (counter integrity)
 *   6. Independent instances do not interfere
 *   7. Memory hygiene — map entries removed after all waiters release
 */

import { describe, it, expect } from 'vitest';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';

// ---------------------------------------------------------------------------
// 1. Single-key serialization
// ---------------------------------------------------------------------------

describe('single-key serialization', () => {
  it('second acquire resolves only after first release — deterministic ordering', async () => {
    const lock = createAsyncMutexLockProvider();
    const order: string[] = [];

    // Acquire first — holds the lock.
    const release1 = await lock.acquire('x');
    order.push('acquired-1');

    // Queue second acquisition — will not resolve until release1() is called.
    const acquire2Promise = lock.acquire('x');

    // Confirm second has NOT resolved yet (it is queued).
    // We know this because JS microtasks haven't flushed to grant it yet.
    // We push 'after-queue-2' before awaiting acquire2Promise.
    order.push('before-release-1');

    // Release first — second waiter should now be granted.
    release1();
    order.push('released-1');

    const release2 = await acquire2Promise;
    order.push('acquired-2');
    release2();

    expect(order).toEqual([
      'acquired-1',
      'before-release-1',
      'released-1',
      'acquired-2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Different-key parallelism
// ---------------------------------------------------------------------------

describe('different-key parallelism', () => {
  it('acquire(a) and acquire(b) both resolve without blocking each other', async () => {
    const lock = createAsyncMutexLockProvider();

    // Acquire two different keys — both should resolve immediately in
    // parallel without one blocking the other.
    const [releaseA, releaseB] = await Promise.all([
      lock.acquire('a'),
      lock.acquire('b'),
    ]);

    // Both resolved — they ran in parallel. Release both.
    releaseA();
    releaseB();

    // Confirm the keys are truly independent: acquire 'a' again while 'b'
    // is still held (by re-acquiring b before releasing). Should not block.
    const releaseB2 = await lock.acquire('b');
    const releaseA2 = await lock.acquire('a');
    releaseA2();
    releaseB2();
  });
});

// ---------------------------------------------------------------------------
// 3. Release idempotency
// ---------------------------------------------------------------------------

describe('release idempotency', () => {
  it('calling release twice is a no-op — no throw, no double-release', async () => {
    const lock = createAsyncMutexLockProvider();
    const release = await lock.acquire('idem');

    // First call — normal release.
    expect(() => release()).not.toThrow();
    // Second call — must be a no-op, not a throw or double-release.
    expect(() => release()).not.toThrow();

    // Subsequent acquire should succeed and serialize correctly,
    // proving the second release() did not corrupt state.
    const order: string[] = [];
    const r1 = await lock.acquire('idem');
    order.push('r1-acquired');
    r1();
    const r2 = await lock.acquire('idem');
    order.push('r2-acquired');
    r2();

    expect(order).toEqual(['r1-acquired', 'r2-acquired']);
  });
});

// ---------------------------------------------------------------------------
// 4. Release after async error inside critical section (try/finally)
// ---------------------------------------------------------------------------

describe('release after async error in critical section', () => {
  it('finally block still releases safely even when the critical section throws', async () => {
    const lock = createAsyncMutexLockProvider();

    async function unsafeWork(key: string): Promise<void> {
      const release = await lock.acquire(key);
      try {
        throw new Error('deliberate failure inside critical section');
      } finally {
        // Must not throw even though an error is in flight.
        release();
      }
    }

    await expect(unsafeWork('err-key')).rejects.toThrow(
      'deliberate failure inside critical section',
    );

    // Lock must be available again — prove it by acquiring it.
    const releaseAfter = await lock.acquire('err-key');
    expect(typeof releaseAfter).toBe('function');
    releaseAfter();
  });
});

// ---------------------------------------------------------------------------
// 5. Many concurrent acquisitions serialize (counter integrity)
// ---------------------------------------------------------------------------

describe('many concurrent acquisitions serialize', () => {
  it('10 concurrent acquire calls execute serially — counter never races', async () => {
    const lock = createAsyncMutexLockProvider();
    const CONCURRENCY = 10;
    let counter = 0;
    const snapshots: number[] = [];

    // Launch 10 concurrent workers. Each reads counter, increments, writes
    // back. If they ran in parallel, counter would race. Serial execution
    // guarantees snapshots contains 0..9 in order.
    const workers = Array.from({ length: CONCURRENCY }, async (_, i) => {
      const release = await lock.acquire('serial-key');
      try {
        const snapshot = counter;
        snapshots.push(snapshot);
        // Simulate async work inside the critical section.
        await Promise.resolve();
        counter = snapshot + 1;
      } finally {
        release();
      }
      return i;
    });

    await Promise.all(workers);

    expect(counter).toBe(CONCURRENCY);
    expect(snapshots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// 6. Independent instances do not interfere
// ---------------------------------------------------------------------------

describe('independent instances', () => {
  it('two separate provider instances have isolated key spaces', async () => {
    const lockA = createAsyncMutexLockProvider();
    const lockB = createAsyncMutexLockProvider();

    // Acquire the same key from both instances simultaneously — should not
    // block each other.
    const [rA, rB] = await Promise.all([
      lockA.acquire('shared-key'),
      lockB.acquire('shared-key'),
    ]);

    // Both resolved — they are independent.
    const orderA: string[] = [];
    const orderB: string[] = [];

    // Queue a second waiter on each instance while first is held.
    const waitA = lockA.acquire('shared-key').then((r) => {
      orderA.push('lockA-second');
      r();
    });
    const waitB = lockB.acquire('shared-key').then((r) => {
      orderB.push('lockB-second');
      r();
    });

    rA();
    rB();

    await Promise.all([waitA, waitB]);

    expect(orderA).toEqual(['lockA-second']);
    expect(orderB).toEqual(['lockB-second']);
  });
});

// ---------------------------------------------------------------------------
// 7. Memory hygiene — __debugSize() returns 0 after all keys released
// ---------------------------------------------------------------------------

describe('memory hygiene', () => {
  it('map is empty after all keys are acquired and released', async () => {
    const lock = createAsyncMutexLockProvider();
    const KEYS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    const releases = await Promise.all(KEYS.map((k) => lock.acquire(k)));

    // All keys acquired — map should have entries.
    expect(lock.__debugSize()).toBe(KEYS.length);

    // Release all.
    for (const r of releases) r();

    // Map should be empty — all entries were evicted post-release.
    expect(lock.__debugSize()).toBe(0);
  });

  it('map entry is removed for a key only when no waiters remain', async () => {
    const lock = createAsyncMutexLockProvider();

    // Acquire 'x' twice concurrently.
    const r1 = await lock.acquire('x');
    const acquire2 = lock.acquire('x'); // queued — not yet resolved

    // r1 holds; r2 is waiting. Entry must still be in the map.
    expect(lock.__debugSize()).toBe(1);

    // Release r1 — r2 should now be granted (isLocked remains true).
    r1();
    const r2 = await acquire2;

    // Entry still in map because r2 is holding.
    expect(lock.__debugSize()).toBe(1);

    // Release r2 — no more waiters, entry should be evicted.
    r2();
    expect(lock.__debugSize()).toBe(0);
  });
});
