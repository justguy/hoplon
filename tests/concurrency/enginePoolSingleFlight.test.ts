/**
 * tests/concurrency/enginePoolSingleFlight.test.ts — GAP G2 regression.
 *
 * Concurrent acquire() calls for the same project key must share a single
 * engine construction (single-flight). The prior implementation let two
 * concurrent acquirers both pass the `entries.get(projectId)` miss and each
 * call buildEngine(), constructing two engines; the second overwrote the first
 * in the map, leaking the first engine.
 *
 * A failed build must clear the in-flight slot so a later acquire can retry.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHoplonEnginePool } from '../../src/hoplon/concurrency/enginePool.js';
import * as factory from '../../src/hoplon/engine/factory.js';
import type { HoplonAdapters } from '../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GAP G2 — engine pool single-flight construction', () => {
  it('two concurrent acquisitions for the same project share one engine + one build', async () => {
    const adapters = await makeAdapters();
    const spy = vi.spyOn(factory, 'createHoplonEngine');
    const pool = createHoplonEnginePool({
      maxConcurrent: 4,
      adapters,
      config: { fsRoot: '/' },
      engineIdPrefix: 'sf',
    });

    const [e1, e2] = await Promise.all([
      pool.acquire('projA'),
      pool.acquire('projA'),
    ]);

    // Same engine instance — no duplicate construction, no leak.
    expect(e1).toBe(e2);
    // Exactly one construction happened for the two concurrent acquirers.
    expect(spy).toHaveBeenCalledTimes(1);

    // Both references are tracked against the single entry.
    const stats = pool.stats();
    expect(stats.currentSize).toBe(1);
    expect(stats.busyCount).toBe(1);
    expect(stats.totalAcquired).toBe(2);

    await pool.shutdown({ drainTimeoutMs: 0 });
  }, 30_000);

  it('two queued waiters for the same project share one engine (waiter dispatch is single-flight)', async () => {
    const adapters = await makeAdapters();
    const spy = vi.spyOn(factory, 'createHoplonEngine');
    const pool = createHoplonEnginePool({
      maxConcurrent: 2,
      adapters,
      config: { fsRoot: '/' },
      engineIdPrefix: 'sf',
    });

    // Fill the pool: projX and projZ both busy.
    const eX = await pool.acquire('projX');
    const eZ = await pool.acquire('projZ');

    // Two acquisitions for projY queue as waiters (pool full, nothing idle).
    const p1 = pool.acquire('projY');
    const p2 = pool.acquire('projY');

    // Two releases fire dispatchNextWaiter twice back to back. The second
    // dispatch must share the first waiter's in-flight build, not start a
    // duplicate construction that clobbers the entry and leaks an engine.
    pool.release('projX');
    pool.release('projZ');

    const [eB, eC] = await Promise.all([p1, p2]);

    // One shared engine instance for both same-project waiters.
    expect(eB).toBe(eC);
    expect(eB).not.toBe(eX);
    expect(eB).not.toBe(eZ);
    // Exactly 3 constructions: projX, projZ, and ONE for projY (not 4).
    expect(spy).toHaveBeenCalledTimes(3);

    const stats = pool.stats();
    // Only projX was evicted to make room; projZ idles in the pool.
    expect(stats.totalEvicted).toBe(1);
    expect(stats.currentSize).toBe(2);
    expect(stats.projectIds).toContain('projY');
    expect(stats.projectIds).toContain('projZ');
    expect(stats.busyCount).toBe(1);
    expect(stats.idleCount).toBe(1);
    expect(stats.totalAcquired).toBe(4);

    // refCount correctness: after ONE release the other holder still uses the
    // engine — it must not read idle/evictable mid-use.
    pool.release('projY');
    expect(pool.stats().busyCount).toBe(1);
    pool.release('projY');
    expect(pool.stats().busyCount).toBe(0);

    await pool.shutdown({ drainTimeoutMs: 0 });
  }, 30_000);

  it('a failed build clears the in-flight slot so a later acquire can retry', async () => {
    const adapters = await makeAdapters();
    const spy = vi.spyOn(factory, 'createHoplonEngine');
    // First construction rejects; subsequent constructions use the real factory.
    spy.mockRejectedValueOnce(new Error('boom during build'));

    const pool = createHoplonEnginePool({
      maxConcurrent: 4,
      adapters,
      config: { fsRoot: '/' },
      engineIdPrefix: 'sf',
    });

    await expect(pool.acquire('projB')).rejects.toThrow('boom during build');

    // The in-flight slot must have been cleared — a retry builds successfully.
    const engine = await pool.acquire('projB');
    expect(engine).toBeDefined();
    expect(pool.stats().currentSize).toBe(1);

    await pool.shutdown({ drainTimeoutMs: 0 });
  }, 30_000);
});
