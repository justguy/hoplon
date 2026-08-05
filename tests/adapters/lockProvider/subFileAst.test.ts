/**
 * tests/adapters/lockProvider/subFileAst.test.ts — t-041 Sub-file AST mutexes
 *
 * Proof inventory (all use in-memory AsyncMutex — no I/O, no network):
 *
 *   P1. Different nodes in the same file → parallel
 *         Promise.all resolves without one blocking the other.
 *
 *   P2. Same node twice → serialized
 *         Second acquire resolves only after the first release.
 *
 *   P3. Overlapping byteRanges → serialized via lockAstRegionMulti
 *         Overlap detected by buildOverlapKeySet; both keys acquired in
 *         sorted order; second caller waits for first to finish.
 *
 *   P4. Different files, same byteRange → parallel
 *         File path is in the key namespace — different files never contend.
 *
 *   P5. Composes cleanly over createAsyncMutexLockProvider
 *         No contract surface changes; LockProvider interface satisfied.
 *
 *   P6. astNodeLockKey — pure key format
 *         Kind present + kind absent + edge values.
 *
 *   P7. buildOverlapKeySet — overlap detection
 *         Non-overlapping pair returns only target keys.
 *         Overlapping pair returns union of both keys.
 *         Adjacent (touching) ranges are NOT considered overlapping.
 *
 *   P8. lockAstRegionMulti — idempotent composite release
 *         Calling the composite release twice does not throw or double-release.
 *
 *   P9. lockAstRegion convenience wrapper — exception safety
 *         Lock is released even when fn() throws.
 *
 *   P10. Multi-key acquisition order is deadlock-free
 *          Two concurrent callers acquiring the same two keys in reverse order
 *          both complete without deadlock.
 */

import { describe, it, expect } from 'vitest';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import {
  createSubFileAstLockProvider,
  astNodeLockKey,
  lockAstRegion,
  lockAstRegionMulti,
  buildOverlapKeySet,
} from '../../../src/hoplon/adapters/lockProvider/subFileAst.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT = 'proj-a';
const FILE_A = '/src/a.ts';
const FILE_B = '/src/b.ts';

const NODE_1: { byteRange: [number, number]; kind: string } = {
  byteRange: [0, 100],
  kind: 'function_declaration',
};
const NODE_2: { byteRange: [number, number]; kind: string } = {
  byteRange: [200, 300],
  kind: 'function_declaration',
};
// Overlaps with NODE_1 (spans 50–150, which intersects 0–100 at 50–100).
const NODE_OVERLAP_1: { byteRange: [number, number]; kind: string } = {
  byteRange: [50, 150],
  kind: 'function_declaration',
};
// Adjacent to NODE_1 (starts exactly where NODE_1 ends — not overlapping).
const NODE_ADJACENT: { byteRange: [number, number]; kind: string } = {
  byteRange: [100, 200],
  kind: 'function_declaration',
};

function makeProvider() {
  const base = createAsyncMutexLockProvider();
  return { base, ast: createSubFileAstLockProvider({ baseLockProvider: base }) };
}

// ---------------------------------------------------------------------------
// P1 — Different nodes in the same file run in parallel
// ---------------------------------------------------------------------------

describe('P1: different nodes in the same file — parallel', () => {
  it('acquiring keys for node-1 and node-2 resolves without blocking each other', async () => {
    const { ast } = makeProvider();
    const key1 = astNodeLockKey(PROJECT, FILE_A, NODE_1);
    const key2 = astNodeLockKey(PROJECT, FILE_A, NODE_2);

    const [r1, r2] = await Promise.all([ast.acquire(key1), ast.acquire(key2)]);

    // Both resolved — they ran in parallel.
    r1();
    r2();
  });
});

// ---------------------------------------------------------------------------
// P2 — Same node twice → serialized
// ---------------------------------------------------------------------------

describe('P2: same node twice — serialized', () => {
  it('second acquire on the same node key waits for the first release', async () => {
    const { ast } = makeProvider();
    const key = astNodeLockKey(PROJECT, FILE_A, NODE_1);
    const order: string[] = [];

    const r1 = await ast.acquire(key);
    order.push('acquired-1');

    const acquire2 = ast.acquire(key);
    order.push('queued-2');

    r1();
    order.push('released-1');

    const r2 = await acquire2;
    order.push('acquired-2');
    r2();

    expect(order).toEqual(['acquired-1', 'queued-2', 'released-1', 'acquired-2']);
  });
});

// ---------------------------------------------------------------------------
// P3 — Overlapping byteRanges → serialized via lockAstRegionMulti
// ---------------------------------------------------------------------------

describe('P3: overlapping byteRanges — serialized', () => {
  it('two operations with overlapping ranges cannot proceed concurrently', async () => {
    const { base } = makeProvider();
    const order: string[] = [];

    // Caller A wants to work on NODE_1 (0–100).
    // Caller B wants to work on NODE_OVERLAP_1 (50–150).
    // Both callers compute the overlap key set: it includes both node keys.
    const keysA = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1], [NODE_OVERLAP_1]);
    const keysB = buildOverlapKeySet(PROJECT, FILE_A, [NODE_OVERLAP_1], [NODE_1]);

    // Caller A acquires first.
    const releaseA = await lockAstRegionMulti(base, keysA);
    order.push('A-acquired');

    // Caller B tries concurrently — must wait because keysA and keysB share keys.
    const acquireBPromise = lockAstRegionMulti(base, keysB);
    order.push('B-queued');

    // Verify B has NOT resolved yet.
    let bResolved = false;
    acquireBPromise.then(() => {
      bResolved = true;
    });

    // Yield to microtask queue — B should NOT have resolved.
    await Promise.resolve();
    expect(bResolved).toBe(false);
    order.push('before-A-release');

    // Release A.
    releaseA();
    order.push('A-released');

    // Now B can acquire.
    const releaseB = await acquireBPromise;
    order.push('B-acquired');
    releaseB();

    expect(order).toEqual([
      'A-acquired',
      'B-queued',
      'before-A-release',
      'A-released',
      'B-acquired',
    ]);
  });
});

// ---------------------------------------------------------------------------
// P4 — Different files, same byteRange → parallel
// ---------------------------------------------------------------------------

describe('P4: different files, same byteRange — parallel', () => {
  it('same node descriptor in different files does not block', async () => {
    const { ast } = makeProvider();
    const keyA = astNodeLockKey(PROJECT, FILE_A, NODE_1);
    const keyB = astNodeLockKey(PROJECT, FILE_B, NODE_1);

    // Different file paths produce different keys.
    expect(keyA).not.toBe(keyB);

    // Both resolve immediately in parallel.
    const [rA, rB] = await Promise.all([ast.acquire(keyA), ast.acquire(keyB)]);
    rA();
    rB();
  });
});

// ---------------------------------------------------------------------------
// P5 — Composes cleanly over createAsyncMutexLockProvider
// ---------------------------------------------------------------------------

describe('P5: contract composition', () => {
  it('returned value satisfies LockProvider interface', () => {
    const { ast } = makeProvider();
    expect(typeof ast.acquire).toBe('function');
  });

  it('does not mutate or wrap the baseLockProvider object identity', () => {
    const base = createAsyncMutexLockProvider();
    const ast = createSubFileAstLockProvider({ baseLockProvider: base });
    // ast is a different object (wrapper), not the same reference.
    expect(ast).not.toBe(base);
    // But acquire on ast delegates to base — prove by checking base map size.
    const key = astNodeLockKey(PROJECT, FILE_A, NODE_1);
    const acquirePromise = ast.acquire(key);
    // base should now have one entry because ast forwarded the acquire.
    expect(base.__debugSize()).toBe(1);
    acquirePromise.then((r) => r());
  });
});

// ---------------------------------------------------------------------------
// P6 — astNodeLockKey pure key format
// ---------------------------------------------------------------------------

describe('P6: astNodeLockKey — key format', () => {
  it('includes kind when provided', () => {
    const key = astNodeLockKey('proj', '/src/foo.ts', {
      byteRange: [10, 20],
      kind: 'class_declaration',
    });
    expect(key).toBe('ast:proj:/src/foo.ts:class_declaration@10-20');
  });

  it('uses "node" as kind when kind is omitted', () => {
    const key = astNodeLockKey('proj', '/src/foo.ts', { byteRange: [10, 20] });
    expect(key).toBe('ast:proj:/src/foo.ts:node@10-20');
  });

  it('different projectIds produce different keys for the same node', () => {
    const a = astNodeLockKey('proj-a', '/src/foo.ts', { byteRange: [0, 50] });
    const b = astNodeLockKey('proj-b', '/src/foo.ts', { byteRange: [0, 50] });
    expect(a).not.toBe(b);
  });

  it('byteRange (0, 0) produces a valid (though unusual) key', () => {
    const key = astNodeLockKey('p', '/f.ts', { byteRange: [0, 0] });
    expect(key).toBe('ast:p:/f.ts:node@0-0');
  });
});

// ---------------------------------------------------------------------------
// P7 — buildOverlapKeySet — overlap detection
// ---------------------------------------------------------------------------

describe('P7: buildOverlapKeySet', () => {
  it('non-overlapping nodes return only target keys', () => {
    const keys = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1], [NODE_2]);
    // NODE_2 (200–300) does not overlap NODE_1 (0–100).
    expect(keys).toHaveLength(1);
    expect(keys).toContain(astNodeLockKey(PROJECT, FILE_A, NODE_1));
    expect(keys).not.toContain(astNodeLockKey(PROJECT, FILE_A, NODE_2));
  });

  it('overlapping nodes include both keys', () => {
    const keys = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1], [NODE_OVERLAP_1]);
    // NODE_OVERLAP_1 (50–150) overlaps NODE_1 (0–100).
    expect(keys).toHaveLength(2);
    expect(keys).toContain(astNodeLockKey(PROJECT, FILE_A, NODE_1));
    expect(keys).toContain(astNodeLockKey(PROJECT, FILE_A, NODE_OVERLAP_1));
  });

  it('adjacent (touching) ranges are NOT overlapping', () => {
    const keys = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1], [NODE_ADJACENT]);
    // NODE_ADJACENT starts at 100, NODE_1 ends at 100 — touching but not overlapping.
    expect(keys).toHaveLength(1);
    expect(keys).toContain(astNodeLockKey(PROJECT, FILE_A, NODE_1));
  });

  it('target node is always included even with empty allNodes', () => {
    const keys = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(astNodeLockKey(PROJECT, FILE_A, NODE_1));
  });

  it('deduplicates when target itself appears in allNodes', () => {
    // If the caller accidentally passes the target in allNodes too, we
    // must not produce duplicate keys.
    const keys = buildOverlapKeySet(PROJECT, FILE_A, [NODE_1], [NODE_1]);
    expect(keys).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P8 — lockAstRegionMulti — idempotent composite release
// ---------------------------------------------------------------------------

describe('P8: lockAstRegionMulti — composite release idempotency', () => {
  it('calling composite release twice does not throw', async () => {
    const base = createAsyncMutexLockProvider();
    const keys = [
      astNodeLockKey(PROJECT, FILE_A, NODE_1),
      astNodeLockKey(PROJECT, FILE_A, NODE_2),
    ];

    const release = await lockAstRegionMulti(base, keys);

    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow(); // second call: no-op

    // Both keys should be acquirable again (lock was released).
    const [r1, r2] = await Promise.all([
      base.acquire(astNodeLockKey(PROJECT, FILE_A, NODE_1)),
      base.acquire(astNodeLockKey(PROJECT, FILE_A, NODE_2)),
    ]);
    r1();
    r2();
  });
});

// ---------------------------------------------------------------------------
// P9 — lockAstRegion convenience wrapper — exception safety
// ---------------------------------------------------------------------------

describe('P9: lockAstRegion — exception safety', () => {
  it('releases the lock even when fn() throws', async () => {
    const base = createAsyncMutexLockProvider();
    const node = NODE_1;

    await expect(
      lockAstRegion(base, PROJECT, FILE_A, node, async () => {
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    // Lock must be free — we can acquire it again immediately.
    const r = await base.acquire(astNodeLockKey(PROJECT, FILE_A, node));
    expect(typeof r).toBe('function');
    r();
  });

  it('returns the value from fn() on success', async () => {
    const base = createAsyncMutexLockProvider();
    const result = await lockAstRegion(base, PROJECT, FILE_A, NODE_1, async () => 42);
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// P10 — Deadlock freedom under reverse-order concurrent acquisition
// ---------------------------------------------------------------------------

describe('P10: lockAstRegionMulti — deadlock-free reverse-order acquisition', () => {
  it('two callers acquiring the same two keys in opposite order both complete', async () => {
    const base = createAsyncMutexLockProvider();
    const key1 = astNodeLockKey(PROJECT, FILE_A, NODE_1);
    const key2 = astNodeLockKey(PROJECT, FILE_A, NODE_2);

    const order: string[] = [];

    // Caller A: [key1, key2] — after sort: [key1, key2]
    async function callerA() {
      const release = await lockAstRegionMulti(base, [key1, key2]);
      order.push('A');
      // Simulate async work.
      await Promise.resolve();
      release();
    }

    // Caller B: [key2, key1] — after sort: [key1, key2] (same sorted order!)
    async function callerB() {
      const release = await lockAstRegionMulti(base, [key2, key1]);
      order.push('B');
      await Promise.resolve();
      release();
    }

    // Both callers start concurrently.
    await Promise.all([callerA(), callerB()]);

    // Both completed — no deadlock.
    expect(order).toHaveLength(2);
    expect(order).toContain('A');
    expect(order).toContain('B');
  });
});
