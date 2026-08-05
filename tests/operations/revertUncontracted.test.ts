/**
 * tests/operations/revertUncontracted.test.ts — D2 revertUncontracted targeted test suite.
 *
 * Uses in-memory adapters only (no disk, no live git binary, no LLM):
 *   - createMemFsAdapter()             (C2)
 *   - createIsomorphicGitVersioning()  (C4)
 *   - createIsolatedTestStore()        (C1)
 *   - createAsyncMutexLockProvider()   (C3)
 *   - createMemoryEmitter()            (C5)
 *
 * 20 required tests per D2 spec.
 *
 * Test naming convention: D2-T<N>: <description>
 *
 * RS-1 decision matrix tests (T1–T5) are the critical block.
 * AS-2 verification tests (T6–T10) prove cross-project/cross-run rejection.
 */

import { describe, it, expect, vi } from 'vitest';

import { revertUncontracted } from '../../src/hoplon/operations/revertUncontracted.js';
import type { RevertUncontractedDeps } from '../../src/hoplon/operations/revertUncontracted.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { ValidationError, SemanticError } from '../../src/hoplon/contracts/errors.js';
import type { SnapshotStore, SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { RevertRequest } from '../../src/hoplon/contracts/requests.js';
import type { LockProvider } from '../../src/hoplon/adapters/lock.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/**
 * Build a fresh revertUncontracted deps, sharing the fs and versioning
 * adapters with createSnapshot deps so both operate on the same memfs volume.
 */
async function makeDeps(opts?: {
  gitRepoDir?: string;
  fsRoot?: string;
  revertAllowlist?: string[];
  snapshotStore?: SnapshotStore;
  lockProvider?: LockProvider;
  fs?: HoplonFsAdapter;
}): Promise<{
  revertDeps: RevertUncontractedDeps;
  snapshotDeps: CreateSnapshotDeps;
  fsAdapter: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
}> {
  const fsAdapter = opts?.fs ?? createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());
  const lockProvider = opts?.lockProvider ?? createAsyncMutexLockProvider();
  const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });

  const gitRepoDir = opts?.gitRepoDir ?? '/.hoplon/repo';
  const fsRoot = opts?.fsRoot ?? '/';
  const revertAllowlist = opts?.revertAllowlist ?? ['.git/**', 'node_modules/**', '.hoplon/**'];

  const revertDeps: RevertUncontractedDeps = {
    fs: fsAdapter,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    engineId: 'test-engine',
    config: { gitRepoDir, fsRoot, revertAllowlist },
  };

  const snapshotDeps: CreateSnapshotDeps = {
    fs: fsAdapter,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: {
      gitRepoDir,
      fsRoot,
      manifestStorageMode: 'inline',
    },
  };

  return { revertDeps, snapshotDeps, fsAdapter, emitter, store };
}

/** Create a snapshot and return its id. Requires file to be pre-seeded. */
async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  opts: {
    projectId?: string;
    runId?: string;
    correlationId?: string;
    entries: Array<{ path: string }>;
  },
): Promise<string> {
  const result = await createSnapshot(snapshotDeps, {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: opts.projectId ?? 'proj-test',
      runId: opts.runId ?? 'run-001',
      correlationId: opts.correlationId ?? 'corr-001',
      entries: opts.entries.map((e) => ({ path: e.path, scope: { kind: 'whole_file' as const } })),
    },
  });
  return result.snapshotRef.id;
}

/** Build a minimal valid RevertRequest. */
function makeRevertReq(
  snapshotRefId: string,
  overrides?: Partial<RevertRequest>,
): RevertRequest {
  return {
    snapshotRefId,
    projectId: overrides?.projectId ?? 'proj-test',
    runId: overrides?.runId ?? 'run-001',
    correlationId: overrides?.correlationId ?? 'corr-001',
  };
}

// ---------------------------------------------------------------------------
// RS-1 DECISION MATRIX TESTS (T1–T5) — The critical block
// ---------------------------------------------------------------------------

describe('D2-T1: RS-1 — modified manifest file is restored to snapshot state', () => {
  it('reverts a manifest file to its snapshotted content', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    // Seed original content and snapshot
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Modify the file after snapshot
    await fsAdapter.write('src/a.ts', enc('const x = 999;'));

    // Verify modification was applied
    const modified = dec(await fsAdapter.read('src/a.ts'));
    expect(modified).toBe('const x = 999;');

    // Revert
    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // File should be restored to snapshot state
    const restored = dec(await fsAdapter.read('src/a.ts'));
    expect(restored).toBe('const x = 1;');

    // Result classification
    expect(result.reverted).toContain('src/a.ts');
    expect(result.deleted).not.toContain('src/a.ts');
    expect(result.allowlistSkipped).not.toContain('src/a.ts');
  });
});

describe('D2-T2: RS-1 — uncontracted post-snapshot file (not in allowlist) is deleted', () => {
  it('deletes a file created after the snapshot that is not in the manifest', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    // Seed manifest file and snapshot
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Create a new file AFTER the snapshot (not in manifest)
    await fsAdapter.write('src/new-file.ts', enc('const y = 99;'));

    // Verify it exists
    const before = await fsAdapter.stat('src/new-file.ts');
    expect(before.exists).toBe(true);

    // Revert
    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // The new file should be deleted (uncontracted post-snapshot creation)
    const after = await fsAdapter.stat('src/new-file.ts');
    expect(after.exists).toBe(false);

    expect(result.deleted).toContain('src/new-file.ts');
    expect(result.reverted).not.toContain('src/new-file.ts');
    expect(result.allowlistSkipped).not.toContain('src/new-file.ts');
  });
});

describe('D2-T3: RS-1 — allowlist file created post-snapshot is untouched', () => {
  it('preserves .git/HEAD, node_modules/foo, .hoplon/internal created after snapshot', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    // Seed manifest file and snapshot
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Create files matching the default allowlist AFTER snapshot
    await fsAdapter.write('.git/HEAD', enc('ref: refs/heads/main'));
    await fsAdapter.write('node_modules/foo/index.js', enc('module.exports = {}'));
    await fsAdapter.write('.hoplon/internal', enc('internal state'));

    // Revert
    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // All allowlist files should be untouched
    const gitHead = await fsAdapter.stat('.git/HEAD');
    expect(gitHead.exists).toBe(true);
    expect(dec(await fsAdapter.read('.git/HEAD'))).toBe('ref: refs/heads/main');

    const nmFoo = await fsAdapter.stat('node_modules/foo/index.js');
    expect(nmFoo.exists).toBe(true);

    const hoplonInternal = await fsAdapter.stat('.hoplon/internal');
    expect(hoplonInternal.exists).toBe(true);

    // Verify result classification
    expect(result.allowlistSkipped).toContain('.git/HEAD');
    expect(result.allowlistSkipped).toContain('node_modules/foo/index.js');
    expect(result.allowlistSkipped).toContain('.hoplon/internal');
    expect(result.deleted).not.toContain('.git/HEAD');
    expect(result.deleted).not.toContain('node_modules/foo/index.js');
    expect(result.deleted).not.toContain('.hoplon/internal');
    expect(result.reverted).not.toContain('.git/HEAD');
  });
});

describe('D2-T4: RS-1 — modified file outside manifest but present at snapshot is untouched', () => {
  it('leaves files that existed at snapshot time (tracked in gitRepoDir) but are not in the manifest', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    // Pre-initialize gitRepoDir and commit src/other.ts there so it's part of the
    // initial repo state (committed before the Hoplon snapshot). Then take the
    // D1 snapshot with only src/a.ts in the manifest.
    //
    // When git commits src/a.ts in D1, the gitRepoDir HEAD commit still contains
    // src/other.ts (git snapshots the full tree; it persists from the prior commit).
    // statusMatrix in D2 will show head=1 for src/other.ts → it's in snapshotPaths
    // → D2 leaves it untouched (out of manifest scope, present at snapshot time).
    const versioning = snapshotDeps.versioning;
    const gitRepoDir = revertDeps.config.gitRepoDir;

    // Step 1: Init gitRepoDir and commit src/other.ts as initial state
    await versioning.init(gitRepoDir);
    const gitRepoDirRelative = gitRepoDir.startsWith('/') ? gitRepoDir.slice(1) : gitRepoDir;
    await fsAdapter.write(`${gitRepoDirRelative}/src/other.ts`, enc('const z = 0;'));
    await versioning.add(gitRepoDir, ['src/other.ts']);
    await versioning.commit(gitRepoDir, 'initial: add src/other.ts');

    // Step 2: Seed src/a.ts in fsRoot and take D1 snapshot (manifest: src/a.ts only)
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    // Also write src/other.ts to fsRoot (it exists in the project at snapshot time)
    await fsAdapter.write('src/other.ts', enc('const z = 0;'));

    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Step 3: Modify src/other.ts AFTER snapshot (it was in the snapshot tree but NOT in manifest)
    await fsAdapter.write('src/other.ts', enc('const z = 999;'));

    // Step 4: Revert
    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // src/other.ts should NOT be reverted and NOT be deleted (it existed at snapshot time)
    const otherContent = dec(await fsAdapter.read('src/other.ts'));
    expect(otherContent).toBe('const z = 999;'); // still modified — not touched

    // src/a.ts should be reverted (in manifest)
    const aContent = dec(await fsAdapter.read('src/a.ts'));
    expect(aContent).toBe('const x = 1;');

    expect(result.reverted).toContain('src/a.ts');
    expect(result.reverted).not.toContain('src/other.ts');
    expect(result.deleted).not.toContain('src/other.ts');
    expect(result.allowlistSkipped).not.toContain('src/other.ts');
  });
});

describe('D2-T5: RS-1 — allowlist file present at snapshot, modified: untouched (allowlist precedence)', () => {
  it('preserves .git/HEAD that was present at snapshot time even if modified', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    // Seed manifest file AND .git/HEAD (simulating pre-existing git dir)
    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    await fsAdapter.write('.git/HEAD', enc('ref: refs/heads/main'));

    // Snapshot only includes src/a.ts
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Modify .git/HEAD after snapshot
    await fsAdapter.write('.git/HEAD', enc('ref: refs/heads/feature'));

    // Revert
    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // .git/HEAD should NOT be modified (allowlist takes precedence)
    const gitHeadContent = dec(await fsAdapter.read('.git/HEAD'));
    expect(gitHeadContent).toBe('ref: refs/heads/feature'); // still modified

    // .git/HEAD may appear in allowlistSkipped if it was a candidate
    // (it existed at snapshot time but is also in allowlist → allowlist wins)
    expect(result.deleted).not.toContain('.git/HEAD');
    expect(result.reverted).not.toContain('.git/HEAD');
  });
});

describe('D2-T5b: RS-1 — contracted file absent at snapshot is restored as absence', () => {
  it('removes a manifest-scoped file that was created only after the snapshot', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/missing.ts' }],
    });
    emitter.clear();

    await fsAdapter.write('src/missing.ts', enc('export const late = true;\n'));
    const before = await fsAdapter.stat('src/missing.ts');
    expect(before.exists).toBe(true);

    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    const after = await fsAdapter.stat('src/missing.ts');
    expect(after.exists).toBe(false);
    expect(result.reverted).toContain('src/missing.ts');
    expect(result.deleted).not.toContain('src/missing.ts');
    expect(result.allowlistSkipped).not.toContain('src/missing.ts');
  });
});

// ---------------------------------------------------------------------------
// AS-2 VERIFICATION TESTS (T6–T10)
// ---------------------------------------------------------------------------

describe('D2-T6: AS-2 — bogus snapshot id → SemanticError snapshot_missing', () => {
  it('throws SemanticError({ kind: snapshot_missing }) for unknown snapshotRefId', async () => {
    const { revertDeps } = await makeDeps();

    const req = makeRevertReq('aaaa' + 'b'.repeat(60)); // valid-length but unknown id
    await expect(revertUncontracted(revertDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof SemanticError && e.kind === 'snapshot_missing',
    );
  });
});

describe('D2-T7: AS-2 — snapshot from project A used under project B → project_id_mismatch, no fs ops', () => {
  it('rejects cross-project replay and makes no filesystem calls', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      projectId: 'project-A',
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Track write calls to verify no fs mutations happen
    const writeSpy = vi.fn();
    const removeSpy = vi.fn();
    const spiedFs: HoplonFsAdapter = {
      ...fsAdapter,
      write: async (...args) => { writeSpy(...args); return fsAdapter.write(...args); },
      remove: async (...args) => { removeSpy(...args); return fsAdapter.remove(...args); },
    };
    const spiedDeps = { ...revertDeps, fs: spiedFs };

    const req = makeRevertReq(snapshotId, { projectId: 'project-B' });
    await expect(revertUncontracted(spiedDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof SemanticError && e.kind === 'project_id_mismatch',
    );

    // No write or remove should have been called
    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('D2-T8: AS-2 — snapshot from run X used under run Y → run_id_mismatch, no fs ops', () => {
  it('rejects cross-run replay and makes no filesystem calls', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      runId: 'run-X',
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    const writeSpy = vi.fn();
    const removeSpy = vi.fn();
    const spiedFs: HoplonFsAdapter = {
      ...fsAdapter,
      write: async (...args) => { writeSpy(...args); return fsAdapter.write(...args); },
      remove: async (...args) => { removeSpy(...args); return fsAdapter.remove(...args); },
    };
    const spiedDeps = { ...revertDeps, fs: spiedFs };

    const req = makeRevertReq(snapshotId, { runId: 'run-Y' });
    await expect(revertUncontracted(spiedDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof SemanticError && e.kind === 'run_id_mismatch',
    );

    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('D2-T9: AS-2 — snapshot with status "pending" → snapshot_not_committed, no fs ops', () => {
  it('rejects pending snapshot and makes no filesystem calls', async () => {
    const store = await createIsolatedTestStore();

    // Manually insert a pending snapshot record
    const pendingRecord: SnapshotRecord = {
      id: 'a'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
      },
      createdAt: new Date().toISOString(),
      ttlExpires: null,
      replicaIds: [],
    };
    await store.put(pendingRecord);

    const { revertDeps, fsAdapter } = await makeDeps({ snapshotStore: store });

    const writeSpy = vi.fn();
    const removeSpy = vi.fn();
    const spiedFs: HoplonFsAdapter = {
      ...fsAdapter,
      write: async (...args) => { writeSpy(...args); return fsAdapter.write(...args); },
      remove: async (...args) => { removeSpy(...args); return fsAdapter.remove(...args); },
    };
    const spiedDeps = { ...revertDeps, fs: spiedFs };

    const req = makeRevertReq('a'.repeat(64));
    await expect(revertUncontracted(spiedDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof SemanticError && e.kind === 'snapshot_not_committed',
    );

    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('D2-T10: AS-2 — snapshot with status "failed" → snapshot_not_committed, no fs ops', () => {
  it('rejects failed snapshot and makes no filesystem calls', async () => {
    const store = await createIsolatedTestStore();

    const failedRecord: SnapshotRecord = {
      id: 'b'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      status: 'pending', // must be pending first for store.put
      statusReason: null,
      gitRef: null,
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
      },
      createdAt: new Date().toISOString(),
      ttlExpires: null,
      replicaIds: [],
    };
    await store.put(failedRecord);
    await store.updateStatus('b'.repeat(64), 'failed', 'simulated failure');

    const { revertDeps, fsAdapter } = await makeDeps({ snapshotStore: store });

    const writeSpy = vi.fn();
    const removeSpy = vi.fn();
    const spiedFs: HoplonFsAdapter = {
      ...fsAdapter,
      write: async (...args) => { writeSpy(...args); return fsAdapter.write(...args); },
      remove: async (...args) => { removeSpy(...args); return fsAdapter.remove(...args); },
    };
    const spiedDeps = { ...revertDeps, fs: spiedFs };

    const req = makeRevertReq('b'.repeat(64));
    await expect(revertUncontracted(spiedDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof SemanticError && e.kind === 'snapshot_not_committed',
    );

    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VALIDATION TESTS (T11–T13)
// ---------------------------------------------------------------------------

// T11: Path traversal in request — not applicable (RevertRequest has no paths field). Skip.

describe('D2-T12: Validation — invalid correlationId → ValidationError', () => {
  it('throws ValidationError({ kind: invalid_correlation_id }) for empty correlationId', async () => {
    const { revertDeps } = await makeDeps();

    const req: RevertRequest = {
      snapshotRefId: 'a'.repeat(64),
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: '   ', // whitespace-only
    };
    await expect(revertUncontracted(revertDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof ValidationError && e.kind === 'invalid_correlation_id',
    );
  });
});

describe('D2-T13: Validation — invalid runId → ValidationError', () => {
  it('throws ValidationError({ kind: invalid_run_id }) for empty runId', async () => {
    const { revertDeps } = await makeDeps();

    const req: RevertRequest = {
      snapshotRefId: 'a'.repeat(64),
      projectId: 'proj-test',
      runId: '   ', // whitespace-only
      correlationId: 'corr-001',
    };
    await expect(revertUncontracted(revertDeps, req)).rejects.toSatisfy(
      (e: unknown) => e instanceof ValidationError && e.kind === 'invalid_run_id',
    );
  });
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY (T14)
// ---------------------------------------------------------------------------

describe('D2-T14: Documented NOT IDEMPOTENT — TSDoc contains "NOT IDEMPOTENT"', () => {
  it('revertUncontracted source file contains the NOT IDEMPOTENT marker', async () => {
    // Read the source file directly to verify the contract is documented in code.
    // This is a meta-test that the architectural requirement (D2 is NOT idempotent)
    // is explicitly marked in the code, making it discoverable to future maintainers.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/hoplon/operations/revertUncontracted.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('NOT IDEMPOTENT');
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY (T15)
// ---------------------------------------------------------------------------

describe('D2-T15: Concurrency — concurrent reverts on same project are serialized', () => {
  it('two concurrent reverts do not interleave (lock serializes them)', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('original'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Modify so there's something to revert
    await fsAdapter.write('src/a.ts', enc('modified'));

    // Both reverts target the same project — lock serializes them.
    // The first to run will restore src/a.ts; the second will also succeed
    // (file was already restored). We only verify no exception + no torn state.
    const [r1, r2] = await Promise.all([
      revertUncontracted(revertDeps, makeRevertReq(snapshotId)),
      revertUncontracted(revertDeps, makeRevertReq(snapshotId)),
    ]);

    // Both results should be valid RevertResult shapes
    expect(Array.isArray(r1.reverted)).toBe(true);
    expect(Array.isArray(r1.deleted)).toBe(true);
    expect(Array.isArray(r1.allowlistSkipped)).toBe(true);
    expect(Array.isArray(r2.reverted)).toBe(true);

    // File should be in its snapshotted state
    const content = dec(await fsAdapter.read('src/a.ts'));
    expect(content).toBe('original');
  });
});

// ---------------------------------------------------------------------------
// OBSERVABILITY (T16–T17)
// ---------------------------------------------------------------------------

describe('D2-T16: Observability — emitter receives start + end events with correct shape', () => {
  it('emits a start event and an end event with op=revertUncontracted', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear(); // clear snapshot events

    await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    const events = emitter.getEvents();
    const revertEvents = events.filter((e) => e.op === 'revertUncontracted');

    expect(revertEvents).toHaveLength(2);

    const startEvent = revertEvents.find((e) => e.phase === 'start');
    const endEvent = revertEvents.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();

    expect(startEvent!.engineId).toBe('test-engine');
    expect(startEvent!.projectId).toBe('proj-test');
    expect(startEvent!.runId).toBe('run-001');
    expect(startEvent!.correlationId).toBe('corr-001');

    expect(endEvent!.classification).toBe('PASS');
    expect(typeof endEvent!.durationMs).toBe('number');
    expect(endEvent!.durationMs!).toBeGreaterThanOrEqual(0);
  });
});

describe('D2-T17: Observability — no content in events (H13)', () => {
  it('assertEventIsContentFree passes for all emitted revert events', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    const events = emitter.getEvents();
    const revertEvents = events.filter((e) => e.op === 'revertUncontracted');

    for (const event of revertEvents) {
      // Throws if any event contains content (H13 violation)
      assertEventIsContentFree(event);
    }
  });
});

// ---------------------------------------------------------------------------
// ABORTSIGNAL (T18)
// ---------------------------------------------------------------------------

describe('D2-T18: AbortSignal — pre-aborted signal rejects without doing any work', () => {
  it('throws AbortError immediately when signal is already aborted', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps();
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Modify file so we can verify it was NOT restored
    await fsAdapter.write('src/a.ts', enc('modified'));

    const controller = new AbortController();
    controller.abort();

    await expect(
      revertUncontracted(revertDeps, makeRevertReq(snapshotId), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // File should NOT have been restored (operation was aborted before any work)
    const content = dec(await fsAdapter.read('src/a.ts'));
    expect(content).toBe('modified');

    // No events should have been emitted (aborted before emit)
    const events = emitter.getEvents().filter((e) => e.op === 'revertUncontracted');
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ALLOWLIST EDGE CASES (T19–T20)
// ---------------------------------------------------------------------------

describe('D2-T19: Allowlist — custom allowlist replaces the default (not extends)', () => {
  it('protects only custom/** paths; default .git/** is NOT protected', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps({
      revertAllowlist: ['custom/**'], // completely replaces the default
    });
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('original'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Create files after snapshot:
    // - custom/protected.ts: should be in allowlistSkipped (matches 'custom/**')
    // - .git/HEAD: should be DELETED (default allowlist not active)
    await fsAdapter.write('custom/protected.ts', enc('protected'));
    await fsAdapter.write('.git/HEAD', enc('ref: refs/heads/main'));

    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // custom/protected.ts should be skipped (allowlist match)
    expect(result.allowlistSkipped).toContain('custom/protected.ts');

    // .git/HEAD should be DELETED (not protected by custom allowlist)
    const gitStat = await fsAdapter.stat('.git/HEAD');
    expect(gitStat.exists).toBe(false);
    expect(result.deleted).toContain('.git/HEAD');
  });
});

describe('D2-T20: Allowlist — empty allowlist; even .git/HEAD is deleted', () => {
  it('deletes .git/HEAD when allowlist is empty', async () => {
    const { revertDeps, snapshotDeps, fsAdapter, emitter } = await makeDeps({
      revertAllowlist: [], // empty — no protection
    });
    emitter.clear();

    await fsAdapter.write('src/a.ts', enc('const x = 1;'));
    const snapshotId = await takeSnapshot(snapshotDeps, {
      entries: [{ path: 'src/a.ts' }],
    });
    emitter.clear();

    // Create .git/HEAD after snapshot — with empty allowlist it's a candidate for deletion
    await fsAdapter.write('.git/HEAD', enc('ref: refs/heads/main'));

    const result = await revertUncontracted(revertDeps, makeRevertReq(snapshotId));

    // .git/HEAD should be deleted (empty allowlist provides no protection)
    const gitStat = await fsAdapter.stat('.git/HEAD');
    expect(gitStat.exists).toBe(false);

    expect(result.deleted).toContain('.git/HEAD');
    expect(result.allowlistSkipped).not.toContain('.git/HEAD');

    // This proves the allowlist is what protects .git/HEAD in the default config
  });
});
