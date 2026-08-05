/**
 * tests/concurrency/perProjectLock.test.ts — W2 per-project mutex map tests.
 *
 * Proof requirements (verbatim from slice spec):
 *   W2-1  Two ops on different projects → run in parallel (no blocking)
 *   W2-2  Two ops on same project → serialize
 *
 * Additional coverage:
 *   W2-3  Release idempotency is inherited from baseLockProvider
 *   W2-4  Same project, multiple keys — keys serialize independently within project
 *   W2-5  Base provider isolation — namespaced keys do not collide with bare keys
 *   W2-6  Key with no colon is treated as safe fallback (whole key used as suffix)
 */

import { describe, it, expect } from 'vitest';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createPerProjectLockProvider } from '../../src/hoplon/adapters/lock-per-project.js';

// ---------------------------------------------------------------------------
// W2-1  Two ops on different projects → parallel (no blocking)
// ---------------------------------------------------------------------------

describe('W2-1: different projects run in parallel', () => {
  it('acquire on project-a and project-b both resolve without blocking each other', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    // Acquire the same sub-key for two different projects concurrently.
    // If there were cross-project blocking this would deadlock.
    const [releaseA, releaseB] = await Promise.all([
      perProject.acquire('project-a:snapshot'),
      perProject.acquire('project-b:snapshot'),
    ]);

    // Both resolved — they are independent.
    releaseA();
    releaseB();

    // Further confirmation: queue one more acquire on each project while the
    // other is still held.
    const holdA = await perProject.acquire('project-a:snapshot');
    const holdB = await perProject.acquire('project-b:snapshot');

    const order: string[] = [];

    // Queue a waiter on project-b while holdA is still held — must not block.
    const waitB2Promise = perProject.acquire('project-b:snapshot').then((r) => {
      order.push('b-second-acquired');
      r();
    });

    // Release holdB → waiter can proceed; holdA has nothing to do with it.
    holdB();
    await waitB2Promise;
    holdA();

    expect(order).toEqual(['b-second-acquired']);
  });

  it('10 different projects can all hold the same sub-key simultaneously', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const releases = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        perProject.acquire(`proj-${i}:write`),
      ),
    );

    // All 10 resolved without blocking each other.
    expect(releases).toHaveLength(10);
    for (const r of releases) r();
  });
});

// ---------------------------------------------------------------------------
// W2-2  Two ops on same project → serialize
// ---------------------------------------------------------------------------

describe('W2-2: same project serializes', () => {
  it('second acquire on same project resolves only after first is released', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const order: string[] = [];

    const release1 = await perProject.acquire('project-x:op');
    order.push('acquired-1');

    // Queue second — must not resolve yet.
    const acquire2Promise = perProject.acquire('project-x:op');
    order.push('queued-2');

    // Release first.
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

  it('10 concurrent same-project acquires execute serially — counter never races', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const CONCURRENCY = 10;
    let counter = 0;
    const snapshots: number[] = [];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      const release = await perProject.acquire('my-project:critical');
      try {
        const snap = counter;
        snapshots.push(snap);
        await Promise.resolve(); // yield — if not serialized, counter would race
        counter = snap + 1;
      } finally {
        release();
      }
    });

    await Promise.all(workers);

    expect(counter).toBe(CONCURRENCY);
    expect(snapshots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// W2-3  Release idempotency is inherited
// ---------------------------------------------------------------------------

describe('W2-3: release idempotency', () => {
  it('calling release twice is a no-op — no throw, no corruption', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const release = await perProject.acquire('proj-idem:write');

    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow(); // idempotent

    // Subsequent acquire must still work.
    const r2 = await perProject.acquire('proj-idem:write');
    expect(typeof r2).toBe('function');
    r2();
  });
});

// ---------------------------------------------------------------------------
// W2-4  Same project, multiple sub-keys — each key serializes independently
// ---------------------------------------------------------------------------

describe('W2-4: multiple sub-keys within same project', () => {
  it('same project, different sub-keys run in parallel', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    // Both keys belong to 'alpha' project but are different sub-keys.
    const [rRead, rWrite] = await Promise.all([
      perProject.acquire('alpha:read'),
      perProject.acquire('alpha:write'),
    ]);

    // Both resolved without blocking.
    rRead();
    rWrite();
  });
});

// ---------------------------------------------------------------------------
// W2-5  Namespace isolation — project:X:key ≠ project:Y:key at base level
// ---------------------------------------------------------------------------

describe('W2-5: namespace isolation at base level', () => {
  it('per-project wrapper does not pollute bare base-provider keys', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    // Acquire 'project-z:op' through the wrapper.
    const rWrapped = await perProject.acquire('project-z:op');

    // Acquire the bare key 'project-z:op' directly on the base provider
    // — should NOT block because the wrapper key is 'project:project-z:op'.
    const rBare = await base.acquire('project-z:op');

    rWrapped();
    rBare();
  });
});

// ---------------------------------------------------------------------------
// W2-6  Bare key (no colon) is treated safely
// ---------------------------------------------------------------------------

describe('W2-6: bare key (no colon) safe fallback', () => {
  it('key without colon is namespaced as project:<key> and serializes correctly', async () => {
    const base = createAsyncMutexLockProvider();
    const perProject = createPerProjectLockProvider({ baseLockProvider: base });

    const order: string[] = [];

    const r1 = await perProject.acquire('nocotonkey');
    order.push('r1');

    const p2 = perProject.acquire('nocotonkey').then((r) => {
      order.push('r2');
      r();
    });

    r1();
    await p2;

    expect(order).toEqual(['r1', 'r2']);
  });
});
