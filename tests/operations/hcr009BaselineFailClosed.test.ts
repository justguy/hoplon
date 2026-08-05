/**
 * tests/operations/hcr009BaselineFailClosed.test.ts — hcr-009 regression suite.
 *
 * symbolScopeGate.loadBaselineContent must disambiguate the two isomorphic-git
 * NotFoundError conditions instead of degrading both to an empty baseline:
 *
 *   (a) File absent at a RESOLVABLE snapshot commit → legitimately a new file
 *       → empty baseline (every audited symbol evaluates as added). No error.
 *   (b) The snapshot commit itself is UNRESOLVABLE (repo/store desync: git gc,
 *       wiped repo dir, gitRepoDir misconfig) → the whole baseline is unknown
 *       → typed adapter failure (fail CLOSED). Previously this degraded to an
 *       empty baseline, silently disabling deletion detection: deleting a
 *       pre-existing out-of-scope symbol PASSed under desync.
 *
 * dryRun must remain strictly side-effect-free on the fail-closed path.
 *
 * Harness mirrors tests/operations/symbolScopeGate.regression.test.ts:
 * memfs + real isomorphic-git + real tree-sitter WASM grammars + in-memory
 * SQLite snapshot store.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { dryRun } from '../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../src/hoplon/operations/dryRun.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { loadBaselineContent } from '../../src/hoplon/operations/symbolScopeGate.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const GIT_REPO_DIR = '/.hoplon/repo';
const FS_ROOT = '/';

/** A syntactically plausible commit SHA that exists in no repository. */
const UNKNOWN_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface Harness {
  auditDiffDeps: AuditDiffDeps;
  dryRunDeps: DryRunDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  store: SnapshotStore;
}

async function makeDeps(store?: SnapshotStore): Promise<Harness> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const resolvedStore = store ?? (await createIsolatedTestStore());

  const opConfig = {
    fsRoot: FS_ROOT,
    gitRepoDir: GIT_REPO_DIR,
    maxFileBytes: 1024 * 1024,
    parseTimeoutMs: 5000,
    manifestSchemaVersion: 1,
  } as const;

  return {
    auditDiffDeps: {
      fs,
      versioning,
      snapshotStore: resolvedStore,
      codeIntelligence: sharedCI,
      emitter,
      engineId: 'test-engine',
      config: { ...opConfig },
    },
    dryRunDeps: {
      fs,
      versioning,
      snapshotStore: resolvedStore,
      codeIntelligence: sharedCI,
      emitter,
      engineId: 'test-engine',
      config: { ...opConfig },
    },
    snapshotDeps: {
      fs,
      versioning,
      snapshotStore: resolvedStore,
      lockProvider: createAsyncMutexLockProvider(),
      emitter,
      secretScanner: createBuiltinRegexScanner(),
      engineId: 'test-engine',
      config: {
        gitRepoDir: GIT_REPO_DIR,
        fsRoot: FS_ROOT,
        manifestStorageMode: 'inline',
      },
    },
    fs,
    versioning,
    store: resolvedStore,
  };
}

function makeManifest(
  entries: WritableManifest['entries'],
): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-seed',
    entries,
  };
}

const BASELINE = 'function foo() { return 1; }\nfunction bar() { return 2; }\n';
const DELETED_BAR = 'function foo() { return 1; }\n';

/** Seed harness A: baseline file + committed snapshot with scope ['foo']. */
async function seedSnapshot(h: Harness): Promise<string> {
  await h.fs.write('src/a.js', enc(BASELINE));
  const manifest = makeManifest([
    { path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } },
  ]);
  const result = await createSnapshot(h.snapshotDeps, { manifest });
  return result.snapshotRef.id;
}

/**
 * Build a desynced harness: same snapshot store (record still references the
 * original gitRef) but a FRESH workspace + freshly initialized git repo that
 * does not contain the snapshot commit.
 */
async function makeDesyncedDeps(store: SnapshotStore): Promise<Harness> {
  const desynced = await makeDeps(store);
  await desynced.versioning.init(GIT_REPO_DIR);
  return desynced;
}

// ---------------------------------------------------------------------------
// (a) File absent at a RESOLVABLE commit → empty baseline, no false error
// ---------------------------------------------------------------------------

describe('hcr-009 (a): file absent at a resolvable snapshot commit → empty baseline', () => {
  it('loadBaselineContent returns empty bytes for a file the commit never contained', async () => {
    const h = await makeDeps();
    const snapshotRefId = await seedSnapshot(h);
    const record = await h.store.get(snapshotRefId);
    expect(record?.gitRef).toBeTruthy();

    const baseline = await loadBaselineContent({
      versioning: h.versioning,
      gitRepoDir: GIT_REPO_DIR,
      gitRef: record!.gitRef!,
      file: 'src/never-existed.js',
    });
    expect(baseline.byteLength).toBe(0);
  });

  it('auditDiff PASSes a genuinely new contracted file (added symbols in scope)', async () => {
    const h = await makeDeps();
    // src/b.js does NOT exist at snapshot time — the commit resolves, the
    // blob is absent. That is the legitimate new-file case.
    await h.fs.write('src/a.js', enc(BASELINE));
    const manifest = makeManifest([
      { path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } },
      { path: 'src/b.js', scope: { kind: 'symbols', symbols: ['baz'] } },
    ]);
    const { snapshotRef } = await createSnapshot(h.snapshotDeps, { manifest });

    await h.fs.write('src/b.js', enc('function baz() { return 3; }\n'));

    const result = await auditDiff(h.auditDiffDeps, {
      snapshotRefId: snapshotRef.id,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/b.js'],
    });
    expect(result.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// (b) Unresolvable snapshot commit → typed adapter failure (fail CLOSED)
// ---------------------------------------------------------------------------

describe('hcr-009 (b): unresolvable snapshot commit → typed adapter failure, not empty baseline', () => {
  it('loadBaselineContent rejects with git_read_failed for an unknown commit SHA', async () => {
    const h = await makeDeps();
    await seedSnapshot(h);

    await expect(
      loadBaselineContent({
        versioning: h.versioning,
        gitRepoDir: GIT_REPO_DIR,
        gitRef: UNKNOWN_COMMIT_SHA,
        file: 'src/a.js',
      }),
    ).rejects.toMatchObject({ kind: 'git_read_failed' });
  });

  it('auditDiff fails closed under repo/store desync instead of PASSing a deletion of an out-of-scope symbol', async () => {
    const h = await makeDeps();
    const snapshotRefId = await seedSnapshot(h);

    // Desync: the store row survives; the repo no longer has the commit.
    const desynced = await makeDesyncedDeps(h.store);
    // Disk state deletes bar — a symbol outside the contracted scope. With
    // the baseline unknown, this MUST NOT silently PASS.
    await desynced.fs.write('src/a.js', enc(DELETED_BAR));

    await expect(
      auditDiff(desynced.auditDiffDeps, {
        snapshotRefId,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        files: ['src/a.js'],
      }),
    ).rejects.toMatchObject({ kind: 'git_read_failed' });
  });

  it('dryRun fails closed under desync with no side effects', async () => {
    const h = await makeDeps();
    const snapshotRefId = await seedSnapshot(h);

    const desynced = await makeDesyncedDeps(h.store);
    const writeSpy = vi.spyOn(desynced.fs, 'write');
    const auditLogSpy = vi.spyOn(desynced.store, 'appendAuditLog');

    await expect(
      dryRun(desynced.dryRunDeps, {
        snapshotRefId,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        proposedChanges: [{ file: 'src/a.js', content: DELETED_BAR }],
      }),
    ).rejects.toMatchObject({ kind: 'git_read_failed' });

    // dryRun stays strictly side-effect-free even on the fail-closed path.
    expect(writeSpy).not.toHaveBeenCalled();
    expect(auditLogSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    auditLogSpy.mockRestore();
  });
});
