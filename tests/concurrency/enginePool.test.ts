/**
 * tests/concurrency/enginePool.test.ts — W4 engine pool tests.
 *
 * 15 required tests:
 *  W4-1  Same project → same engine
 *  W4-2  Different projects → different engines
 *  W4-3  Release decrements refCount
 *  W4-4  Over maxConcurrent → LRU eviction of idle entry
 *  W4-5  Over maxConcurrent with all busy → acquire waits
 *  W4-6  Acquire timeout
 *  W4-7  Acquire AbortSignal
 *  W4-8  Release idempotent on over-release
 *  W4-9  Release on unknown projectId
 *  W4-10 Shutdown waits for busy engines to be released
 *  W4-11 Shutdown timeout
 *  W4-12 Shutdown rejects pending waiters
 *  W4-13 EngineId distinctness
 *  W4-14 End-to-end smoke with real engine operations
 *  W4-15 Concurrent acquire/release stress
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createHoplonEnginePool } from '../../src/hoplon/concurrency/enginePool.js';
import { EngineError } from '../../src/hoplon/contracts/errors.js';
import type { HoplonAdapters } from '../../src/hoplon/engine/types.js';
import type { HoplonEnginePool } from '../../src/hoplon/concurrency/enginePool.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

async function makeAdapters(): Promise<HoplonAdapters> {
  const fs = createMemFsAdapter();
  return {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: await createIsolatedTestStore(),
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    codeIntelligence: sharedCI,
    secretScanner: createBuiltinRegexScanner(),
  };
}

// Track pools created per test so we can shut them down in afterEach
const openPools: HoplonEnginePool[] = [];

afterEach(async () => {
  // Drain pools opened by tests. Best-effort; failures here shouldn't mask test failures.
  for (const pool of openPools.splice(0)) {
    try {
      await pool.shutdown({ drainTimeoutMs: 0 });
    } catch {
      // ignore
    }
  }
});

async function makePool(
  overrides?: Partial<Parameters<typeof createHoplonEnginePool>[0]>,
): Promise<HoplonEnginePool> {
  const adapters = await makeAdapters();
  const pool = createHoplonEnginePool({
    maxConcurrent: 4,
    adapters,
    config: { fsRoot: '/' },
    engineIdPrefix: 'test',
    ...overrides,
  });
  openPools.push(pool);
  return pool;
}

// ---------------------------------------------------------------------------
// W4-1: Same project → same engine
// ---------------------------------------------------------------------------

describe('W4-1 — same project acquires same engine instance', () => {
  it('acquire called twice for same projectId returns the same engine object', async () => {
    const pool = await makePool();

    const e1 = await pool.acquire('projA');
    const e2 = await pool.acquire('projA');

    expect(e1).toBe(e2);

    // refCount is now 2; busyCount should be 1
    const s = pool.stats();
    expect(s.busyCount).toBe(1);
    expect(s.totalAcquired).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// W4-2: Different projects → different engines
// ---------------------------------------------------------------------------

describe('W4-2 — different projects get different engine instances', () => {
  it('acquire for projA and projB returns distinct engine objects', async () => {
    const pool = await makePool();

    const eA = await pool.acquire('projA');
    const eB = await pool.acquire('projB');

    expect(eA).not.toBe(eB);

    // Each engine should have a distinct engineId
    const hA = await eA.health();
    const hB = await eB.health();
    expect(hA.engineId).not.toBe(hB.engineId);
  });
});

// ---------------------------------------------------------------------------
// W4-3: Release decrements refCount
// ---------------------------------------------------------------------------

describe('W4-3 — release decrements refCount correctly', () => {
  it('two acquires + one release → busyCount still 1', async () => {
    const pool = await makePool();

    await pool.acquire('projA');
    await pool.acquire('projA');
    pool.release('projA');

    const s = pool.stats();
    expect(s.busyCount).toBe(1);
    expect(s.idleCount).toBe(0);
  });

  it('two acquires + two releases → busyCount 0, idleCount 1', async () => {
    const pool = await makePool();

    await pool.acquire('projA');
    await pool.acquire('projA');
    pool.release('projA');
    pool.release('projA');

    const s = pool.stats();
    expect(s.busyCount).toBe(0);
    expect(s.idleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W4-4: Over maxConcurrent → LRU eviction of idle entry
// ---------------------------------------------------------------------------

describe('W4-4 — LRU eviction when over maxConcurrent', () => {
  it('acquiring third project evicts the least-recently-released idle engine', async () => {
    const pool = await makePool({ maxConcurrent: 2 });

    const eA = await pool.acquire('projA');
    const eB = await pool.acquire('projB');

    // Both busy — release A first (makes it idle, LRU candidate)
    pool.release('projA');

    expect(pool.stats().busyCount).toBe(1);
    expect(pool.stats().idleCount).toBe(1);
    expect(pool.stats().totalEvicted).toBe(0);

    // Acquire projC — should evict projA (idle, LRU)
    const eC = await pool.acquire('projC');

    expect(eC).toBeDefined();
    expect(eC).not.toBe(eA);
    expect(eC).not.toBe(eB);

    const s = pool.stats();
    expect(s.currentSize).toBe(2);          // projB + projC
    expect(s.totalEvicted).toBe(1);         // projA evicted
    expect(s.projectIds).not.toContain('projA');
    expect(s.projectIds).toContain('projB');
    expect(s.projectIds).toContain('projC');
  });
});

// ---------------------------------------------------------------------------
// W4-5: Over maxConcurrent with all busy → acquire waits
// ---------------------------------------------------------------------------

describe('W4-5 — acquire waits when all slots busy', () => {
  it('queued acquire resolves after a slot is released', async () => {
    const pool = await makePool({ maxConcurrent: 2 });

    await pool.acquire('projA');
    await pool.acquire('projB');

    // All busy — start acquire for projC (must not resolve immediately)
    let resolved = false;
    const cPromise = pool.acquire('projC').then((e) => {
      resolved = true;
      return e;
    });

    // Yield to ensure the promise had a chance to settle if it were synchronous
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release projA → projC's acquire should now resolve
    pool.release('projA');

    const eC = await cPromise;
    expect(resolved).toBe(true);
    expect(eC).toBeDefined();

    // projA should be evicted; projB and projC present
    const s = pool.stats();
    expect(s.projectIds).not.toContain('projA');
    expect(s.projectIds).toContain('projC');
  });
});

// ---------------------------------------------------------------------------
// W4-6: Acquire timeout
// ---------------------------------------------------------------------------

describe('W4-6 — acquire timeout rejects with pool_exhausted', () => {
  it('times out with EngineError pool_exhausted when all slots busy', async () => {
    const pool = await makePool({ maxConcurrent: 1, acquireTimeoutMs: 100 });

    await pool.acquire('projA'); // fills the only slot

    await expect(pool.acquire('projB')).rejects.toMatchObject({
      kind: 'pool_exhausted',
    });
    await expect(pool.acquire('projB')).rejects.toBeInstanceOf(EngineError);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// W4-7: Acquire AbortSignal
// ---------------------------------------------------------------------------

describe('W4-7 — acquire AbortSignal', () => {
  it('acquire with already-aborted signal rejects immediately', async () => {
    const pool = await makePool({ maxConcurrent: 1 });
    await pool.acquire('projA'); // fill slot

    const controller = new AbortController();
    controller.abort();

    await expect(pool.acquire('projB', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('acquire aborted while waiting rejects', async () => {
    const pool = await makePool({ maxConcurrent: 1, acquireTimeoutMs: 10_000 });
    await pool.acquire('projA'); // fill slot

    const controller = new AbortController();

    const acqPromise = pool.acquire('projB', controller.signal);

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    await expect(acqPromise).rejects.toMatchObject({ name: 'AbortError' });
  }, 5_000);
});

// ---------------------------------------------------------------------------
// W4-8: Release idempotent on over-release
// ---------------------------------------------------------------------------

describe('W4-8 — over-release is a no-op (no throw)', () => {
  it('releasing more times than acquired does not throw', async () => {
    const pool = await makePool();

    await pool.acquire('projA');
    pool.release('projA');
    // Second release — should be a no-op
    expect(() => pool.release('projA')).not.toThrow();

    const s = pool.stats();
    expect(s.idleCount).toBe(1);
    expect(s.busyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W4-9: Release on unknown projectId
// ---------------------------------------------------------------------------

describe('W4-9 — release on unknown projectId is a no-op', () => {
  it('does not throw when releasing a projectId that was never acquired', async () => {
    const pool = await makePool();
    expect(() => pool.release('never-acquired')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// W4-10: Shutdown waits for busy engines to be released
// ---------------------------------------------------------------------------

describe('W4-10 — shutdown waits for busy engines', () => {
  it('shutdown resolves after busy engine is released within drain timeout', async () => {
    const pool = await makePool();
    await pool.acquire('projA');

    let shutdownDone = false;
    const shutdownPromise = pool.shutdown({ drainTimeoutMs: 1000 }).then(() => {
      shutdownDone = true;
    });

    // Shutdown should not resolve while projA is still busy
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdownDone).toBe(false);

    // Release projA → shutdown should now resolve
    pool.release('projA');

    await shutdownPromise;
    expect(shutdownDone).toBe(true);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// W4-11: Shutdown timeout
// ---------------------------------------------------------------------------

describe('W4-11 — shutdown timeout resolves even with outstanding acquires', () => {
  it('resolves after timeout when an engine is never released', async () => {
    const pool = await makePool();
    await pool.acquire('projA'); // never released

    const start = Date.now();
    await pool.shutdown({ drainTimeoutMs: 150 });
    const elapsed = Date.now() - start;

    // Should have resolved within ~500ms (generous bound for CI)
    expect(elapsed).toBeLessThan(500);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// W4-12: Shutdown rejects pending waiters
// ---------------------------------------------------------------------------

describe('W4-12 — shutdown rejects queued waiters with pool_shutting_down', () => {
  it('pending acquire rejects with EngineError pool_shutting_down on shutdown', async () => {
    const pool = await makePool({ maxConcurrent: 1, acquireTimeoutMs: 10_000 });
    await pool.acquire('projA'); // fill slot

    const cPromise = pool.acquire('projC');

    // Shutdown immediately (no drain)
    await pool.shutdown({ drainTimeoutMs: 0 });

    await expect(cPromise).rejects.toMatchObject({ kind: 'pool_shutting_down' });
    await expect(cPromise).rejects.toBeInstanceOf(EngineError);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// W4-13: EngineId distinctness
// ---------------------------------------------------------------------------

describe('W4-13 — all engines have distinct engineIds matching prefix', () => {
  it('three different projects get engines with distinct IDs matching engineIdPrefix', async () => {
    const pool = await makePool({ maxConcurrent: 4, engineIdPrefix: 'myprefix' });

    const e1 = await pool.acquire('projA');
    const e2 = await pool.acquire('projB');
    const e3 = await pool.acquire('projC');

    const [h1, h2, h3] = await Promise.all([e1.health(), e2.health(), e3.health()]);

    const ids = [h1.engineId, h2.engineId, h3.engineId];
    // All distinct
    expect(new Set(ids).size).toBe(3);
    // All match prefix
    for (const id of ids) {
      expect(id.startsWith('myprefix-')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// W4-14: End-to-end smoke with real engine operations
// ---------------------------------------------------------------------------

describe('W4-14 — end-to-end smoke with real engine operations', () => {
  it('two projects in the same pool can each createSnapshot with their own engineId', async () => {
    const pool = await makePool({ maxConcurrent: 4 });

    const _eA = await pool.acquire('smokeA');
    const _eB = await pool.acquire('smokeB');

    // Write distinct content to separate fs instances
    // Each engine has its own memfs, but they share adapters here.
    // We use different file paths to avoid collision.
    const _adapters = (pool as unknown as { _adapters?: HoplonAdapters })._adapters;
    // adapters is not exposed — use the engines' fs via createSnapshot
    // (the engines share the same fs adapter from makeAdapters — that's by design:
    // the pool wraps, not duplicates, adapters)

    // Write files via the engines
    const manifest1 = {
      manifestSchemaVersion: 1 as const,
      projectId: 'smokeA',
      runId: 'run-a',
      correlationId: 'corr-a',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' as const } }],
    };
    const manifest2 = {
      manifestSchemaVersion: 1 as const,
      projectId: 'smokeB',
      runId: 'run-b',
      correlationId: 'corr-b',
      entries: [{ path: 'src/b.ts', scope: { kind: 'whole_file' as const } }],
    };

    // Get the shared fs adapter through engine health; write via the factory approach
    // Both engines share the same adapters object — write files before snapshotting
    // Use adapters directly by re-making a fresh adapter set for this test
    const testAdapters = await makeAdapters();
    const enc = (s: string) => new TextEncoder().encode(s);
    await testAdapters.fs.write('src/a.ts', enc('export const a = 1;'));
    await testAdapters.fs.write('src/b.ts', enc('export const b = 2;'));

    // Create fresh pool using these adapters
    const freshPool = createHoplonEnginePool({
      maxConcurrent: 4,
      adapters: testAdapters,
      config: { fsRoot: '/' },
      engineIdPrefix: 'smoke',
    });
    openPools.push(freshPool);

    const fA = await freshPool.acquire('smokeA');
    const fB = await freshPool.acquire('smokeB');

    const [rA, rB] = await Promise.all([
      fA.createSnapshot({ manifest: manifest1 }),
      fB.createSnapshot({ manifest: manifest2 }),
    ]);

    // Phase 2 HA1: ID format is now sha256:<64-char-hex> (71 chars)
    expect(rA.snapshotRef.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rB.snapshotRef.id).toMatch(/^sha256:[0-9a-f]{64}$/);

    const [hA, hB] = await Promise.all([fA.health(), fB.health()]);
    expect(hA.engineId).not.toBe(hB.engineId);
    expect(rA.snapshotRef.engineId).toBe(hA.engineId);
    expect(rB.snapshotRef.engineId).toBe(hB.engineId);

    freshPool.release('smokeA');
    freshPool.release('smokeB');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// W4-15: Concurrent acquire/release stress
// ---------------------------------------------------------------------------

describe('W4-15 — concurrent acquire/release stress test', () => {
  it('20 cycles across 5 projects with maxConcurrent=3 — no corruption', async () => {
    const pool = await makePool({ maxConcurrent: 3, acquireTimeoutMs: 5_000 });

    const projects = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const cycles = 20;

    const allPromises: Promise<void>[] = [];

    for (let i = 0; i < cycles; i++) {
      const projectId = projects[i % projects.length]!;
      const p = (async () => {
        const engine = await pool.acquire(projectId);
        // Brief async work
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        expect(engine).toBeDefined();
        pool.release(projectId);
      })();
      allPromises.push(p);
    }

    // All should settle without unhandled rejections
    const results = await Promise.allSettled(allPromises);
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures).toHaveLength(0);

    // Final state: no entries should have a negative refCount (invariant)
    const s = pool.stats();
    expect(s.busyCount).toBeGreaterThanOrEqual(0);
    expect(s.idleCount).toBeGreaterThanOrEqual(0);
    expect(s.currentSize).toBeLessThanOrEqual(pool.stats().maxConcurrent);
    // busyCount + idleCount === currentSize
    expect(s.busyCount + s.idleCount).toBe(s.currentSize);
  }, 30_000);
});
