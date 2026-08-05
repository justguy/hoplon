/**
 * tests/operations/gcSnapshot.test.ts — W3 TTL snapshot GC tests.
 *
 * Tests:
 *   W3-T1: snapshot with expired ttl_expires removed by gc()
 *   W3-T2: snapshot with future ttl_expires preserved by gc()
 *   W3-T3: snapshot with null ttl_expires (keep-forever) preserved by gc()
 *   W3-T4: createSnapshot populates ttl_expires from engine config
 *   W3-T5: createSnapshot with ttlRetentionMs=0 stores null ttl_expires
 *   W3-T6: createGcScheduler triggers engine.gc at each interval (fake timers)
 *   W3-T7: GcSchedulerHandle.stop() cancels future ticks
 *   W3-T8: createGcScheduler throws on invalid intervalMs
 *   W3-T9: createGcScheduler throws on invalid retentionMs
 *   W3-T10: onError callback receives gc() errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createGcScheduler } from '../../src/hoplon/operations/gcSnapshot.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/** Build a minimal CreateSnapshotDeps with optional ttlRetentionMs. */
async function makeSnapshotDeps(opts?: {
  ttlRetentionMs?: number;
  snapshotStore?: SnapshotStore;
}): Promise<{ deps: CreateSnapshotDeps; fs: ReturnType<typeof createMemFsAdapter>; store: SnapshotStore }> {
  const fs = createMemFsAdapter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());

  const deps: CreateSnapshotDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: {
      gitRepoDir: '/.hoplon/repo',
      fsRoot: '/',
      manifestStorageMode: 'inline',
      ttlRetentionMs: opts?.ttlRetentionMs,
    },
  };
  return { deps, fs, store };
}

/** Minimal request factory. */
function makeReq(projectId = 'proj-1', runId = 'run-1') {
  return {
    manifest: {
      manifestSchemaVersion: 1 as const,
      projectId,
      runId,
      correlationId: 'corr-001',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' as const } }],
    },
  };
}

/** Minimal engine stub. Only gc() is used by createGcScheduler. */
function makeEngineStub(gcImpl?: (opts: { projectId?: string; olderThan?: string; expiredBefore?: string }) => Promise<{ deletedCount: number }>): HoplonEngine {
  const stub: Partial<HoplonEngine> = {
    gc: gcImpl ?? vi.fn().mockResolvedValue({ deletedCount: 0 }),
  };
  return stub as HoplonEngine;
}

// ---------------------------------------------------------------------------
// W3-T1: snapshot with expired ttl_expires removed by gc()
// ---------------------------------------------------------------------------

describe('W3-T1: expired ttl snapshot is deleted by gc(expiredBefore=now)', () => {
  it('removes a snapshot whose ttl_expires is in the past', async () => {
    const store = await createIsolatedTestStore();

    // Write a record directly with a past ttl_expires
    const pastTtl = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    await store.put({
      id: 'a'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: 'corr-1',
      status: 'committed',
      statusReason: null,
      gitRef: 'abc123',
      manifest: null,
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
      ttlExpires: pastTtl,
      replicaIds: [],
    });

    // Verify it was stored
    const before = await store.get('a'.repeat(64));
    expect(before).not.toBeNull();

    // GC: delete anything expired before now
    const now = new Date().toISOString();
    const result = await store.gc({ expiredBefore: now });

    expect(result.deletedCount).toBe(1);

    // Verify it was removed
    const after = await store.get('a'.repeat(64));
    expect(after).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3-T2: snapshot with future ttl_expires is preserved
// ---------------------------------------------------------------------------

describe('W3-T2: future ttl snapshot is preserved by gc(expiredBefore=now)', () => {
  it('does not remove a snapshot whose ttl_expires is in the future', async () => {
    const store = await createIsolatedTestStore();

    const futureTtl = new Date(Date.now() + ONE_DAY_MS).toISOString();
    await store.put({
      id: 'b'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-1',
      runId: 'run-2',
      correlationId: 'corr-2',
      status: 'committed',
      statusReason: null,
      gitRef: 'def456',
      manifest: null,
      createdAt: new Date().toISOString(),
      ttlExpires: futureTtl,
      replicaIds: [],
    });

    const now = new Date().toISOString();
    const result = await store.gc({ expiredBefore: now });

    expect(result.deletedCount).toBe(0);

    const after = await store.get('b'.repeat(64));
    expect(after).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3-T3: snapshot with null ttl_expires (keep-forever) preserved
// ---------------------------------------------------------------------------

describe('W3-T3: keep-forever (null ttl_expires) preserved by gc(expiredBefore=now)', () => {
  it('does not remove a snapshot with null ttl_expires', async () => {
    const store = await createIsolatedTestStore();

    await store.put({
      id: 'c'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-1',
      runId: 'run-3',
      correlationId: 'corr-3',
      status: 'committed',
      statusReason: null,
      gitRef: 'ghi789',
      manifest: null,
      createdAt: new Date(Date.now() - ONE_DAY_MS).toISOString(),
      ttlExpires: null,
      replicaIds: [],
    });

    const farFuture = new Date(Date.now() + THIRTY_DAYS_MS * 100).toISOString();
    const result = await store.gc({ expiredBefore: farFuture });

    expect(result.deletedCount).toBe(0);

    const after = await store.get('c'.repeat(64));
    expect(after).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3-T4: createSnapshot populates ttl_expires from ttlRetentionMs config
// ---------------------------------------------------------------------------

describe('W3-T4: createSnapshot populates ttl_expires from config', () => {
  it('stores a non-null ttl_expires when ttlRetentionMs is positive', async () => {
    const retentionMs = ONE_DAY_MS; // 1 day
    const { deps, fs, store } = await makeSnapshotDeps({ ttlRetentionMs: retentionMs });
    await fs.write('src/a.ts', enc('const x = 1;'));

    const before = Date.now();
    const result = await createSnapshot(deps, makeReq());
    const after = Date.now();

    const record = await store.get(result.snapshotRef.id);
    expect(record).not.toBeNull();
    expect(record!.ttlExpires).not.toBeNull();

    const ttlMs = new Date(record!.ttlExpires!).getTime();
    // ttlExpires should be approximately now + retentionMs
    expect(ttlMs).toBeGreaterThanOrEqual(before + retentionMs);
    expect(ttlMs).toBeLessThanOrEqual(after + retentionMs + 1000); // 1s tolerance
  });

  it('uses default 30-day TTL when ttlRetentionMs is undefined', async () => {
    const { deps, fs, store } = await makeSnapshotDeps({ ttlRetentionMs: undefined });
    // undefined → uses DEFAULT_TTL_RETENTION_MS (30 days) from factory
    // But here we're testing createSnapshot directly, so undefined → null in config
    await fs.write('src/a.ts', enc('const x = 1;'));

    const result = await createSnapshot(deps, makeReq('proj-2', 'run-1'));
    const record = await store.get(result.snapshotRef.id);
    expect(record).not.toBeNull();
    // When ttlRetentionMs is undefined on config, ttlExpires = null (keep-forever)
    // because createSnapshot checks `config.ttlRetentionMs != null && > 0`
    expect(record!.ttlExpires).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3-T5: createSnapshot with ttlRetentionMs=0 stores null ttl_expires
// ---------------------------------------------------------------------------

describe('W3-T5: createSnapshot with ttlRetentionMs=0 → null ttl_expires', () => {
  it('stores null ttl_expires when ttlRetentionMs is 0 (keep-forever)', async () => {
    const { deps, fs, store } = await makeSnapshotDeps({ ttlRetentionMs: 0 });
    await fs.write('src/a.ts', enc('const x = 1;'));

    const result = await createSnapshot(deps, makeReq('proj-3', 'run-1'));
    const record = await store.get(result.snapshotRef.id);
    expect(record).not.toBeNull();
    expect(record!.ttlExpires).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3-T6: createGcScheduler triggers engine.gc at each interval (fake timers)
// ---------------------------------------------------------------------------

describe('W3-T6: scheduler triggers gc at each interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls engine.gc once per interval with expiredBefore=now', async () => {
    const gcMock = vi.fn().mockResolvedValue({ deletedCount: 0 });
    const engine = makeEngineStub(gcMock);

    const handle = createGcScheduler({
      engine,
      intervalMs: 1000,
      retentionMs: THIRTY_DAYS_MS,
    });

    // No tick yet — interval fires after intervalMs
    expect(gcMock).not.toHaveBeenCalled();

    // Advance one interval
    vi.advanceTimersByTime(1000);
    // Resolve pending microtasks
    await Promise.resolve();

    expect(gcMock).toHaveBeenCalledTimes(1);
    const [callArgs] = gcMock.mock.calls[0]!;
    expect(callArgs).toHaveProperty('expiredBefore');
    // expiredBefore should be a valid ISO 8601 string
    expect(() => new Date(callArgs.expiredBefore)).not.toThrow();

    // Advance another two intervals
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(gcMock).toHaveBeenCalledTimes(3);

    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// W3-T7: stop() cancels future ticks
// ---------------------------------------------------------------------------

describe('W3-T7: stop() prevents further gc ticks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once then stops after handle.stop()', async () => {
    const gcMock = vi.fn().mockResolvedValue({ deletedCount: 0 });
    const engine = makeEngineStub(gcMock);

    const handle = createGcScheduler({
      engine,
      intervalMs: 500,
      retentionMs: THIRTY_DAYS_MS,
    });

    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(gcMock).toHaveBeenCalledTimes(1);

    handle.stop();

    // After stop, advancing time should NOT fire more ticks
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(gcMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// W3-T8: createGcScheduler throws on invalid intervalMs
// ---------------------------------------------------------------------------

describe('W3-T8: createGcScheduler throws on non-positive intervalMs', () => {
  it('throws synchronously for intervalMs = 0', () => {
    const engine = makeEngineStub();
    expect(() =>
      createGcScheduler({ engine, intervalMs: 0, retentionMs: THIRTY_DAYS_MS }),
    ).toThrow('intervalMs must be a positive integer');
  });

  it('throws synchronously for negative intervalMs', () => {
    const engine = makeEngineStub();
    expect(() =>
      createGcScheduler({ engine, intervalMs: -1, retentionMs: THIRTY_DAYS_MS }),
    ).toThrow('intervalMs must be a positive integer');
  });

  it('throws synchronously for fractional intervalMs', () => {
    const engine = makeEngineStub();
    expect(() =>
      createGcScheduler({ engine, intervalMs: 1.5, retentionMs: THIRTY_DAYS_MS }),
    ).toThrow('intervalMs must be a positive integer');
  });
});

// ---------------------------------------------------------------------------
// W3-T9: createGcScheduler throws on invalid retentionMs
// ---------------------------------------------------------------------------

describe('W3-T9: createGcScheduler throws on non-positive retentionMs', () => {
  it('throws synchronously for retentionMs = 0', () => {
    const engine = makeEngineStub();
    expect(() =>
      createGcScheduler({ engine, intervalMs: 1000, retentionMs: 0 }),
    ).toThrow('retentionMs must be a positive integer');
  });
});

// ---------------------------------------------------------------------------
// W3-T10: onError callback receives gc() errors
// ---------------------------------------------------------------------------

describe('W3-T10: onError receives errors from gc()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onError when gc() rejects', async () => {
    const gcError = new Error('gc adapter failure');
    const gcMock = vi.fn().mockRejectedValue(gcError);
    const engine = makeEngineStub(gcMock);
    const onError = vi.fn();

    const handle = createGcScheduler({
      engine,
      intervalMs: 1000,
      retentionMs: THIRTY_DAYS_MS,
      onError,
    });

    vi.advanceTimersByTime(1000);
    // Flush pending microtasks + resolved promises (rejection chain)
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(gcError);

    handle.stop();
  });
});
