/**
 * tests/operations/hcr009IndexResidue.test.ts — hcr-009 F6b regression corpus.
 *
 * Defect: git.commit commits the INDEX, and git.add persists to .git/index
 * with nothing ever resetting it. The hcr-001 manifest-exact cleanup computes
 * stale paths from HEAD only, so an index entry staged by a PRIOR failed
 * Phase B (add() ran, commit() threw, row marked failed) — a path in neither
 * HEAD nor the current manifest — silently persisted into the next snapshot's
 * committed tree.
 *
 * Fixed semantics under test:
 *   1. Reviewer probe: Z commits src/z.ts; A (src/leak.ts) crashes at commit
 *      after add; B (src/b.ts) commits → B's tree is exactly ['src/b.ts'].
 *   2. Same leak shape on an unborn HEAD (first-ever snapshot crashed at
 *      commit): the next snapshot's tree is still manifest-exact.
 *   3. Preserved: committed history is immutable (Z's ref still reads back)
 *      and same-manifest+same-bytes reuse still short-circuits.
 *
 * In-memory adapters only (memfs + isomorphic-git + isolated sqlite).
 */

import { describe, it, expect } from 'vitest';

import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { CreateSnapshotRequest } from '../../src/hoplon/contracts/requests.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function makeDeps(): Promise<{
  deps: CreateSnapshotDeps;
  fs: HoplonFsAdapter;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const store = await createIsolatedTestStore();
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
    },
  };
  return { deps, fs, store };
}

function makeReq(
  runId: string,
  correlationId: string,
  paths: readonly string[],
): CreateSnapshotRequest {
  return {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId,
      correlationId,
      entries: paths.map((path) => ({ path, scope: { kind: 'whole_file' as const } })),
    },
  };
}

/** Delegating wrapper whose commit() always throws — crash AFTER git.add. */
function withCrashingCommit(base: VersioningAdapter): VersioningAdapter {
  return {
    ...base,
    commit: async () => {
      throw new AdapterError(
        {
          kind: 'git_commit_failed',
          engineId: 'test-engine',
          correlationId: 'corr-crash',
          cause: 'simulated_commit_crash',
        },
        'simulated commit crash after staging',
      );
    },
  };
}

describe('hcr-009 F6b: prior failed Phase B index residue does not leak into the next tree', () => {
  it('reviewer probe: crashed snapshot A (add ran, commit threw) leaks nothing into snapshot B', async () => {
    const { deps, fs, store } = await makeDeps();

    // Snapshot Z commits src/z.ts — HEAD now exists.
    await fs.write('src/z.ts', enc('export const z = 1;\n'));
    const z = await createSnapshot(deps, makeReq('run-z', 'corr-z', ['src/z.ts']));
    const zRecord = await store.get(z.snapshotRef.id);
    expect(zRecord?.status).toBe('committed');

    // Snapshot A (manifest src/leak.ts) fails at commit AFTER git.add — the
    // orphaned index entry for src/leak.ts survives in .git/index.
    await fs.write('src/leak.ts', enc('export const leak = true;\n'));
    await expect(
      createSnapshot(
        { ...deps, versioning: withCrashingCommit(deps.versioning) },
        makeReq('run-a', 'corr-a', ['src/leak.ts']),
      ),
    ).rejects.toThrow('simulated commit crash after staging');
    const aRows = await store.findByProjectAndRun('proj-test', 'run-a');
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.status).toBe('failed');

    // Snapshot B (manifest src/b.ts) commits normally. Before the fix its
    // tree came out ['src/b.ts', 'src/leak.ts'] — src/leak.ts is in neither
    // HEAD nor B's manifest, so the HEAD-based stale-path cleanup missed it.
    await fs.write('src/b.ts', enc('export const b = 1;\n'));
    const b = await createSnapshot(deps, makeReq('run-b', 'corr-b', ['src/b.ts']));
    const bRecord = await store.get(b.snapshotRef.id);
    expect(bRecord?.status).toBe('committed');

    const bFiles = await deps.versioning.listFilesAtRef(
      deps.config.gitRepoDir,
      bRecord!.gitRef!,
    );
    expect(bFiles.map((f) => f.filepath)).toEqual(['src/b.ts']);
  });

  it('same leak shape on an unborn HEAD: first-ever snapshot crashed at commit', async () => {
    const { deps, fs, store } = await makeDeps();

    // First-ever snapshot inits the repo, stages src/leak.ts, crashes at
    // commit — HEAD stays unborn but .git/index keeps the entry.
    await fs.write('src/leak.ts', enc('export const leak = true;\n'));
    await expect(
      createSnapshot(
        { ...deps, versioning: withCrashingCommit(deps.versioning) },
        makeReq('run-a', 'corr-a', ['src/leak.ts']),
      ),
    ).rejects.toThrow('simulated commit crash after staging');

    // Next snapshot re-probes HEAD (still unborn → init path). Its tree must
    // still be manifest-exact.
    await fs.write('src/b.ts', enc('export const b = 1;\n'));
    const b = await createSnapshot(deps, makeReq('run-b', 'corr-b', ['src/b.ts']));
    const bRecord = await store.get(b.snapshotRef.id);
    expect(bRecord?.status).toBe('committed');

    const bFiles = await deps.versioning.listFilesAtRef(
      deps.config.gitRepoDir,
      bRecord!.gitRef!,
    );
    expect(bFiles.map((f) => f.filepath)).toEqual(['src/b.ts']);
  });

  it('preserves committed-history reads and same-manifest+same-bytes reuse', async () => {
    const { deps, fs, store } = await makeDeps();

    await fs.write('src/z.ts', enc('export const z = 1;\n'));
    const z = await createSnapshot(deps, makeReq('run-z', 'corr-z', ['src/z.ts']));

    await fs.write('src/leak.ts', enc('export const leak = true;\n'));
    await expect(
      createSnapshot(
        { ...deps, versioning: withCrashingCommit(deps.versioning) },
        makeReq('run-a', 'corr-a', ['src/leak.ts']),
      ),
    ).rejects.toThrow(AdapterError);

    await fs.write('src/b.ts', enc('export const b = 1;\n'));
    await createSnapshot(deps, makeReq('run-b', 'corr-b', ['src/b.ts']));

    // Cross-snapshot revert reads old refs: Z's commit is immutable.
    const zRecord = await store.get(z.snapshotRef.id);
    const zFiles = await deps.versioning.listFilesAtRef(
      deps.config.gitRepoDir,
      zRecord!.gitRef!,
    );
    expect(zFiles.map((f) => f.filepath)).toEqual(['src/z.ts']);
    const zBytes = await deps.versioning.readBlob(
      deps.config.gitRepoDir,
      zRecord!.gitRef!,
      'src/z.ts',
    );
    expect(dec(zBytes)).toBe('export const z = 1;\n');

    // Same manifest + same bytes still short-circuits to the committed row.
    const zAgain = await createSnapshot(deps, makeReq('run-z', 'corr-z', ['src/z.ts']));
    expect(zAgain.snapshotRef.id).toBe(z.snapshotRef.id);
    expect(await store.findByProjectAndRun('proj-test', 'run-z')).toHaveLength(1);
  });
});
