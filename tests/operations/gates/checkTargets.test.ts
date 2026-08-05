/**
 * tests/operations/gates/checkTargets.test.ts — LC1 checkTargetsGate test suite.
 *
 * 15 required tests (LC1-1 through LC1-15).
 *
 * Uses:
 *   - createMemFsAdapter()            — in-memory fs (C2)
 *   - createIsomorphicGitVersioning() — real in-memory git (C4)
 *   - createTreeSitterIntelligence()  — real WASM grammars (D3)
 *   - createIsolatedTestStore()       — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()           — in-memory event store (C5)
 *   - assertEventIsContentFree()      — H13 content-free assertion
 *   - createHoplonEngine()            — full engine for integration tests (LC1-13)
 *
 * Critical proofs:
 *   LC1-3: TARGET_NOT_FOUND violation shape
 *   LC1-5: DUPLICATE_TARGET violation shape with existingByteRange
 *   LC1-13: full-engine integration — both gates appear in result
 *   LC1-15: v1 backward compat — no intent → PASS
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { checkTargetsGate } from '../../../src/hoplon/operations/gates/checkTargets.js';
import { preflight } from '../../../src/hoplon/operations/preflight.js';
import type { PreflightDeps, PreflightGateContext } from '../../../src/hoplon/operations/preflight.js';
import type { PreflightRequest } from '../../../src/hoplon/contracts/requests.js';
import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../../src/hoplon/adapters/emitter/assert.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';
import type { VersioningAdapter } from '../../../src/hoplon/adapters/versioning.js';
import type { SnapshotStore, SnapshotRecord } from '../../../src/hoplon/adapters/snapshotStore.js';
import { createHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import { createSnapshot } from '../../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../../src/hoplon/operations/createSnapshot.js';
import { hashManifest } from '../../../src/hoplon/util/hashManifest.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const GIT_REPO_DIR = '/.hoplon/repo';
const FS_ROOT = '/';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Shared CI — loaded once to avoid repeated WASM loads
let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh set of deps per test.
 * Returns both gate-level deps (PreflightDeps) and snapshot deps (CreateSnapshotDeps),
 * sharing the same fs + versioning + store so real git snapshots can be created.
 */
async function makeDeps(opts?: {
  ci?: CodeIntelligenceAdapter;
}): Promise<{
  preflightDeps: PreflightDeps;
  gateCtx: PreflightGateContext;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();
  const ci = opts?.ci ?? sharedCI;

  const preflightDeps: PreflightDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: ci,
    emitter,
    engineId: 'test-engine',
    config: { fsRoot: FS_ROOT, gitRepoDir: GIT_REPO_DIR },
    gates: [checkTargetsGate],
  };

  const gateCtx: PreflightGateContext = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: ci,
    emitter,
    engineId: 'test-engine',
    config: { fsRoot: FS_ROOT, gitRepoDir: GIT_REPO_DIR },
  };

  const snapshotDeps: CreateSnapshotDeps = {
    fs,
    versioning,
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter,
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: {
      gitRepoDir: GIT_REPO_DIR,
      fsRoot: FS_ROOT,
      manifestStorageMode: 'inline',
    },
  };

  return { preflightDeps, gateCtx, snapshotDeps, fs, versioning, emitter, store };
}

/**
 * Create a real snapshot (with git commit) and return the snapshotRef id.
 * The fs must have all manifest files pre-seeded before calling this.
 */
async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  manifest: WritableManifest,
): Promise<string> {
  const result = await createSnapshot(snapshotDeps, { manifest });
  return result.snapshotRef.id;
}

/**
 * Seed a snapshot record directly into the store (no real git commit).
 * Used for AS-2 tests that don't need real git history.
 */
async function seedSnapshot(
  store: SnapshotStore,
  opts: {
    projectId?: string;
    runId?: string;
    status?: 'pending' | 'committed' | 'failed';
    gitRef?: string | null;
    manifest?: WritableManifest;
  } = {},
): Promise<string> {
  const manifest: WritableManifest = opts.manifest ?? {
    manifestSchemaVersion: 2,
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    entries: [{ path: 'src/a.ts', scope: { kind: 'symbols', symbols: ['foo'] }, intent: 'modify' }],
  };

  const id = hashManifest(manifest);

  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: 2,
    engineId: 'test-engine',
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    status: opts.status ?? 'committed',
    statusReason: opts.status === 'failed' ? 'test failure' : null,
    gitRef: opts.gitRef !== undefined ? opts.gitRef : (opts.status ?? 'committed') === 'committed' ? 'abc123' : null,
    manifest,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };

  await store.put(record);
  return id;
}

/** Build a minimal valid PreflightRequest. */
function makeReq(
  manifest: WritableManifest,
  overrides: Partial<PreflightRequest> = {},
): PreflightRequest {
  return {
    manifest,
    projectId: manifest.projectId,
    runId: manifest.runId,
    correlationId: manifest.correlationId,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LC1-1: No intent on any entry → SKIPPED per entry, PASS overall
// ---------------------------------------------------------------------------

describe('LC1-1: No intent on any entry → PASS (all entries skipped)', () => {
  it('v1 manifest without intent produces PASS — gate skips all entries', async () => {
    const { gateCtx, snapshotDeps, store, fs } = await makeDeps();

    await fs.write('src/a.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        { path: 'src/a.ts', scope: { kind: 'symbols', symbols: ['foo'] } },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.gateName).toBe('check_targets');
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
    void store;
  });
});

// ---------------------------------------------------------------------------
// LC1-2: intent: 'modify' with existing symbol → PASS
// ---------------------------------------------------------------------------

describe('LC1-2: intent: "modify" with existing symbol → PASS', () => {
  it('returns PASS when the symbol exists in the snapshot', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-3: intent: 'modify' with missing symbol → BLOCK TARGET_NOT_FOUND
// ---------------------------------------------------------------------------

describe('LC1-3: intent: "modify" with missing symbol → BLOCK TARGET_NOT_FOUND', () => {
  it('returns BLOCK with TARGET_NOT_FOUND violation for a phantom symbol', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // Snapshot only has 'foo', manifest targets 'bar' (doesn't exist)
    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['bar'] },
          intent: 'modify',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');

    expect(v.kind).toBe('TARGET_NOT_FOUND');
    if (v.kind !== 'TARGET_NOT_FOUND') throw new Error('wrong kind');

    expect(v.symbolName).toBe('bar');
    expect(v.path).toBe('src/foo.ts');
    expect(v.manifestIntent).toBe('modify');
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.correction.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-4: intent: 'create' with non-existent symbol → PASS
// ---------------------------------------------------------------------------

describe('LC1-4: intent: "create" with non-existent symbol → PASS', () => {
  it('returns PASS when the "create" target symbol does not exist in snapshot', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // Snapshot only has 'foo', manifest wants to create 'bar' (doesn't exist) → PASS
    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['bar'] },
          intent: 'create',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-5: intent: 'create' with existing symbol → BLOCK DUPLICATE_TARGET
// ---------------------------------------------------------------------------

describe('LC1-5: intent: "create" with existing symbol → BLOCK DUPLICATE_TARGET', () => {
  it('returns BLOCK with DUPLICATE_TARGET violation and existingByteRange populated', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // Snapshot has 'foo', manifest wants to create 'foo' → DUPLICATE
    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'create',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');

    expect(v.kind).toBe('DUPLICATE_TARGET');
    if (v.kind !== 'DUPLICATE_TARGET') throw new Error('wrong kind');

    expect(v.symbolName).toBe('foo');
    expect(v.path).toBe('src/foo.ts');
    expect(v.manifestIntent).toBe('create');
    // existingByteRange must be populated (two non-negative integers)
    expect(v.existingByteRange).toBeDefined();
    expect(Array.isArray(v.existingByteRange)).toBe(true);
    expect(v.existingByteRange[0]).toBeGreaterThanOrEqual(0);
    expect(v.existingByteRange[1]).toBeGreaterThan(0);
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.correction.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-6: Multiple symbols per entry — one missing, one present → one violation
// ---------------------------------------------------------------------------

describe('LC1-6: Multiple symbols per entry — one missing → one TARGET_NOT_FOUND', () => {
  it('emits one violation for the missing symbol, none for the present one', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // Snapshot has 'foo' but not 'bar'
    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo', 'bar'] },
          intent: 'modify',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');
    expect(v.kind).toBe('TARGET_NOT_FOUND');
    if (v.kind !== 'TARGET_NOT_FOUND') throw new Error('wrong kind');
    expect(v.symbolName).toBe('bar');
  });
});

// ---------------------------------------------------------------------------
// LC1-7: File-level intent — file missing in snapshot → TARGET_NOT_FOUND
// ---------------------------------------------------------------------------

describe('LC1-7: whole_file + intent: "modify", file absent in snapshot → TARGET_NOT_FOUND', () => {
  it('emits file-level TARGET_NOT_FOUND when the file does not exist in snapshot', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // Seed something else so the snapshot is valid, but src/new.ts is NOT in the snapshot
    await fs.write('src/existing.ts', enc('export function existing() {}\n'));

    // We need to create the snapshot BEFORE adding new.ts to the manifest
    // Use a v2 manifest that references src/existing.ts to satisfy the schema
    const snapshotManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [{ path: 'src/existing.ts', scope: { kind: 'whole_file' }, intent: 'modify' }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, snapshotManifest);

    // Now create a preflight request that targets src/new.ts (not in snapshot)
    const preflightManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [{ path: 'src/new.ts', scope: { kind: 'whole_file' }, intent: 'modify' }],
    };

    const req = makeReq(preflightManifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');
    expect(v.kind).toBe('TARGET_NOT_FOUND');
    if (v.kind !== 'TARGET_NOT_FOUND') throw new Error('wrong kind');
    expect(v.path).toBe('src/new.ts');
    expect(v.manifestIntent).toBe('modify');
  });
});

// ---------------------------------------------------------------------------
// LC1-8: File-level intent — file exists with intent: 'create' → DUPLICATE_TARGET
// ---------------------------------------------------------------------------

describe('LC1-8: whole_file + intent: "create", file exists → DUPLICATE_TARGET', () => {
  it('emits file-level DUPLICATE_TARGET when the file already exists in snapshot', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/existing.ts', enc('export function existing() {}\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [{ path: 'src/existing.ts', scope: { kind: 'whole_file' }, intent: 'create' }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');
    expect(v.kind).toBe('DUPLICATE_TARGET');
    if (v.kind !== 'DUPLICATE_TARGET') throw new Error('wrong kind');
    expect(v.path).toBe('src/existing.ts');
    expect(v.manifestIntent).toBe('create');
    expect(v.existingByteRange).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LC1-9: No snapshotRefId → gate SKIPPED
// ---------------------------------------------------------------------------

describe('LC1-9: No snapshotRefId → gate SKIPPED', () => {
  it('returns SKIPPED when snapshotRefId is not in the request', async () => {
    const { gateCtx } = await makeDeps();

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    // No snapshotRefId
    const req = makeReq(manifest);
    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.gateName).toBe('check_targets');
    expect(result.status).toBe('SKIPPED');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-10: Snapshot project/run mismatch → gate SKIPPED
// ---------------------------------------------------------------------------

describe('LC1-10: Snapshot project/run mismatch → gate SKIPPED', () => {
  it('returns SKIPPED when snapshot projectId differs from request projectId', async () => {
    const { gateCtx, store } = await makeDeps();

    // Seed snapshot for project 'proj-A'
    const snapshotRefId = await seedSnapshot(store, {
      projectId: 'proj-A',
      runId: 'run-001',
    });

    // But make a request for project 'proj-B'
    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-B',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    const req: PreflightRequest = {
      manifest,
      projectId: 'proj-B',
      runId: 'run-001',
      correlationId: 'corr-001',
      snapshotRefId,
    };

    const result = await checkTargetsGate.run(req, gateCtx);

    // Decision #2: project mismatch → SKIPPED (advisory gate, not authoritative)
    expect(result.status).toBe('SKIPPED');
    expect(result.violations).toHaveLength(0);
  });

  it('returns SKIPPED when snapshot runId differs from request runId', async () => {
    const { gateCtx, store } = await makeDeps();

    const snapshotRefId = await seedSnapshot(store, {
      projectId: 'proj-test',
      runId: 'run-001',
    });

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-999',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    const req: PreflightRequest = {
      manifest,
      projectId: 'proj-test',
      runId: 'run-999',
      correlationId: 'corr-001',
      snapshotRefId,
    };

    const result = await checkTargetsGate.run(req, gateCtx);
    expect(result.status).toBe('SKIPPED');
    expect(result.violations).toHaveLength(0);
  });

  it('returns SKIPPED when snapshot status is "pending" (not committed)', async () => {
    const { gateCtx, store } = await makeDeps();

    const snapshotRefId = await seedSnapshot(store, {
      projectId: 'proj-test',
      runId: 'run-001',
      status: 'pending',
    });

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    const req: PreflightRequest = {
      manifest,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      snapshotRefId,
    };

    const result = await checkTargetsGate.run(req, gateCtx);
    expect(result.status).toBe('SKIPPED');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-11: Snapshot missing → BLOCK with snapshot_missing violation
// ---------------------------------------------------------------------------

describe('LC1-11: Bogus snapshotRefId → BLOCK snapshot_missing violation', () => {
  it('emits snapshot_missing violation when snapshotRefId does not exist in store', async () => {
    const { gateCtx } = await makeDeps();

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['foo'] },
          intent: 'modify',
        },
      ],
    };

    // Bogus snapshotRefId — not in the store
    const req: PreflightRequest = {
      manifest,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      snapshotRefId: 'a'.repeat(64), // valid hex-length but not in store
    };

    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);

    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');
    expect(v.kind).toBe('snapshot_missing');
    if (v.kind !== 'snapshot_missing') throw new Error('wrong kind');
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.correction.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LC1-12: Abort signal pre-aborted → throws AbortError, no violations produced
// ---------------------------------------------------------------------------

describe('LC1-12: Pre-aborted signal → throws AbortError', () => {
  it('throws AbortError without producing violations when signal is already aborted', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['bar'] },
          intent: 'modify',
        },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const req = makeReq(manifest, { snapshotRefId });
    const abortedSignal = AbortSignal.abort();

    // The abort check happens inside the per-entry loop.
    // snapshot resolution and AS-2 checks happen before the loop, then abort is
    // detected on the first entry iteration.
    // DOMException.name === 'AbortError'; check .name, not .message.
    await expect(checkTargetsGate.run(req, gateCtx, abortedSignal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

// ---------------------------------------------------------------------------
// LC1-13: Integration with preflight umbrella — end-to-end
// ---------------------------------------------------------------------------

describe('LC1-13: Integration — preflight umbrella with both gates', () => {
  it('full engine preflight returns BLOCK with both gates in result; check_targets shows violation', async () => {
    // Build a real engine with all adapters
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const emitter = createMemoryEmitter();
    const store = await createIsolatedTestStore();
    const ci = sharedCI;

    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const engine = await createHoplonEngine(
      {
        fs,
        versioning,
        snapshotStore: store,
        lockProvider: createAsyncMutexLockProvider(),
        emitter,
        codeIntelligence: ci,
        secretScanner: createBuiltinRegexScanner(),
      },
      {
        engineId: 'integ-engine',
        fsRoot: FS_ROOT,
        gitRepoDir: GIT_REPO_DIR,
      },
    );

    // Create a snapshot containing 'foo'
    const snapshotManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-integ',
      runId: 'run-integ',
      correlationId: 'corr-snapshot',
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
    };

    const snapshotResult = await engine.createSnapshot({ manifest: snapshotManifest });
    const snapshotRefId = snapshotResult.snapshotRef.id;

    // Preflight request targeting 'bar' (doesn't exist → TARGET_NOT_FOUND)
    const preflightManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-integ',
      runId: 'run-integ',
      correlationId: 'corr-preflight',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['bar'] },
          intent: 'modify',
        },
      ],
    };

    const result = await engine.preflight({
      manifest: preflightManifest,
      projectId: 'proj-integ',
      runId: 'run-integ',
      correlationId: 'corr-preflight',
      snapshotRefId,
    });

    // Overall result is BLOCK
    expect(result.status).toBe('BLOCK');

    // Both gates are present in the result
    expect(result.gates).toHaveLength(2);

    const pathGate = result.gates.find((g) => g.gateName === 'path_traversal');
    const checkTargetsResult = result.gates.find((g) => g.gateName === 'check_targets');

    expect(pathGate).toBeDefined();
    expect(pathGate?.status).toBe('PASS');

    expect(checkTargetsResult).toBeDefined();
    expect(checkTargetsResult?.status).toBe('BLOCK');

    // The check_targets gate should have one TARGET_NOT_FOUND violation
    const ctViolations = checkTargetsResult?.violations ?? [];
    expect(ctViolations).toHaveLength(1);
    expect(ctViolations[0]?.kind).toBe('TARGET_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// LC1-14: H13 content-free events
// ---------------------------------------------------------------------------

describe('LC1-14: H13 content-free events — preflight emits no content in event stream', () => {
  it('all emitted events pass assertEventIsContentFree after a BLOCK preflight', async () => {
    const { preflightDeps, snapshotDeps, emitter, fs } = await makeDeps();

    await fs.write('src/foo.ts', enc('export function foo() { return 1; }\n'));

    const snapshotManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, snapshotManifest);

    // Request with a BLOCK-causing entry
    const preflightManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [
        {
          path: 'src/foo.ts',
          scope: { kind: 'symbols', symbols: ['bar'] },
          intent: 'modify',
        },
      ],
    };

    emitter.clear();

    await preflight(
      preflightDeps,
      makeReq(preflightManifest, { snapshotRefId }),
    );

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);

    // H13: symbol names must NOT appear in the event stream
    for (const event of events) {
      assertEventIsContentFree(event);
    }
  });
});

// ---------------------------------------------------------------------------
// LC1-15: Backward compat — v1 manifest passes
// ---------------------------------------------------------------------------

describe('LC1-15: Backward compat — v1 manifest without intent produces PASS', () => {
  it('v1 manifest (no intent field on any entry) produces PASS from check_targets gate', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/main.ts', enc('export function main() { return 0; }\n'));
    await fs.write('src/util.ts', enc('export function helper() {}\n'));

    const v1Manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
      entries: [
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
        { path: 'src/util.ts', scope: { kind: 'symbols', symbols: ['helper'] } },
        // No intent on any entry — pure v1 shape
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, v1Manifest);

    const req: PreflightRequest = {
      manifest: v1Manifest,
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
      snapshotRefId,
    };

    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.gateName).toBe('check_targets');
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });

  it('v2 manifest with entries that have no intent field → PASS (entries skipped)', async () => {
    const { gateCtx, snapshotDeps, fs } = await makeDeps();

    // File doesn't even need to exist — no check will be performed
    await fs.write('src/app.ts', enc('export function app() {}\n'));

    const v2NoIntentManifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
      entries: [
        // No intent — should be skipped entirely
        { path: 'src/app.ts', scope: { kind: 'symbols', symbols: ['app'] } },
      ],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, v2NoIntentManifest);

    const req: PreflightRequest = {
      manifest: v2NoIntentManifest,
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
      snapshotRefId,
    };

    const result = await checkTargetsGate.run(req, gateCtx);

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});
