/**
 * tests/operations/validateImports.test.ts — LC2 validateImports targeted test suite.
 *
 * 6 required tests (LC2-1 through LC2-6).
 *
 * Uses:
 *   - createMemFsAdapter()            — in-memory fs (C2)
 *   - createIsomorphicGitVersioning() — real in-memory git (C4)
 *   - createTreeSitterIntelligence()  — real WASM grammars (D3)
 *   - createIsolatedTestStore()       — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()           — in-memory event store (C5)
 *
 * Critical proofs:
 *   LC2-1: valid relative import → PASS
 *   LC2-2: missing file → IMPORT_TARGET_NOT_FOUND
 *   LC2-3: valid file, wrong export → IMPORT_SYMBOL_NOT_EXPORTED + availableExports
 *   LC2-4: alias import (@/foo) → UNCERTAIN with IMPORT_ALIAS_UNRESOLVED
 *   LC2-5: dryRun integration — IMPORT_TARGET_NOT_FOUND surfaces in AuditResult
 *   LC2-6: alias-only violations do NOT cause dryRun BLOCK
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { validateImports } from '../../src/hoplon/operations/validateImports.js';
import type { ValidateImportsDeps } from '../../src/hoplon/operations/validateImports.js';
import { dryRun } from '../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../src/hoplon/operations/dryRun.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type { DryRunRequest } from '../../src/hoplon/contracts/requests.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
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

interface TestHarness {
  validateDeps: ValidateImportsDeps;
  dryRunDeps: DryRunDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  store: SnapshotStore;
}

async function makeHarness(): Promise<TestHarness> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();

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

  const dryRunDeps: DryRunDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    config: {
      fsRoot: FS_ROOT,
      gitRepoDir: GIT_REPO_DIR,
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 5000,
      manifestSchemaVersion: 1,
    },
  };

  // validateDeps will be populated once a snapshot exists — gitRef set below
  const validateDeps: ValidateImportsDeps = {
    versioning,
    codeIntelligence: sharedCI,
    gitRepoDir: GIT_REPO_DIR,
    gitRef: '', // overridden per test after snapshot
  };

  return { validateDeps, dryRunDeps, snapshotDeps, fs, versioning, store };
}

/**
 * Create a real snapshot and return the snapshotRef id + gitRef.
 * gitRef is fetched from the store after creation since SnapshotRef doesn't carry it.
 */
async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  store: SnapshotStore,
  manifest: WritableManifest,
): Promise<{ id: string; gitRef: string }> {
  const result = await createSnapshot(snapshotDeps, { manifest });
  const id = result.snapshotRef.id;
  // gitRef lives on the SnapshotRecord, not on SnapshotRef
  const record = await store.get(id);
  if (!record || !record.gitRef) throw new Error(`Snapshot ${id} has no gitRef after creation`);
  return { id, gitRef: record.gitRef };
}

/** Build a minimal DryRunRequest. */
function makeDryRunReq(
  snapshotRefId: string,
  proposedChanges: Array<{ file: string; content: string }>,
): DryRunRequest {
  return {
    snapshotRefId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    proposedChanges,
  };
}

// ---------------------------------------------------------------------------
// LC2-1: valid relative import → PASS
// ---------------------------------------------------------------------------

describe('LC2-1: valid relative import → PASS', () => {
  it('import from existing file with exported symbol returns PASS', async () => {
    const h = await makeHarness();

    // Seed the filesystem with both files
    await h.fs.write('src/utils.ts', enc('export function helper() { return 42; }\n'));
    await h.fs.write('src/main.ts', enc("import { helper } from './utils';\nfunction main() { helper(); }\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/utils.ts', scope: { kind: 'whole_file' } },
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
      ],
    };

    const { gitRef } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const deps: ValidateImportsDeps = {
      versioning: h.versioning,
      codeIntelligence: sharedCI,
      gitRepoDir: GIT_REPO_DIR,
      gitRef,
    };

    const result = await validateImports(deps, [
      { file: 'src/main.ts', content: "import { helper } from './utils';\nfunction main() { helper(); }\n" },
    ]);

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC2-2: missing file → IMPORT_TARGET_NOT_FOUND
// ---------------------------------------------------------------------------

describe('LC2-2: missing file → IMPORT_TARGET_NOT_FOUND', () => {
  it('import from non-existent file returns IMPORT_TARGET_NOT_FOUND violation', async () => {
    const h = await makeHarness();

    await h.fs.write('src/main.ts', enc("import { foo } from './nonexistent';\nfunction main() {}\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/main.ts', scope: { kind: 'whole_file' } }],
    };

    const { gitRef } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const deps: ValidateImportsDeps = {
      versioning: h.versioning,
      codeIntelligence: sharedCI,
      gitRepoDir: GIT_REPO_DIR,
      gitRef,
    };

    const result = await validateImports(deps, [
      { file: 'src/main.ts', content: "import { foo } from './nonexistent';\nfunction main() {}\n" },
    ]);

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('IMPORT_TARGET_NOT_FOUND');
    if (result.violations[0].kind === 'IMPORT_TARGET_NOT_FOUND') {
      expect(result.violations[0].importPath).toBe('./nonexistent');
      expect(result.violations[0].fromFile).toBe('src/main.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// LC2-3: valid file, wrong export → IMPORT_SYMBOL_NOT_EXPORTED + availableExports
// ---------------------------------------------------------------------------

describe('LC2-3: valid file but wrong export → IMPORT_SYMBOL_NOT_EXPORTED', () => {
  it('importing a symbol that does not exist in the target returns IMPORT_SYMBOL_NOT_EXPORTED with availableExports', async () => {
    const h = await makeHarness();

    // utils.ts exports 'helper' but not 'missing'
    await h.fs.write('src/utils.ts', enc('export function helper() { return 42; }\n'));
    await h.fs.write('src/main.ts', enc("import { missing } from './utils';\nfunction main() {}\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/utils.ts', scope: { kind: 'whole_file' } },
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
      ],
    };

    const { gitRef } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const deps: ValidateImportsDeps = {
      versioning: h.versioning,
      codeIntelligence: sharedCI,
      gitRepoDir: GIT_REPO_DIR,
      gitRef,
    };

    const result = await validateImports(deps, [
      { file: 'src/main.ts', content: "import { missing } from './utils.ts';\nfunction main() {}\n" },
    ]);

    expect(result.status).toBe('BLOCK');
    const violation = result.violations.find((v) => v.kind === 'IMPORT_SYMBOL_NOT_EXPORTED');
    expect(violation).toBeDefined();
    if (violation?.kind === 'IMPORT_SYMBOL_NOT_EXPORTED') {
      expect(violation.symbol).toBe('missing');
      expect(violation.availableExports).toContain('helper');
    }
  });
});

// ---------------------------------------------------------------------------
// LC2-4: alias import (@/foo) → UNCERTAIN with deferral note
// ---------------------------------------------------------------------------

describe('LC2-4: alias import → UNCERTAIN with IMPORT_ALIAS_UNRESOLVED', () => {
  it('import with @ prefix returns UNCERTAIN and IMPORT_ALIAS_UNRESOLVED violation', async () => {
    const h = await makeHarness();

    await h.fs.write('src/main.ts', enc("import { Foo } from '@/components/Foo';\nfunction main() {}\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/main.ts', scope: { kind: 'whole_file' } }],
    };

    const { gitRef } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const deps: ValidateImportsDeps = {
      versioning: h.versioning,
      codeIntelligence: sharedCI,
      gitRepoDir: GIT_REPO_DIR,
      gitRef,
    };

    const result = await validateImports(deps, [
      { file: 'src/main.ts', content: "import { Foo } from '@/components/Foo';\nfunction main() {}\n" },
    ]);

    expect(result.status).toBe('UNCERTAIN');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('IMPORT_ALIAS_UNRESOLVED');
    if (result.violations[0].kind === 'IMPORT_ALIAS_UNRESOLVED') {
      expect(result.violations[0].importPath).toBe('@/components/Foo');
      expect(result.violations[0].note).toContain('deferred');
    }
  });
});

// ---------------------------------------------------------------------------
// LC2-5: dryRun integration — IMPORT_TARGET_NOT_FOUND surfaces in AuditResult
// ---------------------------------------------------------------------------

describe('LC2-5: dryRun integration — import check wired after scope check', () => {
  it('dryRun returns BLOCK when proposed change has import to missing file', async () => {
    const h = await makeHarness();

    // Seed only the importing file — the imported file does NOT exist
    await h.fs.write('src/main.ts', enc("function main() {}\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/main.ts', scope: { kind: 'whole_file' } }],
    };

    const { id: snapshotRefId } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const result = await dryRun(
      h.dryRunDeps,
      makeDryRunReq(snapshotRefId, [
        {
          file: 'src/main.ts',
          // Now proposes importing from a file that doesn't exist in the snapshot
          content: "import { foo } from './missing';\nfunction main() { foo(); }\n",
        },
      ]),
    );

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const importViolation = result.violations.find(
        (v) => v.kind === 'IMPORT_TARGET_NOT_FOUND',
      );
      expect(importViolation).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// LC2-6: alias-only violations do NOT cause dryRun BLOCK
// ---------------------------------------------------------------------------

describe('LC2-6: alias imports are advisory — do not block dryRun', () => {
  it('dryRun returns PASS when only alias imports are present (no hard violations)', async () => {
    const h = await makeHarness();

    await h.fs.write('src/main.ts', enc("function main() {}\n"));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/main.ts', scope: { kind: 'whole_file' } }],
    };

    const { id: snapshotRefId } = await takeSnapshot(h.snapshotDeps, h.store, manifest);

    const result = await dryRun(
      h.dryRunDeps,
      makeDryRunReq(snapshotRefId, [
        {
          file: 'src/main.ts',
          // Only has alias import — advisory, not a hard block
          content: "import { Foo } from '@/components/Foo';\nfunction main() {}\n",
        },
      ]),
    );

    // Alias-only violations must not flip dryRun to BLOCK
    expect(result.status).toBe('PASS');
  });
});
