/**
 * tests/operations/mcr008RevertPresence.test.ts — mcr-008 regression corpus.
 *
 * p0 destructive-revert finding: snapshots contain only manifest files, and
 * revert's "was this file present at snapshot time" probe ran against that
 * commit — so every pre-existing non-manifest, non-allowlisted file probed as
 * a post-snapshot creation and was DELETED (reproduced upstream with a
 * pre-existing README.md).
 *
 * Fixed semantics under test:
 *   1. Pre-existing workspace files (presence evidence says 'present')
 *      survive revert untouched.
 *   2. Genuine post-snapshot smuggled files are still deleted.
 *   3. Fail-safe: when a snapshot carries no presence evidence (created
 *      before mcr-008), revert deletes NOTHING and reports every deletion
 *      candidate under `presenceUnknownSkipped`.
 *
 * In-memory adapters only (memfs + isomorphic-git + isolated sqlite).
 */

import { describe, it, expect } from 'vitest';

import { revertUncontracted } from '../../src/hoplon/operations/revertUncontracted.js';
import type { RevertUncontractedDeps } from '../../src/hoplon/operations/revertUncontracted.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { SnapshotStore, SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { RevertRequest } from '../../src/hoplon/contracts/requests.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function makeDeps(): Promise<{
  revertDeps: RevertUncontractedDeps;
  snapshotDeps: CreateSnapshotDeps;
  fsAdapter: ReturnType<typeof createMemFsAdapter>;
  store: SnapshotStore;
}> {
  const fsAdapter = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
  const gitRepoDir = '/.hoplon/repo';
  const fsRoot = '/';

  const revertDeps: RevertUncontractedDeps = {
    fs: fsAdapter,
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

  const snapshotDeps: CreateSnapshotDeps = {
    fs: fsAdapter,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: { gitRepoDir, fsRoot, manifestStorageMode: 'inline' },
  };

  return { revertDeps, snapshotDeps, fsAdapter, store };
}

async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  entries: readonly string[],
): Promise<string> {
  const result = await createSnapshot(snapshotDeps, {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: entries.map((path) => ({ path, scope: { kind: 'whole_file' as const } })),
    },
  });
  return result.snapshotRef.id;
}

function makeRevertReq(snapshotRefId: string): RevertRequest {
  return {
    snapshotRefId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
  };
}

/** Full-delegation store wrapper that transforms records returned by get(). */
function storeWithRecord(
  base: SnapshotStore,
  transform: (record: SnapshotRecord) => SnapshotRecord,
): SnapshotStore {
  const wrapped: SnapshotStore = {
    put: (record) => base.put(record),
    get: async (id) => {
      const record = await base.get(id);
      return record === null ? null : transform(record);
    },
    findByProjectAndRun: (projectId, runId) => base.findByProjectAndRun(projectId, runId),
    updateStatus: (id, status, reason, gitRef) => base.updateStatus(id, status, reason, gitRef),
    listPending: (olderThanMs) => base.listPending(olderThanMs),
    gc: (opts) => base.gc(opts),
    appendAuditLog: (record) => base.appendAuditLog(record),
    findAuditLogByProjectAndRun: (projectId, runId) =>
      base.findAuditLogByProjectAndRun(projectId, runId),
    gcAuditLog: (opts) => base.gcAuditLog(opts),
    findPolicyAuditEntries: (request) => base.findPolicyAuditEntries(request),
    verifyAuditLogIntegrity: (request) => base.verifyAuditLogIntegrity(request),
  };
  if (base.recordPendingGitRef) {
    wrapped.recordPendingGitRef = (id, gitRef) => base.recordPendingGitRef!(id, gitRef);
  }
  return wrapped;
}

describe('mcr-008 T1: pre-existing uncontracted file survives revert', () => {
  it('does not delete a README.md that existed before the snapshot', async () => {
    const { revertDeps, snapshotDeps, fsAdapter } = await makeDeps();

    // Pre-existing repository files, present BEFORE the snapshot.
    await fsAdapter.write('README.md', enc('# pre-existing readme\n'));
    await fsAdapter.write('docs/guide.md', enc('pre-existing guide\n'));
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));

    const snapshotId = await takeSnapshot(snapshotDeps, ['src/a.ts']);

    // Post-snapshot edit inside the contracted scope, so revert has work to do.
    await fsAdapter.write('src/a.ts', enc('const x = 999;'));

    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // The reviewer's exact reproduction: README.md must survive.
    expect((await fsAdapter.stat('README.md')).exists).toBe(true);
    expect(dec(await fsAdapter.read('README.md'))).toBe('# pre-existing readme\n');
    expect((await fsAdapter.stat('docs/guide.md')).exists).toBe(true);

    expect(result.deleted).not.toContain('README.md');
    expect(result.deleted).not.toContain('docs/guide.md');
    expect(result.reverted).toContain('src/a.ts');
    expect(dec(await fsAdapter.read('src/a.ts'))).toBe('const x = 1;');
  });
});

describe('mcr-008 T2: genuine post-snapshot smuggled file is still deleted', () => {
  it('deletes only the post-snapshot creation, never the pre-existing sibling', async () => {
    const { revertDeps, snapshotDeps, fsAdapter } = await makeDeps();

    await fsAdapter.write('README.md', enc('# keep me\n'));
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, ['src/a.ts']);

    // Smuggled AFTER the snapshot — must still be removed.
    await fsAdapter.write('src/smuggled.ts', enc('export const bad = true;\n'));

    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    expect((await fsAdapter.stat('src/smuggled.ts')).exists).toBe(false);
    expect(result.deleted).toContain('src/smuggled.ts');
    expect((await fsAdapter.stat('README.md')).exists).toBe(true);
    expect(result.deleted).not.toContain('README.md');
  });
});

describe('mcr-008 T3: missing presence evidence → fail-safe, no deletions', () => {
  it('skips and reports every deletion candidate when the snapshot has no evidence', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, store } = await makeDeps();

    await fsAdapter.write('README.md', enc('# pre-existing readme\n'));
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, ['src/a.ts']);

    // Post-snapshot file. With evidence it would be deleted — but this test
    // simulates a snapshot created before mcr-008 (no presence evidence), so
    // presence is unknowable and deletion must not happen.
    await fsAdapter.write('src/smuggled.ts', enc('export const bad = true;\n'));
    await fsAdapter.write('src/a.ts', enc('const x = 999;'));

    const legacyDeps: RevertUncontractedDeps = {
      ...revertDeps,
      snapshotStore: storeWithRecord(store, (record) => ({
        ...record,
        presencePaths: null,
      })),
    };

    const result = await revertUncontracted(legacyDeps, makeRevertReq(snapshotId));

    // Deletion is the dangerous direction — nothing may be deleted.
    expect(result.deleted).toEqual([]);
    expect((await fsAdapter.stat('README.md')).exists).toBe(true);
    expect((await fsAdapter.stat('src/smuggled.ts')).exists).toBe(true);

    // Every unknown-presence candidate is reported as skipped.
    expect(result.presenceUnknownSkipped).toContain('README.md');
    expect(result.presenceUnknownSkipped).toContain('src/smuggled.ts');

    // Manifest restore still works — contracted scope is unaffected.
    expect(result.reverted).toContain('src/a.ts');
    expect(dec(await fsAdapter.read('src/a.ts'))).toBe('const x = 1;');
  });
});

describe('mcr-008 T4: presence evidence is persisted on the snapshot record', () => {
  it('stores the paths-only workspace listing (gitRepoDir excluded) on the row', async () => {
    const { snapshotDeps, fsAdapter, store } = await makeDeps();

    await fsAdapter.write('README.md', enc('# readme\n'));
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const firstId = await takeSnapshot(snapshotDeps, ['src/a.ts']);

    const firstRecord = await store.get(firstId);
    expect(firstRecord).not.toBeNull();
    expect(firstRecord!.presencePaths).toContain('README.md');
    expect(firstRecord!.presencePaths).toContain('src/a.ts');

    // Second snapshot: the gitRepoDir now exists on the volume from the first
    // commit — it is Hoplon-internal state and must be excluded from evidence.
    await fsAdapter.write('src/a.ts', enc('const x = 2;'));
    const secondId = await takeSnapshot(snapshotDeps, ['src/a.ts']);
    expect(secondId).not.toBe(firstId);

    const secondRecord = await store.get(secondId);
    expect(secondRecord).not.toBeNull();
    expect(secondRecord!.presencePaths).toContain('README.md');
    expect(
      secondRecord!.presencePaths!.filter((p) => p.startsWith('.hoplon/repo/')),
    ).toEqual([]);
  });
});
