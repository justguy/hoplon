/**
 * tests/adapters/lockProvider/redisRedlock.test.ts — RL1 Redis Redlock tests.
 *
 * Primary test tier (always runs in CI): uses ioredis-mock (pure-JS Redis
 * emulator). No Docker, no real Redis, no network.
 *
 * Test inventory:
 *   A. C3 LockProvider contract — shared harness run against RL1
 *      A1. Single-key serialization (second acquire resolves only after release)
 *      A2. Different-key parallelism (two keys don't block each other)
 *      A3. Release idempotency (calling release twice is a no-op)
 *      A4. Release after async error in critical section (try/finally)
 *      A5. Many concurrent acquisitions serialize (counter integrity)
 *
 *   B. RL1-specific behavior
 *      B1. TTL auto-release: lock expires → can be re-acquired after explicit release
 *      B2. retryCount exhausted → AdapterError with kind='lock_acquire_failed'
 *      B3. Configuration: zero clients → throws at construction
 *
 *   C. Multi-instance contention (RL1 proof of distributed exclusion)
 *      C1. Three simulated nodes race for same key → exactly one holds at a time
 *      C2. W2 per-project wrapper composes cleanly on top of RL1
 *
 * Note on multi-node simulation with ioredis-mock:
 *   Each node is a separate RedisRedlockProvider instance backed by its own
 *   ioredis-mock client. All ioredis-mock instances in the same process share
 *   a common in-memory key store by default, so SET/DEL operations from one
 *   client are visible to all others — faithfully simulating a shared Redis.
 *   This makes the contention test deterministic without a real Redis server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createRedisRedlockProvider } from '../../../src/hoplon/adapters/lockProvider/redisRedlock.js';
import { createPerProjectLockProvider } from '../../../src/hoplon/adapters/lock-per-project.js';
import { AdapterError } from '../../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh ioredis-mock client. All instances in a process share state. */
function makeMockClient(): InstanceType<typeof RedisMock> {
  return new RedisMock();
}

/**
 * Creates a test provider with one fresh mock client and sensible defaults.
 * Pass overrides to customize TTL / retry behavior for specific tests.
 */
function makeProvider(overrides: {
  ttlMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  client?: InstanceType<typeof RedisMock>;
} = {}) {
  const client = overrides.client ?? makeMockClient();
  return {
    provider: createRedisRedlockProvider({
      clients: [client],
      ttlMs: overrides.ttlMs ?? 10_000,
      retryCount: overrides.retryCount ?? 10,
      retryDelayMs: overrides.retryDelayMs ?? 200,
    }),
    client,
  };
}

// ---------------------------------------------------------------------------
// A. C3 LockProvider contract tests
// ---------------------------------------------------------------------------

describe('A1: single-key serialization', () => {
  it('second acquire resolves only after first release — deterministic ordering', async () => {
    const { provider: lock } = makeProvider();
    const order: string[] = [];

    const release1 = await lock.acquire('a1-x');
    order.push('acquired-1');

    // Queue second — must not resolve until release1() is called.
    const acquire2Promise = lock.acquire('a1-x');
    order.push('before-release-1');

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

describe('A2: different-key parallelism', () => {
  it('acquire(a) and acquire(b) both resolve without blocking each other', async () => {
    const { provider: lock } = makeProvider();

    const [releaseA, releaseB] = await Promise.all([
      lock.acquire('a2-key-a'),
      lock.acquire('a2-key-b'),
    ]);

    // Both resolved — they ran in parallel.
    releaseA();
    releaseB();

    // Confirm independence: acquire 'a' again while 'b' is held.
    const releaseB2 = await lock.acquire('a2-key-b');
    const releaseA2 = await lock.acquire('a2-key-a');
    releaseA2();
    releaseB2();
  });
});

describe('A3: release idempotency', () => {
  it('calling release twice is a no-op — no throw, no corruption', async () => {
    const { provider: lock } = makeProvider();
    const release = await lock.acquire('a3-idem');

    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow(); // idempotent

    // Subsequent acquire must still work.
    const r2 = await lock.acquire('a3-idem');
    expect(typeof r2).toBe('function');
    r2();
  });
});

describe('A4: release after async error in critical section', () => {
  it('finally block still releases safely even when the critical section throws', async () => {
    const { provider: lock } = makeProvider();

    async function unsafeWork(key: string): Promise<void> {
      const release = await lock.acquire(key);
      try {
        throw new Error('deliberate failure inside critical section');
      } finally {
        release();
      }
    }

    await expect(unsafeWork('a4-err')).rejects.toThrow(
      'deliberate failure inside critical section',
    );

    // Lock must be available again — prove by acquiring it.
    const releaseAfter = await lock.acquire('a4-err');
    expect(typeof releaseAfter).toBe('function');
    releaseAfter();
  });
});

describe('A5: many concurrent acquisitions serialize (counter integrity)', () => {
  it('10 concurrent acquire calls execute serially — counter never races', async () => {
    // Unlike AsyncMutex (FIFO queue), Redlock uses retry polling — workers
    // compete on each retry cycle. The final counter value proves serialization
    // (no race corruption), but the order workers win the lock is not guaranteed.
    const { provider: lock } = makeProvider({ retryCount: 30, retryDelayMs: 100 });
    const CONCURRENCY = 10;
    let counter = 0;
    const snapshots: number[] = [];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      const release = await lock.acquire('a5-serial');
      try {
        const snapshot = counter;
        snapshots.push(snapshot);
        await Promise.resolve(); // yield — proves no data race even with yielding
        counter = snapshot + 1;
      } finally {
        release();
      }
    });

    await Promise.all(workers);

    // The counter must be exactly CONCURRENCY — proves all increments serialized.
    expect(counter).toBe(CONCURRENCY);

    // snapshots must contain each value 0..9 exactly once — proves no reads
    // happened while another worker held the lock and was mid-increment.
    // Order is non-deterministic (Redlock retry polling, not FIFO queue).
    expect(snapshots).toHaveLength(CONCURRENCY);
    expect([...snapshots].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// B. RL1-specific behavior
// ---------------------------------------------------------------------------

describe('B1: TTL auto-release', () => {
  it('released lock can be immediately re-acquired by another holder on same Redis', async () => {
    // Note: ioredis-mock does not enforce TTL expiry via wall-clock timers.
    // This test validates the release path: explicit release → re-acquire succeeds.
    // TTL expiry on a real Redis instance is validated in the integration tier.
    //
    // Both providers share the same ioredis-mock client to model two app nodes
    // connecting to the same Redis server.
    const sharedClient = makeMockClient();

    const lock1 = createRedisRedlockProvider({
      clients: [sharedClient],
      ttlMs: 500,
      retryCount: 3,
      retryDelayMs: 50,
    });

    const release1 = await lock1.acquire('b1-ttl');

    // Release explicitly — the key is now free.
    release1();

    // Allow fire-and-forget release to propagate in the mock.
    await new Promise<void>((res) => setTimeout(res, 50));

    // A second provider on the same client can now acquire immediately.
    const lock2 = createRedisRedlockProvider({
      clients: [sharedClient],
      ttlMs: 5_000,
      retryCount: 3,
      retryDelayMs: 50,
    });
    const release2 = await lock2.acquire('b1-ttl');
    expect(typeof release2).toBe('function');
    release2();
  });
});

describe('B2: retryCount exhausted → AdapterError', () => {
  it('throws AdapterError with kind=lock_acquire_failed when lock is held and retries exhausted', async () => {
    const { client, provider: holder } = makeProvider({ ttlMs: 30_000, retryCount: 10 });

    // Holder acquires the lock.
    const holdRelease = await holder.acquire('b2-contended');

    // Contender with zero retries → must fail immediately.
    const contender = createRedisRedlockProvider({
      clients: [client],
      ttlMs: 30_000,
      retryCount: 0,
      retryDelayMs: 10,
    });

    await expect(contender.acquire('b2-contended')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdapterError && err.kind === 'lock_acquire_failed',
    );

    holdRelease();
  });
});

describe('B3: construction guard — zero clients', () => {
  it('throws AdapterError at construction when clients array is empty', () => {
    expect(() =>
      createRedisRedlockProvider({ clients: [] }),
    ).toThrow(AdapterError);

    try {
      createRedisRedlockProvider({ clients: [] });
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe('lock_acquire_failed');
      expect((err as AdapterError).message).toMatch(/at least one Redis client/);
    }
  });
});

// ---------------------------------------------------------------------------
// C. Multi-instance contention — three simulated nodes race for same key
// ---------------------------------------------------------------------------

describe('C1: three nodes race for same key — exactly one holds at a time', () => {
  it('concurrent acquires from 3 simulated nodes serialize correctly', async () => {
    // Three separate provider instances all share one ioredis-mock client.
    // This models the real-world topology: 3 application nodes connecting
    // to the same Redis server. Each provider is an independent Redlock
    // instance (separate retry state, token generation) but they all write
    // to the same key store — so only one can hold the lock at a time.
    const sharedClient = makeMockClient();

    const nodeA = createRedisRedlockProvider({
      clients: [sharedClient],
      ttlMs: 10_000,
      retryCount: 30,
      retryDelayMs: 50,
    });
    const nodeB = createRedisRedlockProvider({
      clients: [sharedClient],
      ttlMs: 10_000,
      retryCount: 30,
      retryDelayMs: 50,
    });
    const nodeC = createRedisRedlockProvider({
      clients: [sharedClient],
      ttlMs: 10_000,
      retryCount: 30,
      retryDelayMs: 50,
    });

    let holdersAtOnce = 0;
    let maxHoldersAtOnce = 0;
    const order: string[] = [];

    async function race(
      node: ReturnType<typeof createRedisRedlockProvider>,
      name: string,
    ): Promise<void> {
      const release = await node.acquire('c1-race');
      try {
        holdersAtOnce++;
        maxHoldersAtOnce = Math.max(maxHoldersAtOnce, holdersAtOnce);
        order.push(`${name}:enter`);
        await Promise.resolve();
        order.push(`${name}:exit`);
      } finally {
        holdersAtOnce--;
        release();
      }
    }

    await Promise.all([
      race(nodeA, 'A'),
      race(nodeB, 'B'),
      race(nodeC, 'C'),
    ]);

    // Core invariant: never more than one holder at a time.
    expect(maxHoldersAtOnce).toBe(1);

    // All three nodes completed.
    const enters = order.filter((e) => e.endsWith(':enter'));
    const exits = order.filter((e) => e.endsWith(':exit'));
    expect(enters).toHaveLength(3);
    expect(exits).toHaveLength(3);

    // Every enter must be immediately followed by its own exit before next enter.
    for (let i = 0; i < order.length - 1; i += 2) {
      const enter = order[i];
      const exit = order[i + 1];
      if (enter !== undefined && exit !== undefined) {
        const enterNode = enter.split(':')[0];
        const exitNode = exit.split(':')[0];
        expect(enterNode).toBe(exitNode);
      }
    }
  });
});

describe('C2: W2 per-project wrapper composes cleanly on top of RL1', () => {
  it('different projects run in parallel when backed by RL1', async () => {
    const { provider: base } = makeProvider({ ttlMs: 10_000, retryCount: 10, retryDelayMs: 50 });
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    // Two different project IDs → different namespaced keys → must not block each other.
    const [releaseA, releaseB] = await Promise.all([
      perProject.acquire('c2-alpha:snapshot'),
      perProject.acquire('c2-beta:snapshot'),
    ]);

    expect(typeof releaseA).toBe('function');
    expect(typeof releaseB).toBe('function');

    releaseA();
    releaseB();
  });

  it('same project serializes when backed by RL1', async () => {
    const { provider: base } = makeProvider({ ttlMs: 10_000, retryCount: 20, retryDelayMs: 50 });
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const order: string[] = [];

    const release1 = await perProject.acquire('c2-project-x:write');
    order.push('acquired-1');

    const acquire2Promise = perProject.acquire('c2-project-x:write');
    order.push('queued-2');

    release1();
    order.push('released-1');

    const release2 = await acquire2Promise;
    order.push('acquired-2');
    release2();

    expect(order).toEqual([
      'acquired-1',
      'queued-2',
      'released-1',
      'acquired-2',
    ]);
  });

  it('W2 release idempotency is preserved through RL1', async () => {
    const { provider: base } = makeProvider({ ttlMs: 10_000 });
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const release = await perProject.acquire('c2-idem:op');
    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow(); // idempotent

    const r2 = await perProject.acquire('c2-idem:op');
    expect(typeof r2).toBe('function');
    r2();
  });
});

// ---------------------------------------------------------------------------
// Teardown: restore fake timers if any test left them enabled
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});
