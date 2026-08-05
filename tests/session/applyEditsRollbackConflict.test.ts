/**
 * tests/session/applyEditsRollbackConflict.test.ts — hcr-005 GAP fix:
 * guarded multi-file rollback.
 *
 * The supervised write path's rollback previously restored every file it had
 * flushed UNCONDITIONALLY, so a legitimate concurrent writer that landed
 * between our flush and the rollback was silently overwritten. The fix
 * verifies — per file, via the content hash captured at write time — that the
 * session is still the last writer before restoring; diverged files are left
 * untouched and reported as typed conflicts readable off the thrown error via
 * `readApplyEditsRollbackConflicts`.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { readApplyEditsRollbackConflicts } from '../../src/hoplon/session/applyEditsRollback.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function advanceToSnapshotted(
  session: ReturnType<typeof createHoplonEditSession>,
): Promise<void> {
  await session.preflight();
  await session.createSnapshot();
}

/**
 * Wrap a memfs base so that the write for `triggerPath` first runs
 * `beforeThrow` (simulating a concurrent writer landing after our earlier
 * flushes) and then throws an AdapterError without landing the write.
 */
function failingFsWithSideEffect(
  base: HoplonFsAdapter,
  triggerPath: string,
  beforeThrow: () => Promise<void>,
): HoplonFsAdapter {
  return {
    read: (path) => base.read(path),
    list: (path) => base.list(path),
    stat: (path) => base.stat(path),
    mkdir: (path, opts) => base.mkdir(path, opts),
    remove: (path) => base.remove(path),
    write: async (path, content) => {
      if (path === triggerPath) {
        await beforeThrow();
        throw new AdapterError(
          { kind: 'fs_write_failed', engineId: 'adapter', correlationId: 'adapter' },
          'simulated adapter failure',
        );
      }
      await base.write(path, content);
    },
  };
}

describe('applyEdits guarded rollback (hcr-005 rollback-overwrite gap)', () => {
  it('REGRESSION: concurrent post-write modification survives rollback and is reported as a conflict', async () => {
    const base = createMemFsAdapter();
    await base.write('src/a.ts', enc('export const a = 0;\n'));

    const fs = failingFsWithSideEffect(base, 'src/b.ts', async () => {
      // Concurrent writer lands on src/a.ts AFTER our flush of src/a.ts and
      // BEFORE the rollback triggered by the src/b.ts failure.
      await base.write('src/a.ts', enc('export const concurrent = 42;\n'));
    });
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        { file: 'src/a.ts', content: 'export const a = 1;\n' },
        { file: 'src/b.ts', content: 'export const b = 1;\n' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(session.state).toBe('snapshotted');

    // The concurrent writer's bytes survive — rollback did NOT overwrite them.
    expect(dec(await base.read('src/a.ts'))).toBe('export const concurrent = 42;\n');

    // The skipped restore is reported as a typed conflict on the thrown error.
    const conflicts = readApplyEditsRollbackConflicts(err);
    expect(conflicts).not.toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(conflicts?.[0]?.path).toBe('src/a.ts');
    expect(conflicts?.[0]?.reason).toBe('diverged_since_write');
    expect(conflicts?.[0]?.liveSha1).not.toBeNull();
  });

  it('concurrent post-write deletion is not resurrected by rollback and is reported as a conflict', async () => {
    const base = createMemFsAdapter();
    await base.write('src/a.ts', enc('export const a = 0;\n'));

    const fs = failingFsWithSideEffect(base, 'src/b.ts', async () => {
      await base.remove('src/a.ts');
    });
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        { file: 'src/a.ts', content: 'export const a = 1;\n' },
        { file: 'src/b.ts', content: 'export const b = 1;\n' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);

    // The external deletion stands — rollback does not recreate the file.
    await expect(base.stat('src/a.ts')).resolves.toMatchObject({ exists: false });
    const conflicts = readApplyEditsRollbackConflicts(err);
    expect(conflicts).toHaveLength(1);
    expect(conflicts?.[0]?.path).toBe('src/a.ts');
    expect(conflicts?.[0]?.liveSha1).toBeNull();
  });

  it('undisturbed files still roll back to their originals with no conflicts reported', async () => {
    const base = createMemFsAdapter();
    await base.write('src/a.ts', enc('export const a = 0;\n'));

    const fs = failingFsWithSideEffect(base, 'src/b.ts', async () => {});
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        { file: 'src/a.ts', content: 'export const a = 1;\n' },
        { file: 'src/b.ts', content: 'export const b = 1;\n' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(session.state).toBe('snapshotted');

    // Untouched-by-others file restored exactly as before the fix.
    expect(dec(await base.read('src/a.ts'))).toBe('export const a = 0;\n');
    expect(readApplyEditsRollbackConflicts(err)).toBeNull();
  });
});
