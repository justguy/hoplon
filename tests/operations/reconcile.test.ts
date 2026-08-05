/**
 * tests/operations/reconcile.test.ts — E1 reconcile targeted suite (hcr-001).
 *
 * Crash-reconciliation gap: pending rows historically stored no git ref and
 * the reconciler had no versioning adapter, so every orphan was blanket-failed
 * even when the Phase B commit had succeeded. With the optional versioning
 * seam wired, an orphan whose gitRef verifies against a real commit is
 * COMPLETED to 'committed'. Rows without a ref — and all rows when the seam
 * is not wired by a direct operation caller — are marked failed as before.
 *
 * In-memory adapters only (memfs + isomorphic-git + isolated sqlite).
 */

import { describe, it, expect } from 'vitest';

import { reconcile } from '../../src/hoplon/operations/reconcile.js';
import type { ReconcileDeps } from '../../src/hoplon/operations/reconcile.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { SnapshotRecord, SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';

const GIT_REPO_DIR = '/.hoplon/repo';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Init the snapshot repo and produce one real commit; returns its SHA. */
async function makeCommittedRepo(snapshotId: string): Promise<{
  versioning: VersioningAdapter;
  sha: string;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  await versioning.init(GIT_REPO_DIR);
  await fs.write('.hoplon/repo/src/a.ts', enc('const x = 1;'));
  await versioning.add(GIT_REPO_DIR, ['src/a.ts']);
  const { sha } = await versioning.commit(
    GIT_REPO_DIR,
    `hoplon-snapshot ${snapshotId}`,
    { committer: { timestamp: 0 } },
  );
  return { versioning, sha };
}

/** Put a pending row old enough to be treated as an orphan. */
async function putOrphan(
  store: SnapshotStore,
  opts: { id: string; gitRef: string | null },
): Promise<void> {
  const record: SnapshotRecord = {
    id: opts.id,
    manifestSchemaVersion: 1,
    engineId: 'test-engine',
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    status: 'pending',
    statusReason: null,
    gitRef: opts.gitRef,
    manifest: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ttlExpires: null,
    replicaIds: [],
    presencePaths: null,
  };
  await store.put(record);
}

function makeDeps(
  store: SnapshotStore,
  versioning?: VersioningAdapter,
): ReconcileDeps {
  return {
    snapshotStore: store,
    ...(versioning !== undefined ? { versioning } : {}),
    emitter: createMemoryEmitter(),
    engineId: 'test-engine',
    config: {
      pendingOrphanThresholdMs: 60_000,
      ...(versioning !== undefined ? { gitRepoDir: GIT_REPO_DIR } : {}),
    },
  };
}

describe('reconcile hcr-001: verified git ref completes the orphan', () => {
  it('finalizes a pending row whose gitRef resolves to a real commit', async () => {
    const store = await createIsolatedTestStore();
    const id = 'a'.repeat(64);
    const { versioning, sha } = await makeCommittedRepo(id);
    await putOrphan(store, { id, gitRef: sha });

    const report = await reconcile(makeDeps(store, versioning));

    expect(report.reconciled).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.orphans.pendingRows).toBe(1);

    const row = await store.get(id);
    expect(row?.status).toBe('committed');
    expect(row?.gitRef).toBe(sha);

    // Idempotent: a second run finds nothing left to do.
    const second = await reconcile(makeDeps(store, versioning));
    expect(second.reconciled).toBe(0);
    expect(second.orphans.pendingRows).toBe(0);
  });
});

describe('reconcile hcr-001: unverifiable or absent refs still fail', () => {
  it('marks an orphan failed when its gitRef does not resolve to a commit', async () => {
    const store = await createIsolatedTestStore();
    const id = 'b'.repeat(64);
    const { versioning } = await makeCommittedRepo(id);
    await putOrphan(store, { id, gitRef: 'f'.repeat(40) }); // no such commit

    const report = await reconcile(makeDeps(store, versioning));

    expect(report.reconciled).toBe(1);
    expect(report.failed).toBe(1);
    expect(await store.get(id)).toMatchObject({
      status: 'failed',
      statusReason: 'pending row older than threshold on startup reconcile',
    });
  });

  it("marks an orphan failed when the ref is another snapshot's valid commit", async () => {
    const store = await createIsolatedTestStore();
    const id = '6'.repeat(64);
    const { versioning, sha } = await makeCommittedRepo('5'.repeat(64));
    await putOrphan(store, { id, gitRef: sha });

    const report = await reconcile(makeDeps(store, versioning));

    expect(report.reconciled).toBe(1);
    expect(report.failed).toBe(1);
    expect(await store.get(id)).toMatchObject({
      status: 'failed',
      statusReason: 'pending row older than threshold on startup reconcile',
    });
  });

  it('marks an orphan failed when the pending row carries no gitRef', async () => {
    const store = await createIsolatedTestStore();
    const id = 'c'.repeat(64);
    const { versioning } = await makeCommittedRepo(id);
    await putOrphan(store, { id, gitRef: null });

    const report = await reconcile(makeDeps(store, versioning));

    expect(report.reconciled).toBe(1);
    expect(report.failed).toBe(1);
    expect(await store.get(id)).toMatchObject({
      status: 'failed',
      statusReason: 'pending row older than threshold on startup reconcile',
    });
  });
});

describe('reconcile direct-call compatibility without a versioning seam', () => {
  it('marks every orphan failed when no versioning adapter is wired', async () => {
    const store = await createIsolatedTestStore();
    const withRef = 'd'.repeat(64);
    const withoutRef = 'e'.repeat(64);
    const { sha } = await makeCommittedRepo(withRef);
    await putOrphan(store, { id: withRef, gitRef: sha });
    await putOrphan(store, { id: withoutRef, gitRef: null });

    const report = await reconcile(makeDeps(store));

    expect(report.reconciled).toBe(2);
    expect(report.failed).toBe(2);
    expect((await store.get(withRef))?.status).toBe('failed');
    expect((await store.get(withoutRef))?.status).toBe('failed');
  });
});
