/**
 * tests/integration/phase3/redis.integration.test.ts — RL1 integration tests.
 *
 * Gated by `RUN_INTEGRATION=1` environment variable. Requires a real Redis
 * instance accessible at REDIS_HOST:REDIS_PORT (defaults: localhost:6379).
 *
 * These tests are NOT on the default CI path. They are run explicitly by
 * developers who have a local Redis instance or in a CI environment that
 * provides Redis as a service.
 *
 * Run with:
 *   RUN_INTEGRATION=1 npx vitest run tests/integration/phase3/redis.integration.test.ts
 *
 * Environment variables:
 *   REDIS_HOST     — Redis hostname (default: localhost)
 *   REDIS_PORT     — Redis port (default: 6379)
 *   REDIS_PASSWORD — Redis password (optional)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Redis from 'ioredis';

const RUN = process.env['RUN_INTEGRATION'] === '1';

// Gate: skip entire suite unless RUN_INTEGRATION=1.
// describe.skip is a no-op that prevents the suite body from executing.
// Dynamic imports inside beforeAll/it ensure ioredis is never loaded
// during normal (non-integration) runs.
describe(
  RUN
    ? 'Redis integration — LockProvider (real Redis)'
    : 'Redis integration (SKIPPED — set RUN_INTEGRATION=1)',
  () => {
    if (!RUN) {
      it.skip('skipped — set RUN_INTEGRATION=1 to enable', () => {});
      return;
    }

    const REDIS_HOST = process.env['REDIS_HOST'] ?? 'localhost';
    const REDIS_PORT = parseInt(process.env['REDIS_PORT'] ?? '6379', 10);
    const REDIS_PASSWORD = process.env['REDIS_PASSWORD'];

    // ---------------------------------------------------------------------------
    // Shared real Redis client (populated in beforeAll)
    // ---------------------------------------------------------------------------

    let client: Redis;

    beforeAll(async () => {
      const { default: RedisConstructor } = await import('ioredis');
      client = new RedisConstructor({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        maxRetriesPerRequest: 2,
        connectTimeout: 3_000,
        lazyConnect: false,
      });
      // Wait for connection.
      await client.ping();
    });

    afterAll(async () => {
      if (client) {
        await client.del(
          'hoplon:lock:integration:test-key',
          'hoplon:lock:integration:serial-key',
          'hoplon:lock:project:integration-alpha:snapshot',
          'hoplon:lock:project:integration-beta:snapshot',
        );
        await client.quit();
      }
    });

    // ---------------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------------

    it('acquires and releases a lock against real Redis', async () => {
      const { createRedisRedlockProvider } = await import(
        '../../../src/hoplon/adapters/lockProvider/redisRedlock.js'
      );

      const lock = createRedisRedlockProvider({
        clients: [client],
        ttlMs: 5_000,
        retryCount: 3,
        retryDelayMs: 100,
      });

      const release = await lock.acquire('integration:test-key');
      expect(typeof release).toBe('function');

      // Key must exist in Redis while held.
      const keys = await client.keys('hoplon:lock:integration:test-key');
      expect(keys.length).toBeGreaterThan(0);

      release();

      // Allow async release to propagate.
      await new Promise<void>((res) => setTimeout(res, 200));

      // Key must be gone after release.
      const keysAfter = await client.keys('hoplon:lock:integration:test-key');
      expect(keysAfter).toHaveLength(0);
    });

    it('serializes concurrent acquires against real Redis', async () => {
      const { createRedisRedlockProvider } = await import(
        '../../../src/hoplon/adapters/lockProvider/redisRedlock.js'
      );

      const lock = createRedisRedlockProvider({
        clients: [client],
        ttlMs: 5_000,
        retryCount: 20,
        retryDelayMs: 100,
      });

      let counter = 0;
      const snapshots: number[] = [];
      const CONCURRENCY = 5;

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        const release = await lock.acquire('integration:serial-key');
        try {
          const snap = counter;
          snapshots.push(snap);
          await new Promise<void>((res) => setTimeout(res, 20)); // real async delay
          counter = snap + 1;
        } finally {
          release();
        }
      });

      await Promise.all(workers);

      expect(counter).toBe(CONCURRENCY);
      expect(snapshots).toEqual([0, 1, 2, 3, 4]);
    });

    it('W2 per-project wrapper composes with real Redis', async () => {
      const { createRedisRedlockProvider } = await import(
        '../../../src/hoplon/adapters/lockProvider/redisRedlock.js'
      );
      const { createPerProjectLockProvider } = await import(
        '../../../src/hoplon/adapters/lock-per-project.js'
      );

      const base = createRedisRedlockProvider({
        clients: [client],
        ttlMs: 5_000,
        retryCount: 10,
        retryDelayMs: 100,
      });
      const perProject = createPerProjectLockProvider({ baseLockProvider: base });

      const [releaseAlpha, releaseBeta] = await Promise.all([
        perProject.acquire('integration-alpha:snapshot'),
        perProject.acquire('integration-beta:snapshot'),
      ]);

      expect(typeof releaseAlpha).toBe('function');
      expect(typeof releaseBeta).toBe('function');

      releaseAlpha();
      releaseBeta();
    });
  },
);
