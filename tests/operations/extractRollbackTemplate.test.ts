/**
 * tests/operations/extractRollbackTemplate.test.ts — LC11 targeted test suite.
 *
 * Proof requirements:
 *  ERT-1  Post-revert call returns template matching reverted file structure
 *  ERT-2  injectionHint is always non-empty (LC11-H1 invariant)
 *  ERT-3  LC4 composition correct — structuralSkeleton matches extractStructuralTemplate output
 *  ERT-4  files in result are sorted alphabetically (H7 determinism)
 *  ERT-5  snapshotRef matches the requested snapshotRefId
 *  ERT-6  generatedAt is a non-empty ISO 8601 string
 *  ERT-7  contractedChangesMap values appear in contractedChanges when provided
 *  ERT-8  Default contractedChanges is non-empty when map entry absent
 *  ERT-9  H13: emitted events contain no source content (structure only)
 *  ERT-10 Invalid request (empty files array) → ValidationError thrown
 *  ERT-11 Missing snapshotRefId → ValidationError thrown (required field)
 *  ERT-12 snapshot_missing → SemanticError propagated from LC4 composition
 *  ERT-13 Round-trip: same files as extractStructuralTemplate on same snapshot
 *
 * Uses:
 *   - createMemFsAdapter()             — in-memory fs (C2)
 *   - createTreeSitterIntelligence()   — real WASM grammars (D3)
 *   - createMemoryEmitter()            — in-memory event store (C5)
 *   - createIsomorphicGitVersioning()  — real in-memory git (C4)
 *   - createIsolatedTestStore()        — in-memory SQLite (C1)
 *   - createSnapshot()                 — D1, to build the snapshot used in tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  extractRollbackTemplate,
  DEFAULT_INJECTION_HINT,
} from '../../src/hoplon/operations/extractRollbackTemplate.js';
import type { ExtractRollbackTemplateDeps } from '../../src/hoplon/operations/extractRollbackTemplate.js';
import {
  extractStructuralTemplate,
} from '../../src/hoplon/operations/extractStructuralTemplate.js';
import type { ExtractStructuralTemplateDeps } from '../../src/hoplon/operations/extractStructuralTemplate.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { ValidationError, SemanticError } from '../../src/hoplon/contracts/errors.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';

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

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/**
 * Build a snapshot from a given file set and return the snapshotRefId plus
 * all the plumbing adapters so tests can verify rollback template behavior.
 */
async function buildSnapshot(files: Record<string, string>): Promise<{
  snapshotRefId: string;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: ReturnType<typeof createIsomorphicGitVersioning>;
  store: SnapshotStore;
  emitter: ReturnType<typeof createMemoryEmitter>;
  projectId: string;
  runId: string;
}> {
  const projectId = 'proj-ert-test';
  const runId = 'run-ert-001';
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const store = await createIsolatedTestStore();
  const lock = createAsyncMutexLockProvider();
  const emitter = createMemoryEmitter();
  const secretScanner = createBuiltinRegexScanner();

  // Write all files to the in-memory FS.
  for (const [path, content] of Object.entries(files)) {
    await fs.write(path, enc(content));
  }

  const manifest: WritableManifest = {
    manifestSchemaVersion: 1,
    projectId,
    runId,
    correlationId: 'corr-ert-setup',
    entries: Object.keys(files).map((path) => ({
      path,
      scope: { kind: 'whole_file' },
    })),
  };

  const createSnapshotDeps: CreateSnapshotDeps = {
    fs,
    versioning,
    snapshotStore: store,
    lockProvider: lock,
    emitter,
    secretScanner,
    engineId: 'test-ert-engine',
    config: {
      gitRepoDir: GIT_REPO_DIR,
      fsRoot: FS_ROOT,
      manifestStorageMode: 'inline',
      ttlRetentionMs: 0,
    },
  };

  const snapResult = await createSnapshot(createSnapshotDeps, { manifest });
  return {
    snapshotRefId: snapResult.snapshotRef.id,
    fs,
    versioning,
    store,
    emitter,
    projectId,
    runId,
  };
}

function makeRollbackDeps(
  fs: ReturnType<typeof createMemFsAdapter>,
  versioning: ReturnType<typeof createIsomorphicGitVersioning>,
  store: SnapshotStore,
): {
  deps: ExtractRollbackTemplateDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  const deps: ExtractRollbackTemplateDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-ert-engine',
    root: FS_ROOT,
    config: {
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 5000,
      gitRepoDir: GIT_REPO_DIR,
    },
  };
  return { deps, emitter };
}

// ---------------------------------------------------------------------------
// ERT-1: Post-revert call returns template matching reverted file structure
// ---------------------------------------------------------------------------

describe('ERT-1: post-revert template matches reverted file structure', () => {
  it('returns non-empty files with structuralSkeleton containing snapshot-time exports', async () => {
    const src = 'export function processPayment(amount: number): boolean { return true; }';
    const FILE = 'src/payment.ts';

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({ [FILE]: src });

    // Simulate a post-revert scenario: overwrite the live file with broken content.
    await fs.write(FILE, enc('// corrupted by failed agent edit'));

    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-001',
      correlationId: 'corr-ert-001',
      snapshotRefId,
      files: [FILE],
    });

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe(FILE);

    // The skeleton must reflect the snapshot-time content (processPayment, not corruption).
    expect(file.structuralSkeleton).toContain('processPayment');
    expect(file.structuralSkeleton).not.toBe('');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-2: injectionHint is always non-empty (LC11-H1 invariant)
// ---------------------------------------------------------------------------

describe('ERT-2: injectionHint is always non-empty', () => {
  it('every file entry has a non-empty injectionHint', async () => {
    const files = {
      'src/a.ts': 'export function foo(): void {}',
      'src/b.ts': 'export function bar(): void {}',
    };

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot(files);
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-002',
      correlationId: 'corr-ert-002',
      snapshotRefId,
      files: Object.keys(files),
    });

    for (const f of result.files) {
      expect(f.injectionHint.length).toBeGreaterThan(0);
      expect(f.injectionHint).toBe(DEFAULT_INJECTION_HINT);
    }
  }, 30_000);

  it('DEFAULT_INJECTION_HINT is non-empty', () => {
    expect(DEFAULT_INJECTION_HINT.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ERT-3: LC4 composition correct — round-trips same files/exports as extractStructuralTemplate
// ---------------------------------------------------------------------------

describe('ERT-3: LC4 composition correct — structuralSkeleton matches extractStructuralTemplate', () => {
  it('skeleton contains same export names as extractStructuralTemplate on same snapshot', async () => {
    const src = [
      'export function alpha(): void {}',
      'export function beta(x: number): number { return x; }',
      'export class Gamma {}',
    ].join('\n');
    const FILE = 'src/exports.ts';

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({ [FILE]: src });

    // Run extractStructuralTemplate (LC4) directly to get the ground truth.
    const estDeps: ExtractStructuralTemplateDeps = {
      fs,
      versioning,
      snapshotStore: store,
      codeIntelligence: sharedCI,
      emitter: createMemoryEmitter(),
      engineId: 'test-ert-engine',
      root: FS_ROOT,
      config: {
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        gitRepoDir: GIT_REPO_DIR,
      },
    };

    const structuralTemplate = await extractStructuralTemplate(estDeps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-003',
      correlationId: 'corr-ert-003a',
      files: [FILE],
      snapshotRefId,
    });

    const estExportNames = structuralTemplate.files[0]?.exports.map((e) => e.name) ?? [];
    expect(estExportNames).toContain('alpha');
    expect(estExportNames).toContain('beta');
    expect(estExportNames).toContain('Gamma');

    // Run extractRollbackTemplate (LC11) and verify skeleton contains the same names.
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const rollbackResult = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-003',
      correlationId: 'corr-ert-003b',
      snapshotRefId,
      files: [FILE],
    });

    const skeleton = rollbackResult.files[0]?.structuralSkeleton ?? '';
    // Each export name from LC4 should appear in the LC11 skeleton string.
    for (const name of estExportNames) {
      expect(skeleton).toContain(name);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-4: files in result are sorted alphabetically (H7 determinism)
// ---------------------------------------------------------------------------

describe('ERT-4: files sorted alphabetically', () => {
  it('returns files in alphabetical order regardless of request order', async () => {
    const files = {
      'src/z.ts': 'export function zeta(): void {}',
      'src/a.ts': 'export function alpha(): void {}',
      'src/m.ts': 'export function mu(): void {}',
    };

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot(files);
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-004',
      correlationId: 'corr-ert-004',
      snapshotRefId,
      files: ['src/z.ts', 'src/a.ts', 'src/m.ts'],
    });

    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-5: snapshotRef in result matches the requested snapshotRefId
// ---------------------------------------------------------------------------

describe('ERT-5: snapshotRef matches requested snapshotRefId', () => {
  it('result.snapshotRef equals the snapshotRefId from the request', async () => {
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-005',
      correlationId: 'corr-ert-005',
      snapshotRefId,
      files: ['src/a.ts'],
    });

    expect(result.snapshotRef).toBe(snapshotRefId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-6: generatedAt is a non-empty ISO 8601 string
// ---------------------------------------------------------------------------

describe('ERT-6: generatedAt is a non-empty ISO 8601 string', () => {
  it('generatedAt is a valid ISO 8601 timestamp', async () => {
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-006',
      correlationId: 'corr-ert-006',
      snapshotRefId,
      files: ['src/a.ts'],
    });

    expect(result.generatedAt.length).toBeGreaterThan(0);
    // Must parse as a valid date.
    const parsed = new Date(result.generatedAt);
    expect(parsed.getTime()).not.toBeNaN();
    // Must be a recent timestamp (within the last minute).
    expect(Date.now() - parsed.getTime()).toBeLessThan(60_000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-7: contractedChangesMap values appear in contractedChanges when provided
// ---------------------------------------------------------------------------

describe('ERT-7: contractedChangesMap drives contractedChanges field', () => {
  it('contractedChanges matches the map value when provided', async () => {
    const FILE = 'src/billing.ts';
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      [FILE]: 'export function chargeCard(amount: number): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const customDescription = 'Modify symbol: chargeCard; add amount validation';

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-007',
      correlationId: 'corr-ert-007',
      snapshotRefId,
      files: [FILE],
      contractedChangesMap: { [FILE]: customDescription },
    });

    expect(result.files[0]?.contractedChanges).toBe(customDescription);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-8: Default contractedChanges is non-empty when map entry absent
// ---------------------------------------------------------------------------

describe('ERT-8: default contractedChanges is non-empty', () => {
  it('contractedChanges is non-empty when contractedChangesMap is not provided', async () => {
    const FILE = 'src/auth.ts';
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      [FILE]: 'export function login(user: string): boolean { return true; }',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-008',
      correlationId: 'corr-ert-008',
      snapshotRefId,
      files: [FILE],
      // No contractedChangesMap
    });

    const contractedChanges = result.files[0]?.contractedChanges ?? '';
    expect(contractedChanges.length).toBeGreaterThan(0);
  }, 30_000);

  it('contractedChanges falls back to default for files not in the map', async () => {
    const FILES = { 'src/a.ts': 'export function a(): void {}', 'src/b.ts': 'export function b(): void {}' };
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot(FILES);
    const { deps } = makeRollbackDeps(fs, versioning, store);

    // Only provide map for src/a.ts; src/b.ts gets default.
    const result = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-008b',
      correlationId: 'corr-ert-008b',
      snapshotRefId,
      files: ['src/a.ts', 'src/b.ts'],
      contractedChangesMap: { 'src/a.ts': 'Modify function a' },
    });

    const aFile = result.files.find((f) => f.path === 'src/a.ts');
    const bFile = result.files.find((f) => f.path === 'src/b.ts');

    expect(aFile?.contractedChanges).toBe('Modify function a');
    expect(bFile?.contractedChanges.length).toBeGreaterThan(0);
    expect(bFile?.contractedChanges).not.toBe('Modify function a');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-9: H13 — emitted events contain no source content
// ---------------------------------------------------------------------------

describe('ERT-9: H13 — events contain no source content', () => {
  it('all emitted events pass content-free assertion', async () => {
    const src = [
      `import { resolve } from 'node:path';`,
      'export const SECRET_VALUE = "do-not-leak";',
      'export interface Config { apiKey: string; }',
    ].join('\n');
    const FILE = 'src/sensitive.ts';

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({ [FILE]: src });
    const { deps, emitter } = makeRollbackDeps(fs, versioning, store);

    await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-009',
      correlationId: 'corr-ert-009',
      snapshotRefId,
      files: [FILE],
    });

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      assertEventIsContentFree(event);
    }
  }, 30_000);

  it('start and end events have correct op and phase for extractRollbackTemplate', async () => {
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps, emitter } = makeRollbackDeps(fs, versioning, store);

    await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-009b',
      correlationId: 'corr-ert-009b',
      snapshotRefId,
      files: ['src/a.ts'],
    });

    const ertEvents = emitter.getEvents().filter((e) => e.op === 'extractRollbackTemplate');
    const startEvent = ertEvents.find((e) => e.phase === 'start');
    const endEvent = ertEvents.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(startEvent?.op).toBe('extractRollbackTemplate');
    expect(endEvent).toBeDefined();
    expect(endEvent?.op).toBe('extractRollbackTemplate');
    expect(endEvent?.classification).toBe('PASS');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-10: Invalid request (empty files array) → ValidationError thrown
// ---------------------------------------------------------------------------

describe('ERT-10: invalid request throws ValidationError', () => {
  it('throws ValidationError when files array is empty', async () => {
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    await expect(
      extractRollbackTemplate(deps, {
        projectId: 'proj-ert-test',
        runId: 'run-ert-010',
        correlationId: 'corr-ert-010',
        snapshotRefId,
        files: [],
      }),
    ).rejects.toThrow(ValidationError);
  }, 30_000);

  it('throws ValidationError when projectId is missing', async () => {
    const { snapshotRefId, fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    await expect(
      extractRollbackTemplate(
        deps,
        // @ts-expect-error — deliberately invalid shape
        {
          runId: 'run-ert-010b',
          correlationId: 'corr-ert-010b',
          snapshotRefId,
          files: ['src/a.ts'],
        },
      ),
    ).rejects.toThrow(ValidationError);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-11: Missing snapshotRefId → ValidationError thrown (required field)
// ---------------------------------------------------------------------------

describe('ERT-11: missing snapshotRefId throws ValidationError', () => {
  it('throws ValidationError when snapshotRefId is absent', async () => {
    const { fs, versioning, store } = await buildSnapshot({
      'src/a.ts': 'export function foo(): void {}',
    });
    const { deps } = makeRollbackDeps(fs, versioning, store);

    await expect(
      extractRollbackTemplate(
        deps,
        // @ts-expect-error — deliberately omitting required field
        {
          projectId: 'proj-ert-test',
          runId: 'run-ert-011',
          correlationId: 'corr-ert-011',
          files: ['src/a.ts'],
        },
      ),
    ).rejects.toThrow(ValidationError);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-12: Unknown snapshotRefId → SemanticError propagated from LC4
// ---------------------------------------------------------------------------

describe('ERT-12: unknown snapshotRefId propagates SemanticError from LC4', () => {
  it('throws SemanticError when snapshotRefId does not exist in store', async () => {
    // Use a fresh empty store — no snapshots committed.
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const store = await createIsolatedTestStore();
    const { deps } = makeRollbackDeps(fs, versioning, store);

    await expect(
      extractRollbackTemplate(deps, {
        projectId: 'proj-ert-test',
        runId: 'run-ert-012',
        correlationId: 'corr-ert-012',
        snapshotRefId: 'nonexistent-snapshot-id',
        files: ['src/a.ts'],
      }),
    ).rejects.toThrow(SemanticError);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ERT-13: Round-trip — same files/exports as extractStructuralTemplate on same snapshot
// ---------------------------------------------------------------------------

describe('ERT-13: round-trip — files consistent with extractStructuralTemplate on same snapshot', () => {
  it('extractRollbackTemplate and extractStructuralTemplate return the same file paths', async () => {
    const files = {
      'src/alpha.ts': 'export function alpha(): string { return "a"; }',
      'src/beta.ts': 'export class Beta { run(): void {} }',
    };

    const { snapshotRefId, fs, versioning, store } = await buildSnapshot(files);

    // Run LC4 directly.
    const estDeps: ExtractStructuralTemplateDeps = {
      fs,
      versioning,
      snapshotStore: store,
      codeIntelligence: sharedCI,
      emitter: createMemoryEmitter(),
      engineId: 'test-ert-engine',
      root: FS_ROOT,
      config: {
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        gitRepoDir: GIT_REPO_DIR,
      },
    };

    const structuralResult = await extractStructuralTemplate(estDeps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-013',
      correlationId: 'corr-ert-013a',
      files: Object.keys(files),
      snapshotRefId,
    });

    // Run LC11.
    const { deps } = makeRollbackDeps(fs, versioning, store);
    const rollbackResult = await extractRollbackTemplate(deps, {
      projectId: 'proj-ert-test',
      runId: 'run-ert-013',
      correlationId: 'corr-ert-013b',
      snapshotRefId,
      files: Object.keys(files),
    });

    // Both should return the same file paths (sorted).
    const estPaths = structuralResult.files.map((f) => f.path);
    const ertPaths = rollbackResult.files.map((f) => f.path);
    expect(ertPaths).toEqual(estPaths);

    // Verify that each export name from LC4 appears in the LC11 skeleton.
    for (const estFile of structuralResult.files) {
      const ertFile = rollbackResult.files.find((f) => f.path === estFile.path);
      expect(ertFile).toBeDefined();
      if (ertFile) {
        for (const exp of estFile.exports) {
          expect(ertFile.structuralSkeleton).toContain(exp.name);
        }
      }
    }
  }, 30_000);
});
