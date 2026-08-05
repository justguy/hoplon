/**
 * tests/operations/dryRun.test.ts — DR1 dryRun targeted test suite.
 *
 * 11 required tests (DR-1 through DR-11).
 *
 * Uses:
 *   - createMemFsAdapter()             — in-memory fs (C2)
 *   - createIsomorphicGitVersioning()  — real in-memory git (C4)
 *   - createTreeSitterIntelligence()   — real WASM grammars (D3)
 *   - createIsolatedTestStore()        — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()            — in-memory event store (C5)
 *   - assertEventIsContentFree()       — H13 content-free assertion
 *
 * Critical proofs:
 *   DR-1: H17 idempotency (byte-determinism)
 *   DR-4: No disk write (H17 corollary)
 *   DR-5: No audit log write (stub — AL1 not yet landed)
 *   DR-10: dryRun↔auditDiff cross-equivalence (structural proof)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { dryRun } from '../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../src/hoplon/operations/dryRun.js';
import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore, SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { ValidationError, SemanticError } from '../../src/hoplon/contracts/errors.js';
import type { DryRunRequest } from '../../src/hoplon/contracts/requests.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { hashManifest } from '../../src/hoplon/util/hashManifest.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Shared adapter — re-initialize WASM once across all tests
let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const GIT_REPO_DIR = '/.hoplon/repo';
const FS_ROOT = '/';

/**
 * Build a fresh set of deps per test.
 *
 * Returns both dryRun deps and createSnapshot deps sharing the same
 * fs + versioning + store so real git snapshots can be created and
 * then evaluated by dryRun.
 */
async function makeDeps(opts?: {
  ci?: CodeIntelligenceAdapter;
  maxFileBytes?: number;
  parseTimeoutMs?: number;
  snapshotStore?: SnapshotStore;
}): Promise<{
  dryRunDeps: DryRunDeps;
  auditDiffDeps: AuditDiffDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());

  const dryRunDeps: DryRunDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: opts?.ci ?? sharedCI,
    emitter,
    engineId: 'test-engine',
    config: {
      fsRoot: FS_ROOT,
      gitRepoDir: GIT_REPO_DIR,
      maxFileBytes: opts?.maxFileBytes ?? 1024 * 1024,
      parseTimeoutMs: opts?.parseTimeoutMs ?? 5000,
      manifestSchemaVersion: 1,
    },
  };

  const auditDiffDeps: AuditDiffDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: opts?.ci ?? sharedCI,
    emitter,
    engineId: 'test-engine',
    config: {
      fsRoot: FS_ROOT,
      gitRepoDir: GIT_REPO_DIR,
      maxFileBytes: opts?.maxFileBytes ?? 1024 * 1024,
      parseTimeoutMs: opts?.parseTimeoutMs ?? 5000,
      manifestSchemaVersion: 1,
    },
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

  return { dryRunDeps, auditDiffDeps, snapshotDeps, fs, versioning, emitter, store };
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
 * Useful for AS-2 / H8 tests that don't need real git history.
 */
async function seedSnapshot(
  store: SnapshotStore,
  opts: {
    projectId?: string;
    runId?: string;
    status?: 'pending' | 'committed' | 'failed';
    manifestSchemaVersion?: number;
    manifest?: WritableManifest;
  } = {},
): Promise<string> {
  const manifest: WritableManifest = opts.manifest ?? {
    manifestSchemaVersion: 1,
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
  };

  const id = hashManifest(manifest);

  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: opts.manifestSchemaVersion ?? 1,
    engineId: 'test-engine',
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    status: opts.status ?? 'committed',
    statusReason: opts.status === 'failed' ? 'test failure' : null,
    gitRef: (opts.status ?? 'committed') === 'committed' ? 'abc123' : null,
    manifest,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };

  await store.put(record);
  return id;
}

/** Build a minimal DryRunRequest. */
function makeReq(
  snapshotRefId: string,
  overrides: Partial<DryRunRequest> = {},
): DryRunRequest {
  return {
    snapshotRefId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 1; }\n' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DR-1: H17 idempotency (byte-determinism) — critical invariant proof
// ---------------------------------------------------------------------------

describe('DR-1: H17 idempotency — same input → byte-identical output', () => {
  it('calling dryRun twice with identical proposedChanges produces byte-identical results', async () => {
    const { dryRunDeps, snapshotDeps, fs, emitter } = await makeDeps();

    // Seed the file for snapshot creation
    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const proposedChanges = [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }];

    emitter.clear();
    const result1 = await dryRun(dryRunDeps, makeReq(snapshotRefId, { proposedChanges }));
    emitter.clear();
    const result2 = await dryRun(dryRunDeps, makeReq(snapshotRefId, { proposedChanges }));

    // Byte-identical outputs (H17)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    expect(result1.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// DR-2: PASS on in-scope edit
// ---------------------------------------------------------------------------

describe('DR-2: PASS on in-scope edit', () => {
  it('proposing a body change to an in-scope function returns PASS', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const result = await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
      }),
    );

    expect(result.status).toBe('PASS');
    if (result.status === 'PASS') {
      expect(result.checked).toBe(1);
    }
    expect(result.auditSchemaVersion).toBe(1);
    expect(result.correlationId).toBe('corr-001');
  });
});

// ---------------------------------------------------------------------------
// DR-3: BLOCK on out-of-scope new symbol
// ---------------------------------------------------------------------------

describe('DR-3: BLOCK on out-of-scope new symbol', () => {
  it('proposing a new bar function (not in scope) returns BLOCK', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    const result = await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [
          { file: 'src/a.js', content: 'function foo() {}\nfunction bar() {}\n' },
        ],
      }),
    );

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const barViolation = result.violations.find(
        (v) => v.kind === 'out_of_scope_symbol' && v.symbolName === 'bar',
      );
      expect(barViolation).toBeDefined();
      if (barViolation && barViolation.kind === 'out_of_scope_symbol') {
        expect(barViolation.correction).toBeTruthy();
        expect(barViolation.correction.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DR-4: No disk write — H17 corollary proof
// ---------------------------------------------------------------------------

describe('DR-4: No disk write — H17 pure-function proof', () => {
  it('dryRun never calls fs.write regardless of PASS or BLOCK result', async () => {
    const { dryRunDeps, snapshotDeps, fs, emitter } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    // Spy on fs.write — must remain uncalled
    const writeSpy = vi.spyOn(fs, 'write');

    // Test PASS path
    emitter.clear();
    writeSpy.mockClear();
    await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
      }),
    );
    expect(writeSpy).not.toHaveBeenCalled();

    // Test BLOCK path
    emitter.clear();
    writeSpy.mockClear();
    await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [
          { file: 'src/a.js', content: 'function foo() {}\nfunction bar() {}\n' },
        ],
      }),
    );
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DR-5: No audit log write — H21 proof (AL1 not yet landed)
// ---------------------------------------------------------------------------

describe('DR-5: No audit log write — AL1 not yet landed, stub assertion', () => {
  it('snapshotStore.appendAuditLog is not defined (AL1 not landed) — dryRun must not call it', async () => {
    // AL1 has not yet landed. SnapshotStore interface does not have appendAuditLog.
    // This test verifies:
    //   1. appendAuditLog is NOT on the SnapshotStore interface (type-level proof)
    //   2. If it were stubbed, dryRun would not call it (behavioral proof)
    //
    // TODO: When AL1 lands, replace this with a real vi.spyOn(store, 'appendAuditLog')
    // assertion and remove the skip.

    const { dryRunDeps, snapshotDeps, fs, store } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    // Stub appendAuditLog on the store (it doesn't exist yet — this simulates AL1)
    const storeWithStub = store as SnapshotStore & {
      appendAuditLog?: (...args: unknown[]) => Promise<void>;
    };
    const appendAuditLogSpy = vi.fn().mockResolvedValue(undefined);
    storeWithStub.appendAuditLog = appendAuditLogSpy;

    await dryRun(
      { ...dryRunDeps, snapshotStore: storeWithStub },
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
      }),
    );

    // dryRun must never call appendAuditLog (H21 — exploratory, no audit log)
    expect(appendAuditLogSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DR-6: AS-2 cross-project replay
// ---------------------------------------------------------------------------

describe('DR-6: AS-2 cross-project replay rejection', () => {
  it('snapshot from proj_A cannot be used under proj_B — project_id_mismatch', async () => {
    const { dryRunDeps, snapshotDeps, fs, versioning } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj_A',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    // Spy versioning.readBlob — must NOT be called before AS-2 rejects
    const readBlobSpy = vi.spyOn(versioning, 'readBlob');

    await expect(
      dryRun(
        dryRunDeps,
        makeReq(snapshotRefId, {
          projectId: 'proj_B',
          proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
        }),
      ),
    ).rejects.toThrow(SemanticError);

    await expect(
      dryRun(
        dryRunDeps,
        makeReq(snapshotRefId, {
          projectId: 'proj_B',
          proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'project_id_mismatch' });

    // readBlob must not have been called (AS-2 rejects before any I/O)
    expect(readBlobSpy).not.toHaveBeenCalled();

    readBlobSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DR-7: AS-2 cross-run replay
// ---------------------------------------------------------------------------

describe('DR-7: AS-2 cross-run replay rejection', () => {
  it('snapshot from run-001 cannot be used under run-999 — run_id_mismatch', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    await expect(
      dryRun(
        dryRunDeps,
        makeReq(snapshotRefId, {
          runId: 'run-999',
          proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'run_id_mismatch' });
  });
});

// ---------------------------------------------------------------------------
// DR-8: H8 schema version check
// ---------------------------------------------------------------------------

describe('DR-8: H8 schema version mismatch', () => {
  it('snapshot with manifestSchemaVersion 2 raises manifest_version_mismatch', async () => {
    const { dryRunDeps, store } = await makeDeps();

    // Directly seed a snapshot record with a future schema version
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const id = hashManifest(manifest);

    const record: SnapshotRecord = {
      id,
      manifestSchemaVersion: 2, // future version — engine expects 1
      engineId: 'test-engine',
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      status: 'committed',
      statusReason: null,
      gitRef: 'abc123',
      manifest,
      createdAt: new Date().toISOString(),
      ttlExpires: null,
      replicaIds: [],
    };

    await store.put(record);

    await expect(
      dryRun(dryRunDeps, makeReq(id)),
    ).rejects.toMatchObject({ kind: 'manifest_version_mismatch' });
  });
});

// ---------------------------------------------------------------------------
// DR-9: Path traversal in proposedChanges
// ---------------------------------------------------------------------------

describe('DR-9: Path traversal in proposedChanges', () => {
  it('proposedChanges with traversal path raises path_traversal ValidationError', async () => {
    // Use /project as fsRoot so ../../etc/passwd escapes out
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const emitter = createMemoryEmitter();
    const store = await createIsolatedTestStore();

    const fsRoot = '/project';
    const gitRepoDir = '/hoplon/repo';

    const dryRunDepsNarrow: DryRunDeps = {
      fs,
      versioning,
      snapshotStore: store,
      codeIntelligence: sharedCI,
      emitter,
      engineId: 'test-engine',
      config: {
        fsRoot,
        gitRepoDir,
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        manifestSchemaVersion: 1,
      },
    };

    // Directly seed a snapshot record (no createSnapshot needed — path traversal
    // is checked before snapshot resolution anyway, but we need a valid snapshotRefId
    // for the request to pass Zod validation)
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const snapshotRefId = await seedSnapshot(store, { manifest });

    // Spy readBlob — must NOT be called (path traversal aborts before snapshot resolution)
    const readBlobSpy = vi.spyOn(versioning, 'readBlob');

    // ../../etc/passwd from /project resolves to /etc/passwd — outside /project
    await expect(
      dryRun(
        dryRunDepsNarrow,
        makeReq(snapshotRefId, {
          proposedChanges: [
            { file: '../../etc/passwd', content: 'root:x:0:0:root:/root:/bin/bash\n' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      dryRun(
        dryRunDepsNarrow,
        makeReq(snapshotRefId, {
          proposedChanges: [
            { file: '../../etc/passwd', content: 'root:x:0:0:root:/root:/bin/bash\n' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'path_traversal' });

    // readBlob must not have been called (path traversal aborts before any I/O)
    expect(readBlobSpy).not.toHaveBeenCalled();

    readBlobSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DR-10: dryRun↔auditDiff cross-equivalence — critical correctness proof
// ---------------------------------------------------------------------------

describe('DR-10: dryRun↔auditDiff cross-equivalence', () => {
  it('dryRun and auditDiff produce the same status and violation kinds for the same content', async () => {
    const { dryRunDeps, auditDiffDeps, snapshotDeps, fs, emitter } = await makeDeps();

    // Seed files
    const originalContent = 'function foo() { return 1; }\n';
    const proposedContent = 'function foo() {}\nfunction bar() {}\n';

    await fs.write('src/a.js', enc(originalContent));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    // Write proposed content to disk for auditDiff
    await fs.write('src/a.js', enc(proposedContent));

    emitter.clear();

    // Call auditDiff (reads from disk)
    const auditResult = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    emitter.clear();

    // Call dryRun (reads from git readBlob, content from payload — same content)
    const dryRunResult = await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: proposedContent }],
      }),
    );

    // Structural equivalence: same status
    expect(dryRunResult.status).toBe(auditResult.status);

    // Same violation count
    const auditViolations = auditResult.status === 'BLOCK' ? auditResult.violations : [];
    const dryRunViolations = dryRunResult.status === 'BLOCK' ? dryRunResult.violations : [];
    expect(dryRunViolations.length).toBe(auditViolations.length);

    // Same violation kinds (order-independent — both use same sorted order)
    const auditKinds = auditViolations.map((v) => v.kind).sort();
    const dryRunKinds = dryRunViolations.map((v) => v.kind).sort();
    expect(dryRunKinds).toEqual(auditKinds);

    // Both should BLOCK with out_of_scope_symbol for bar
    expect(dryRunResult.status).toBe('BLOCK');
    expect(dryRunViolations.some((v) => v.kind === 'out_of_scope_symbol')).toBe(true);
  });

  it('PASS equivalence: same content produces PASS on both', async () => {
    const { dryRunDeps, auditDiffDeps, snapshotDeps, fs, emitter } = await makeDeps();

    const originalContent = 'function foo() { return 1; }\n';
    const proposedContent = 'function foo() { return 42; }\n';

    await fs.write('src/a.js', enc(originalContent));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    await fs.write('src/a.js', enc(proposedContent));

    emitter.clear();

    const auditResult = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    emitter.clear();

    const dryRunResult = await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: proposedContent }],
      }),
    );

    expect(dryRunResult.status).toBe(auditResult.status);
    expect(dryRunResult.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// DR-11: H13 content-free emission
// ---------------------------------------------------------------------------

describe('DR-11: H13 content-free emission', () => {
  it('all emitted events pass assertEventIsContentFree on PASS and BLOCK paths', async () => {
    const { dryRunDeps, snapshotDeps, fs, emitter } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    // Test PASS path
    emitter.clear();
    await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
      }),
    );

    const passEvents = emitter.getEvents();
    // Should have start + end events for dryRun
    const dryRunEvents = passEvents.filter((e) => e.op === 'dryRun');
    expect(dryRunEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of dryRunEvents) {
      assertEventIsContentFree(event);
    }

    // Test BLOCK path
    emitter.clear();
    await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [
          { file: 'src/a.js', content: 'function foo() {}\nfunction bar() {}\n' },
        ],
      }),
    );

    const blockEvents = emitter.getEvents();
    const dryRunBlockEvents = blockEvents.filter((e) => e.op === 'dryRun');
    expect(dryRunBlockEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of dryRunBlockEvents) {
      assertEventIsContentFree(event);
    }
  });

  it('start event has op=dryRun, phase=start, correct identity fields', async () => {
    const { dryRunDeps, snapshotDeps, fs, emitter } = await makeDeps();

    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapshotRefId = await takeSnapshot(snapshotDeps, manifest);

    emitter.clear();
    await dryRun(
      dryRunDeps,
      makeReq(snapshotRefId, {
        proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 42; }\n' }],
      }),
    );

    const events = emitter.getEvents().filter((e) => e.op === 'dryRun');
    const startEvent = events.find((e) => e.phase === 'start');
    const endEvent = events.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(startEvent?.engineId).toBe('test-engine');
    expect(startEvent?.projectId).toBe('proj-test');
    expect(startEvent?.runId).toBe('run-001');
    expect(startEvent?.correlationId).toBe('corr-001');

    expect(endEvent).toBeDefined();
    expect(endEvent?.classification).toBe('PASS');
    expect(typeof endEvent?.durationMs).toBe('number');
  });
});
