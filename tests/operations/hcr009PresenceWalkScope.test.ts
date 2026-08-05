/**
 * tests/operations/hcr009PresenceWalkScope.test.ts — hcr-009 presence-walk
 * scope regression corpus.
 *
 * Defect: the mcr-008 presence capture walked the ENTIRE workspace excluding
 * only gitRepoDir — .git and node_modules were fully walked (stat per entry)
 * on every default-mode createSnapshot and every path landed in the
 * presence_paths JSON column. The sibling audit-coverage walk already prunes
 * exactly these trees; they are also in the default revert allowlist (never
 * deleted) and pruned by audit, so capturing them changes no decision.
 *
 * Fixed semantics under test:
 *   1. WORKSPACE_WALK_EXCLUDES is the shared walk-prune constant
 *      (.git / node_modules / .hoplon) — the seam auditCoverage wires to.
 *   2. presence_paths excludes those trees (and gitRepoDir) while still
 *      recording real workspace files.
 *   3. The walk never descends into the excluded trees (no fs.list on them).
 *   4. Preserved: revert still deletes a genuinely-smuggled top-level file,
 *      never touches allowlisted trees, and the presence primitives still
 *      flag smuggled files for audit discovery.
 *
 * In-memory adapters only (memfs + isomorphic-git + isolated sqlite).
 */

import { describe, it, expect } from 'vitest';

import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { revertUncontracted } from '../../src/hoplon/operations/revertUncontracted.js';
import type { RevertUncontractedDeps } from '../../src/hoplon/operations/revertUncontracted.js';
import {
  WORKSPACE_WALK_EXCLUDES,
  getSnapshotPresence,
  listPostSnapshotPaths,
} from '../../src/hoplon/operations/snapshotPresence.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { CreateSnapshotRequest } from '../../src/hoplon/contracts/requests.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function makeDeps(fsOverride?: HoplonFsAdapter): Promise<{
  snapshotDeps: CreateSnapshotDeps;
  revertDeps: RevertUncontractedDeps;
  fs: HoplonFsAdapter;
  store: SnapshotStore;
}> {
  const fs = fsOverride ?? createMemFsAdapter();
  const store = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = createMemoryEmitter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const gitRepoDir = '/.hoplon/repo';
  const fsRoot = '/';

  const snapshotDeps: CreateSnapshotDeps = {
    fs,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: { gitRepoDir, fsRoot, manifestStorageMode: 'inline' },
  };

  const revertDeps: RevertUncontractedDeps = {
    fs,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    engineId: 'test-engine',
    config: {
      gitRepoDir,
      fsRoot,
      revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**'],
    },
  };

  return { snapshotDeps, revertDeps, fs, store };
}

function makeReq(paths: readonly string[]): CreateSnapshotRequest {
  return {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: paths.map((path) => ({ path, scope: { kind: 'whole_file' as const } })),
    },
  };
}

async function seedWorkspace(fs: HoplonFsAdapter): Promise<void> {
  await fs.write('README.md', enc('# readme\n'));
  await fs.write('src/a.ts', enc('const x = 1;'));
  await fs.write('.git/HEAD', enc('ref: refs/heads/main\n'));
  await fs.write('.git/objects/ab/cdef', enc('blob'));
  await fs.write('node_modules/pkg/index.js', enc('module.exports = 1;\n'));
  await fs.write('node_modules/pkg/package.json', enc('{}'));
  await fs.write('.hoplon/hoplon.db-journal', enc('journal'));
}

describe('hcr-009: WORKSPACE_WALK_EXCLUDES shared seam', () => {
  it('exports exactly the trees the audit-coverage walk prunes', () => {
    expect([...WORKSPACE_WALK_EXCLUDES]).toEqual(['.git', 'node_modules', '.hoplon']);
  });
});

describe('hcr-009: presence capture prunes .git / node_modules / .hoplon', () => {
  it('stores real workspace files but no paths under the excluded trees', async () => {
    const { snapshotDeps, fs, store } = await makeDeps();
    await seedWorkspace(fs);

    const result = await createSnapshot(snapshotDeps, makeReq(['src/a.ts']));
    const record = await store.get(result.snapshotRef.id);
    expect(record).not.toBeNull();
    const presencePaths = record!.presencePaths!;

    expect(presencePaths).toContain('README.md');
    expect(presencePaths).toContain('src/a.ts');
    expect(
      presencePaths.filter(
        (p) =>
          p === '.git' ||
          p.startsWith('.git/') ||
          p === 'node_modules' ||
          p.startsWith('node_modules/') ||
          p === '.hoplon' ||
          p.startsWith('.hoplon/'),
      ),
    ).toEqual([]);
  });

  it('never lists the excluded subtrees during the presence walk', async () => {
    const baseFs = createMemFsAdapter();
    const listedDirs: string[] = [];
    const countingFs: HoplonFsAdapter = {
      read: (path) => baseFs.read(path),
      write: (path, content) => baseFs.write(path, content),
      list: (path) => {
        listedDirs.push(path);
        return baseFs.list(path);
      },
      stat: (path) => baseFs.stat(path),
      mkdir: (path, o) => baseFs.mkdir(path, o),
      remove: (path) => baseFs.remove(path),
    };
    const { snapshotDeps, fs } = await makeDeps(countingFs);
    await seedWorkspace(fs);

    await createSnapshot(snapshotDeps, makeReq(['src/a.ts']));

    const excludedListings = listedDirs.filter(
      (d) =>
        d === '.git' ||
        d.startsWith('.git/') ||
        d === 'node_modules' ||
        d.startsWith('node_modules/'),
    );
    expect(excludedListings).toEqual([]);
  });
});

describe('hcr-009: deletion and audit decisions are unchanged', () => {
  it('revert still deletes a genuinely-smuggled top-level file and keeps allowlisted trees', async () => {
    const { snapshotDeps, revertDeps, fs } = await makeDeps();
    await seedWorkspace(fs);

    const snapshot = await createSnapshot(snapshotDeps, makeReq(['src/a.ts']));

    // Smuggled AFTER the snapshot — must still be removed.
    await fs.write('src/smuggled.ts', enc('export const bad = true;\n'));

    const result = await revertUncontracted(revertDeps, {
      snapshotRefId: snapshot.snapshotRef.id,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
    });

    expect(result.deleted).toContain('src/smuggled.ts');
    expect((await fs.stat('src/smuggled.ts')).exists).toBe(false);

    // Pre-existing evidence-covered files survive.
    expect((await fs.stat('README.md')).exists).toBe(true);
    expect(result.deleted).not.toContain('README.md');

    // Excluded trees are allowlist-protected — never deleted, with or without
    // presence evidence covering them.
    expect((await fs.stat('node_modules/pkg/index.js')).exists).toBe(true);
    expect((await fs.stat('.git/HEAD')).exists).toBe(true);
    expect(result.allowlistSkipped).toContain('node_modules/pkg/index.js');
    expect(result.deleted).not.toContain('node_modules/pkg/index.js');
  });

  it('presence primitives still flag a smuggled file for audit discovery', async () => {
    const { snapshotDeps, fs, store } = await makeDeps();
    await seedWorkspace(fs);

    const snapshot = await createSnapshot(snapshotDeps, makeReq(['src/a.ts']));
    const record = await store.get(snapshot.snapshotRef.id);
    const presence = getSnapshotPresence(record!);

    // The audit-coverage walk (sibling module) prunes the same trees, so the
    // current-paths input never contains them — probe with its shape.
    const discovery = listPostSnapshotPaths(presence, [
      'README.md',
      'src/a.ts',
      'src/smuggled.ts',
    ]);
    expect(discovery).toEqual({
      status: 'known',
      postSnapshotPaths: ['src/smuggled.ts'],
    });
  });
});
