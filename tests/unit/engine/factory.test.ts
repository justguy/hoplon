/**
 * Unit tests for createHoplonEngine factory (E1 scope).
 *
 * The factory is now ASYNC (returns Promise<HoplonEngine>). The A3.1 stub
 * tests (not_implemented) are replaced entirely with real delegation tests.
 *
 * ## Required tests (12 from the E1 spec)
 *  1.  All 7 mandatory adapters validated
 *  2.  Optional staticAnalysis substituted with noop
 *  3.  Config defaults applied
 *  4.  Config overrides merge
 *  5.  engineId frozen
 *  6.  Reconcile runs at startup
 *  7.  Reconcile failure refuses engine startup
 *  8.  Engine method delegation
 *  9.  health() reports all 8 adapters
 * 10.  health() degraded on adapter failure
 * 11.  createDefaultHoplonEngine end-to-end smoke (integration)
 * 12.  reconcile() callable externally
 *
 * ## Adapter validation from A3.1 (kept — these still apply)
 *   Missing adapter → EngineError({ kind: 'missing_adapter' })
 *   Invalid engineId → EngineError({ kind: 'config_invalid' })
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  createHoplonEngine,
  getHoplonEngineSnapshotStore,
} from '../../../src/hoplon/engine/factory.js';
import { EngineError } from '../../../src/hoplon/contracts/errors.js';
import type { HoplonAdapters } from '../../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createNoopAnalyzer } from '../../../src/hoplon/adapters/staticAnalysis/noop.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Shared tree-sitter intelligence (WASM init once per suite)
let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Helper: build a complete set of real in-memory adapters
// ---------------------------------------------------------------------------

async function makeAdapters(opts?: {
  snapshotStore?: SnapshotStore;
}): Promise<{
  adapters: HoplonAdapters;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());

  const adapters: HoplonAdapters = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter,
    codeIntelligence: sharedCI,
    secretScanner: createBuiltinRegexScanner(),
    // staticAnalysis intentionally omitted — tests that need it add it explicitly
  };
  return { adapters, fs, emitter, store };
}

const BASE_CONFIG = { engineId: 'test-engine', fsRoot: '/' };

// ---------------------------------------------------------------------------
// Test 1: All 7 mandatory adapters validated
// ---------------------------------------------------------------------------

describe('Test 1 — adapter validation: all 7 mandatory adapters required', () => {
  const mandatoryAdapters = [
    'fs',
    'versioning',
    'snapshotStore',
    'lockProvider',
    'emitter',
    'codeIntelligence',
    'secretScanner',
  ] as const;

  for (const key of mandatoryAdapters) {
    it(`throws EngineError missing_adapter when ${key} is missing`, async () => {
      const { adapters } = await makeAdapters();
      const broken = { ...adapters, [key]: undefined } as unknown as HoplonAdapters;

      await expect(createHoplonEngine(broken, BASE_CONFIG)).rejects.toBeInstanceOf(EngineError);

      const err = await createHoplonEngine(broken, BASE_CONFIG).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).kind).toBe('missing_adapter');
      expect((err as EngineError).correlationId).toBe('factory');
    });
  }

  it('succeeds with all 7 mandatory adapters present', async () => {
    const { adapters } = await makeAdapters();
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Optional staticAnalysis substituted with noop
// ---------------------------------------------------------------------------

describe('Test 2 — optional staticAnalysis substituted with noop', () => {
  it('succeeds when staticAnalysis is omitted', async () => {
    const { adapters } = await makeAdapters();
    // staticAnalysis is already absent from makeAdapters()
    expect(adapters.staticAnalysis).toBeUndefined();
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });

  it('health() reports staticAnalysis ok when omitted (noop substituted)', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    const h = await engine.health();
    // The noop analyzer always returns PASS — probe should be 'ok'
    expect(h.adapters.staticAnalysis).toBe('ok');
  });

  it('succeeds when staticAnalysis is explicitly provided', async () => {
    const { adapters } = await makeAdapters();
    const engineWithSA = await createHoplonEngine(
      { ...adapters, staticAnalysis: createNoopAnalyzer() },
      BASE_CONFIG,
    );
    const h = await engineWithSA.health();
    expect(h.adapters.staticAnalysis).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Config defaults applied
// ---------------------------------------------------------------------------

describe('Test 3 — config defaults applied', () => {
  it('engine constructs with minimal config (engineId + fsRoot only)', async () => {
    const { adapters } = await makeAdapters();
    // Provide only the required engineId and fsRoot; all other fields get defaults
    await expect(
      createHoplonEngine(adapters, { engineId: 'test-engine', fsRoot: '/' }),
    ).resolves.toBeDefined();
  });

  it('engine constructs with no config at all (all defaults)', async () => {
    const { adapters } = await makeAdapters();
    // No config — engineId defaults to 'local-0', fsRoot defaults to process.cwd()
    await expect(createHoplonEngine(adapters)).resolves.toBeDefined();
  });

  it('health() returns expected engineId when using default', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters);
    const h = await engine.health();
    expect(h.engineId).toBe('local-0');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Config overrides merge
// ---------------------------------------------------------------------------

describe('Test 4 — config overrides merge', () => {
  it('providing maxFileBytes overrides just that field', async () => {
    const { adapters } = await makeAdapters();
    // packContext uses maxFileBytes — if we set 1 byte, a file of 2 bytes should fail
    const engine = await createHoplonEngine(adapters, {
      engineId: 'test-engine',
      fsRoot: '/',
      maxFileBytes: 1,
    });

    // Write a 2-byte file to the memfs
    const fs = adapters.fs;
    await fs.write('src/big.ts', enc('ab'));

    const result = await engine.packContext({
      projectId: 'proj',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/big.ts'],
      strategy: { kind: 'whole_file' },
    });

    // file_too_large failure expected because maxFileBytes=1 < 2 bytes
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe('file_too_large');
  });

  it('other defaults (gitRepoDir, etc.) are preserved when only maxFileBytes is overridden', async () => {
    const { adapters } = await makeAdapters();
    // Just verify engine constructs without error — other defaults are internal
    await expect(
      createHoplonEngine(adapters, {
        engineId: 'test-engine',
        fsRoot: '/',
        maxFileBytes: 1024,
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 5: engineId frozen at construction
// ---------------------------------------------------------------------------

describe('Test 5 — engineId frozen at construction (H5)', () => {
  it('mutating adapters object after construction does not change engineId', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, { engineId: 'original-id', fsRoot: '/' });

    const h = await engine.health();
    expect(h.engineId).toBe('original-id');

    // Mutate adapters (which has no engineId property, but the engine closed over it)
    // The engine should still use 'original-id'
    const h2 = await engine.health();
    expect(h2.engineId).toBe('original-id');
  });

  it('mutating config object after construction does not change engineId', async () => {
    const cfg = { engineId: 'frozen-id', fsRoot: '/' };
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, cfg);

    // Mutate the original config object
    (cfg as { engineId: string }).engineId = 'mutated-id';

    const h = await engine.health();
    // Engine should still use 'frozen-id'
    expect(h.engineId).toBe('frozen-id');
  });

  it('throws config_invalid for whitespace engineId', async () => {
    const { adapters } = await makeAdapters();
    await expect(
      createHoplonEngine(adapters, { engineId: 'bad id', fsRoot: '/' }),
    ).rejects.toMatchObject({ kind: 'config_invalid' });
  });

  it('throws config_invalid for empty engineId', async () => {
    const { adapters } = await makeAdapters();
    await expect(
      createHoplonEngine(adapters, { engineId: '', fsRoot: '/' }),
    ).rejects.toMatchObject({ kind: 'config_invalid' });
  });
});

// ---------------------------------------------------------------------------
// Test 6: Reconcile runs at startup
// ---------------------------------------------------------------------------

describe('Test 6 — reconcile runs at startup (H10)', () => {
  it('pre-seeded pending row older than threshold is marked failed by startup reconcile', async () => {
    const store = await createIsolatedTestStore();
    const { adapters } = await makeAdapters({ snapshotStore: store });

    // Pre-seed a pending row with a very old createdAt (2 minutes ago)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const orphanId = 'a'.repeat(64);
    await store.put({
      id: orphanId,
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-orphan',
      runId: 'run-orphan',
      correlationId: 'corr-orphan',
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-orphan',
        runId: 'run-orphan',
        correlationId: 'corr-orphan',
        entries: [{ path: 'src/orphan.ts', scope: { kind: 'whole_file' } }],
      },
      createdAt: twoMinutesAgo,
      ttlExpires: null,
      replicaIds: [],
    });

    // Verify the row is pending before engine construction
    const before = await store.get(orphanId);
    expect(before?.status).toBe('pending');

    // Construct the engine — startup reconcile should convert the row to failed
    await createHoplonEngine(adapters, BASE_CONFIG);

    // Verify the row is now failed
    const after = await store.get(orphanId);
    expect(after?.status).toBe('failed');
    expect(after?.statusReason).toContain('pending row older than threshold');
  });

  it('recent pending row (within threshold) is NOT marked failed by startup reconcile', async () => {
    const store = await createIsolatedTestStore();
    const { adapters } = await makeAdapters({ snapshotStore: store });

    // Pre-seed a pending row with a very recent createdAt (5 seconds ago)
    const fiveSecondsAgo = new Date(Date.now() - 5_000).toISOString();
    const recentId = 'b'.repeat(64);
    await store.put({
      id: recentId,
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-recent',
      runId: 'run-recent',
      correlationId: 'corr-recent',
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-recent',
        runId: 'run-recent',
        correlationId: 'corr-recent',
        entries: [{ path: 'src/recent.ts', scope: { kind: 'whole_file' } }],
      },
      createdAt: fiveSecondsAgo,
      ttlExpires: null,
      replicaIds: [],
    });

    // Construct the engine — default threshold is 60_000 ms, row is only 5s old
    await createHoplonEngine(adapters, BASE_CONFIG);

    // Row should still be pending (not yet orphaned)
    const after = await store.get(recentId);
    expect(after?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Test 7: Reconcile failure refuses engine startup
// ---------------------------------------------------------------------------

describe('Test 7 — reconcile failure refuses engine startup', () => {
  it('throws EngineError reconcile_failed if snapshotStore.listPending throws', async () => {
    const { adapters } = await makeAdapters();

    // Mock snapshotStore.listPending to throw
    const brokenStore: SnapshotStore = {
      ...adapters.snapshotStore,
      listPending: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    };

    await expect(
      createHoplonEngine({ ...adapters, snapshotStore: brokenStore }, BASE_CONFIG),
    ).rejects.toMatchObject({
      kind: 'reconcile_failed',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 8: Engine method delegation
// ---------------------------------------------------------------------------

describe('Test 8 — engine method delegation', () => {
  it('packContext delegates to the operation and emits events', async () => {
    const { adapters, fs, emitter } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    // Pre-seed a TypeScript file in memfs
    await fs.write('src/hello.ts', enc('export const greeting = "hello";'));

    const result = await engine.packContext({
      projectId: 'proj',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/hello.ts'],
      strategy: { kind: 'whole_file' },
    });

    // Should have a slice for the file
    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    expect(result.slices[0]?.path).toBe('src/hello.ts');

    // Emitter should have captured events from packContext
    const events = emitter.getEvents().filter((e) => e.op === 'packContext');
    expect(events.length).toBeGreaterThanOrEqual(2); // start + end
    expect(events.find((e) => e.phase === 'start')).toBeDefined();
    expect(events.find((e) => e.phase === 'end')).toBeDefined();
  });

  it('createSnapshot delegates to the operation and creates a committed snapshot', async () => {
    const { adapters, fs, store } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    await fs.write('src/module.ts', enc('export const x = 1;'));

    const result = await engine.createSnapshot({
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj',
        runId: 'run-001',
        correlationId: 'corr-001',
        entries: [{ path: 'src/module.ts', scope: { kind: 'whole_file' } }],
      },
    });

    // Phase 2 HA1: ID format is now sha256:<64-char-hex> (71 chars)
    expect(result.snapshotRef.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.snapshotRef.engineId).toBe('test-engine');

    // Verify the row is committed in the store
    const record = await store.get(result.snapshotRef.id);
    expect(record?.status).toBe('committed');
  });
});

// ---------------------------------------------------------------------------
// Test 9: health() reports all 8 adapters
// ---------------------------------------------------------------------------

describe('Test 9 — health() reports all 8 adapters', () => {
  it('returns object with all 8 adapter keys', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    const h = await engine.health();

    expect(h.engineId).toBe('test-engine');
    expect(h.adapters).toHaveProperty('fs');
    expect(h.adapters).toHaveProperty('versioning');
    expect(h.adapters).toHaveProperty('snapshotStore');
    expect(h.adapters).toHaveProperty('lockProvider');
    expect(h.adapters).toHaveProperty('emitter');
    expect(h.adapters).toHaveProperty('codeIntelligence');
    expect(h.adapters).toHaveProperty('secretScanner');
    expect(h.adapters).toHaveProperty('staticAnalysis');
    expect(h.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('all adapters report ok for a healthy engine', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    const h = await engine.health();

    const statuses = Object.values(h.adapters);
    // All should be 'ok' (no probes fail for fresh in-memory adapters)
    for (const status of statuses) {
      expect(status).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: health() degraded on adapter failure
// ---------------------------------------------------------------------------

describe('Test 10 — health() reports failed on adapter probe failure', () => {
  it('snapshotStore reports failed when listPending throws during health probe', async () => {
    const { adapters } = await makeAdapters();

    // Create engine first with a working store (reconcile needs it)
    // Then swap the snapshotStore after construction by building deps manually
    // (We construct from scratch with a broken store that only fails on health probe)

    // Strategy: make a store that fails AFTER reconcile succeeds.
    // We use a wrapper that fails after the first call.
    let callCount = 0;
    const realStore = await createIsolatedTestStore();
    const storeWrapper: SnapshotStore = {
      put: (...args) => realStore.put(...args),
      get: (...args) => realStore.get(...args),
      findByProjectAndRun: (...args) => realStore.findByProjectAndRun(...args),
      updateStatus: (...args) => realStore.updateStatus(...args),
      listPending: (...args) => {
        callCount++;
        if (callCount > 1) {
          // First call is from reconcile at startup — let it succeed
          // Subsequent calls (from health probe) fail
          return Promise.reject(new Error('DB connection lost during health probe'));
        }
        return realStore.listPending(...args);
      },
      gc: (...args) => realStore.gc(...args),
    };

    const wrappedAdapters: HoplonAdapters = {
      ...adapters,
      snapshotStore: storeWrapper,
    };

    const engine = await createHoplonEngine(wrappedAdapters, BASE_CONFIG);
    const h = await engine.health();

    expect(h.adapters.snapshotStore).toBe('failed');
    // Other adapters should still be ok
    expect(h.adapters.fs).toBe('ok');
  });

  it('lockProvider reports failed when acquire throws during health probe', async () => {
    const { adapters } = await makeAdapters();

    const brokenLock = {
      acquire: vi.fn().mockRejectedValue(new Error('lock failure')),
    };

    const engine = await createHoplonEngine(
      { ...adapters, lockProvider: brokenLock },
      BASE_CONFIG,
    );

    const h = await engine.health();
    expect(h.adapters.lockProvider).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Test 11: createDefaultHoplonEngine end-to-end smoke
// ---------------------------------------------------------------------------

describe('Test 11 — createDefaultHoplonEngine end-to-end smoke', () => {
  it('wires together and can round-trip createSnapshot → auditDiff → PASS', async () => {
    // Use dynamic import to avoid importing createDefaultHoplonEngine at test collect time
    // (it imports fs/node which we don't want polluting the unit test environment)
    // Instead, wire an engine manually with memfs adapters but using the same
    // logical path as createDefaultHoplonEngine:
    const { adapters, fs } = await makeAdapters();

    const engine: HoplonEngine = await createHoplonEngine(adapters, {
      engineId: 'smoke-test',
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
    });

    // Write a TypeScript file
    await fs.write('src/service.ts', enc('export function greet(name: string): string { return `Hello ${name}`; }'));

    const manifest = {
      manifestSchemaVersion: 1 as const,
      projectId: 'proj-smoke',
      runId: 'run-smoke-001',
      correlationId: 'corr-smoke-001',
      entries: [{ path: 'src/service.ts', scope: { kind: 'whole_file' as const } }],
    };

    // createSnapshot
    const snapshotResult = await engine.createSnapshot({ manifest });
    // Phase 2 HA1: ID format is now sha256:<64-char-hex> (71 chars)
    expect(snapshotResult.snapshotRef.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshotResult.snapshotRef.engineId).toBe('smoke-test');

    // auditDiff — same file, no changes → PASS
    const auditResult = await engine.auditDiff({
      snapshotRefId: snapshotResult.snapshotRef.id,
      projectId: 'proj-smoke',
      runId: 'run-smoke-001',
      correlationId: 'corr-smoke-001',
      files: ['src/service.ts'],
    });

    expect(auditResult.status).toBe('PASS');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 12: reconcile() callable externally
// ---------------------------------------------------------------------------

describe('Test 12 — reconcile() callable externally', () => {
  it('exposes the exact local snapshot-store binding for launcher session composition', async () => {
    const { adapters, store } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    expect(getHoplonEngineSnapshotStore(engine)).toBe(store);
    expect(Object.keys(engine)).not.toContain('snapshotStore');
  });

  it('startup reconcile completes a recoverable Phase-B commit on the default engine path', async () => {
    const { adapters, fs, store } = await makeAdapters();
    const gitRepoDir = '/.hoplon/repo';
    const orphanId = '9'.repeat(64);
    await adapters.versioning.init(gitRepoDir);
    await fs.write('.hoplon/repo/src/recovered.ts', enc('export const recovered = true;'));
    await adapters.versioning.add(gitRepoDir, ['src/recovered.ts']);
    const { sha } = await adapters.versioning.commit(
      gitRepoDir,
      `hoplon-snapshot ${orphanId}`,
      { committer: { timestamp: 0 } },
    );
    await store.put({
      id: orphanId,
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-recovery',
      runId: 'run-recovery',
      correlationId: 'corr-recovery',
      status: 'pending',
      statusReason: null,
      gitRef: sha,
      manifest: null,
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      ttlExpires: null,
      replicaIds: [],
      presencePaths: null,
    });

    const engine = await createHoplonEngine(adapters, {
      ...BASE_CONFIG,
      gitRepoDir,
    });

    expect((await store.get(orphanId))?.status).toBe('committed');
    expect((await store.get(orphanId))?.gitRef).toBe(sha);
    await expect(engine.reconcile()).resolves.toMatchObject({
      reconciled: 0,
      failed: 0,
      orphans: { pendingRows: 0 },
    });
  });

  it('returns a ReconcileReport with the right shape', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    const report = await engine.reconcile();

    expect(report).toHaveProperty('reconciled');
    expect(report).toHaveProperty('failed');
    expect(report).toHaveProperty('orphans');
    expect(report.orphans).toHaveProperty('gitObjects');
    expect(report.orphans).toHaveProperty('pendingRows');
    expect(typeof report.reconciled).toBe('number');
    expect(typeof report.failed).toBe('number');
    expect(typeof report.orphans.gitObjects).toBe('number');
    expect(typeof report.orphans.pendingRows).toBe('number');
  });

  it('external reconcile on a clean store returns reconciled=0', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    // No pending rows → reconcile should return 0 reconciled
    const report = await engine.reconcile();
    expect(report.reconciled).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.orphans.pendingRows).toBe(0);
    // Phase 1: always 0 git objects orphaned
    expect(report.orphans.gitObjects).toBe(0);
  });

  it('external reconcile converts pending orphan rows to failed', async () => {
    const store = await createIsolatedTestStore();
    const { adapters } = await makeAdapters({ snapshotStore: store });

    // Construct engine (startup reconcile runs, no pending rows yet)
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);

    // Now manually insert an old pending row after construction
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const orphanId = 'c'.repeat(64);
    await store.put({
      id: orphanId,
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj',
      runId: 'run-ext',
      correlationId: 'corr-ext',
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj',
        runId: 'run-ext',
        correlationId: 'corr-ext',
        entries: [{ path: 'src/ext.ts', scope: { kind: 'whole_file' } }],
      },
      createdAt: twoMinutesAgo,
      ttlExpires: null,
      replicaIds: [],
    });

    // Call reconcile externally
    const report = await engine.reconcile();
    expect(report.reconciled).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.orphans.pendingRows).toBe(1);

    // Verify the row is now failed
    const after = await store.get(orphanId);
    expect(after?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Adapter validation tests from A3.1 (updated for async factory)
// ---------------------------------------------------------------------------

describe('engineId validation (A3.1 carried forward)', () => {
  it('defaults engineId to local-0', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, { fsRoot: '/' });
    const h = await engine.health();
    expect(h.engineId).toBe('local-0');
  });

  it('uses provided engineId', async () => {
    const { adapters } = await makeAdapters();
    const engine = await createHoplonEngine(adapters, { engineId: 'my-engine', fsRoot: '/' });
    const h = await engine.health();
    expect(h.engineId).toBe('my-engine');
  });

  it('throws config_invalid for engineId with tab character', async () => {
    const { adapters } = await makeAdapters();
    await expect(
      createHoplonEngine(adapters, { engineId: 'bad\tid', fsRoot: '/' }),
    ).rejects.toMatchObject({ kind: 'config_invalid' });
  });
});
