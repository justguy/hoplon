import { describe, expect, it } from 'vitest';

import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { computeSafeEditLockKeys } from '../../src/hoplon/session/safeEditLocking.js';
import { MANIFEST, makeMockEngine } from './helpers.js';

function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function advanceToSnapshotted(
  session: ReturnType<typeof createHoplonEditSession>,
): Promise<void> {
  await session.preflight();
  await session.createSnapshot();
}

function makeOverlapTrackingFs(base: ReturnType<typeof createMemFsAdapter>): {
  fs: HoplonFsAdapter;
  maxConcurrentWrites: () => number;
} {
  let concurrentWrites = 0;
  let maxConcurrentWrites = 0;
  const fs: HoplonFsAdapter = {
    read: (path) => base.read(path),
    list: (path) => base.list(path),
    stat: (path) => base.stat(path),
    mkdir: (path, opts) => base.mkdir(path, opts),
    remove: (path) => base.remove(path),
    async write(path, content) {
      concurrentWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await base.write(path, content);
      concurrentWrites -= 1;
    },
  };
  return { fs, maxConcurrentWrites: () => maxConcurrentWrites };
}

describe('t-113 lock topology guardrails', () => {
  it('omitted LockProvider leaves applyEdits lock-free and allows overlapping writes', async () => {
    const baseFs = createMemFsAdapter();
    await baseFs.write('src/foo.ts', enc('old'));
    const { fs, maxConcurrentWrites } = makeOverlapTrackingFs(baseFs);
    const engine = makeMockEngine();
    const sessionA = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    const sessionB = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    await Promise.all([
      sessionA.applyEdits([{ file: 'src/foo.ts', content: 'A' }]),
      sessionB.applyEdits([{ file: 'src/foo.ts', content: 'B' }]),
    ]);

    expect(maxConcurrentWrites()).toBeGreaterThan(1);
  });

  it('separate LockProvider instances are separate lock universes', async () => {
    const baseFs = createMemFsAdapter();
    await baseFs.write('src/foo.ts', enc('old'));
    const { fs, maxConcurrentWrites } = makeOverlapTrackingFs(baseFs);
    const engine = makeMockEngine();
    const sessionA = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      lockProvider: createAsyncMutexLockProvider(),
    });
    const sessionB = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      lockProvider: createAsyncMutexLockProvider(),
    });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    await Promise.all([
      sessionA.applyEdits([{ file: 'src/foo.ts', content: 'A' }]),
      sessionB.applyEdits([{ file: 'src/foo.ts', content: 'B' }]),
    ]);

    expect(maxConcurrentWrites()).toBeGreaterThan(1);
  });

  it('falls back to a whole-file key when structural AST resolution is unavailable', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const plan = await computeSafeEditLockKeys({
      proposedChanges: [
        {
          kind: 'structural',
          file: 'src/foo.ts',
          target: { symbol: 'foo' },
          content: 'export function foo() { return 2; }\n',
        },
      ],
      fs,
      codeIntelligence: null,
      projectId: MANIFEST.projectId,
    });

    expect(plan.counts).toEqual({ nodeKeys: 0, fileKeys: 1 });
    expect(plan.keys).toEqual([`file:${MANIFEST.projectId}:src/foo.ts`]);
  });
});
