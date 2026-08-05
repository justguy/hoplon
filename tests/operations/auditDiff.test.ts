/**
 * tests/operations/auditDiff.test.ts — D5 auditDiff targeted test suite.
 *
 * Uses:
 *   - createMemFsAdapter()          — in-memory fs (C2)
 *   - createTreeSitterIntelligence() — real WASM grammars (D3)
 *   - createIsolatedTestStore()     — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()         — in-memory event store (C5)
 *   - assertEventIsContentFree()    — H13 content-free assertion (C5)
 *
 * 25 required tests per D5 spec.
 * Requires vendor/grammars/ to be populated.
 * Run: node scripts/fetch-grammars.js (once after npm install).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import { ValidationError, SemanticError } from '../../src/hoplon/contracts/errors.js';
import type { AuditRequest } from '../../src/hoplon/contracts/requests.js';
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

/** Build default deps with a fresh fs, store, and emitter per test. */
async function makeDeps(opts?: {
  ci?: CodeIntelligenceAdapter;
  maxFileBytes?: number;
  parseTimeoutMs?: number;
  snapshotStore?: SnapshotStore;
}): Promise<{
  deps: AuditDiffDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());

  const deps: AuditDiffDeps = {
    fs,
    // Seeded snapshots carry gitRef: null → empty baseline (documented
    // hcr-002 fallback), so the legacy current-state expectations in this
    // suite are unchanged. A fake non-null gitRef would now fail closed as a
    // repo/store desync (hcr-009) instead of degrading to an empty baseline.
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    codeIntelligence: opts?.ci ?? sharedCI,
    emitter,
    engineId: 'test-engine',
    config: {
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
      maxFileBytes: opts?.maxFileBytes ?? 1024 * 1024,
      parseTimeoutMs: opts?.parseTimeoutMs ?? 5000,
      manifestSchemaVersion: 1,
    },
  };
  return { deps, fs, emitter, store };
}

/** Default manifest used for seedSnapshot when no manifest is provided. */
function makeDefaultManifest(opts: {
  projectId?: string;
  runId?: string;
}): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
  };
}

/** Build a committed snapshot record, inline it into the store, and return the id. */
async function seedSnapshot(
  store: SnapshotStore,
  opts: {
    projectId?: string;
    runId?: string;
    status?: 'pending' | 'committed' | 'failed';
    manifestSchemaVersion?: number;
    manifest?: WritableManifest | null;
  } = {},
): Promise<string> {
  const manifest: WritableManifest =
    opts.manifest !== undefined && opts.manifest !== null
      ? opts.manifest
      : makeDefaultManifest({
          ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
          ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        });

  // Compute id using hashManifest (H1 — 64 hex chars)
  const id = opts.manifest != null ? hashManifest(opts.manifest) : hashManifest(manifest);

  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: opts.manifestSchemaVersion ?? 1,
    engineId: 'test-engine',
    projectId: opts.projectId ?? 'proj-test',
    runId: opts.runId ?? 'run-001',
    correlationId: 'corr-seed',
    status: opts.status ?? 'committed',
    statusReason: opts.status === 'failed' ? 'test failure' : null,
    // null → empty-baseline fallback; a fake ref would fail closed (hcr-009).
    gitRef: null,
    manifest: opts.manifest !== undefined ? opts.manifest : manifest,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };

  await store.put(record);
  return id;
}

/** Build a minimal AuditRequest, using the default manifest's hash as snapshotRefId. */
function makeReq(overrides: Partial<AuditRequest> = {}): AuditRequest {
  // Default snapshotRefId is hash of the default manifest (matches seedSnapshot default)
  const defaultManifest = makeDefaultManifest({});
  const defaultId = hashManifest(defaultManifest);
  return {
    snapshotRefId: defaultId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    files: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core PASS / BLOCK
// ---------------------------------------------------------------------------

describe('D5 — T1: in-scope edit → PASS', () => {
  it('modifying an in-scope symbol body produces PASS, checked=1', async () => {
    const { deps, fs, store } = await makeDeps();

    // Seed snapshot with foo in scope
    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Write "modified" version of foo
    await fs.write('src/a.js', enc('function foo() { return 42; }\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.status).toBe('PASS');
    if (result.status === 'PASS') {
      expect(result.checked).toBe(1);
    }
    expect(result.auditSchemaVersion).toBe(1);
    expect(result.correlationId).toBe('corr-001');
  });
});

describe('D5 — T2: out-of-scope new symbol → BLOCK', () => {
  it('adding bar (not in manifest scope) produces BLOCK with out_of_scope_symbol for bar', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Add bar alongside foo — bar is out of scope
    await fs.write('src/a.js', enc('function foo() {}\nfunction bar() {}\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.correction).toBeTruthy();
        expect(v.message).toBeTruthy();
        expect(v.correction).not.toBe(v.message);
      }
    }
  });
});

describe('D5 — T3: file outside manifest → BLOCK', () => {
  it('auditing a file not in manifest produces uncontracted_file violation', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    await fs.write('src/b.js', enc('function baz() {}\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/b.js'] }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('uncontracted_file');
      if (v.kind === 'uncontracted_file') {
        expect(v.path).toBe('src/b.js');
        expect(v.correction).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AS-1 rename
// ---------------------------------------------------------------------------

describe('D5 — T4: AS-1 rename → BLOCK on new symbol name', () => {
  it('renaming foo to bar produces BLOCK with out_of_scope_symbol for bar (not foo)', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Rename: foo is gone, bar is new
    await fs.write('src/a.js', enc('function bar() {}\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      // Only bar should be a violation — foo deletion is implicitly permitted (AS-1 simplification)
      const barViolation = result.violations.find(
        (v) => v.kind === 'out_of_scope_symbol' && v.kind === 'out_of_scope_symbol' && (v as { symbolName?: string }).symbolName === 'bar',
      );
      expect(barViolation).toBeDefined();

      // There should NOT be a violation for 'foo' (deleted in-scope symbol is permitted)
      const fooViolation = result.violations.find(
        (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName?: string }).symbolName === 'foo',
      );
      expect(fooViolation).toBeUndefined();

      // Correction must be present
      if (barViolation && barViolation.kind === 'out_of_scope_symbol') {
        expect(barViolation.correction).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AS-2 cross-project/run replay
// ---------------------------------------------------------------------------

describe('D5 — T5: AS-2 snapshot from project A used under project B', () => {
  it('throws SemanticError({ kind: "project_id_mismatch" }), no file reads', async () => {
    const mockFs = {
      read: async (_path: string): Promise<Uint8Array> => {
        throw new Error('fs.read should NOT be called');
      },
      write: async () => {},
      stat: async () => ({ exists: false, size: 0 }),
      mkdir: async () => {},
      readdir: async () => [],
      unlink: async () => {},
      exists: async () => false,
    };

    const { deps, store } = await makeDeps();
    // Override fs with the mock that fails on read
    const depsWithMockFs: AuditDiffDeps = { ...deps, fs: mockFs as unknown as typeof deps.fs };

    // Seed snapshot for project-A
    const snapId = await seedSnapshot(store, {
      projectId: 'project-A',
      runId: 'run-001',
    });

    // Request audit under project-B using the same snapshot ref
    await expect(
      auditDiff(depsWithMockFs, makeReq({
        snapshotRefId: snapId,
        projectId: 'project-B',
        files: ['src/a.js'],
      })),
    ).rejects.toThrow(SemanticError);

    await expect(
      auditDiff(depsWithMockFs, makeReq({
        snapshotRefId: snapId,
        projectId: 'project-B',
        files: ['src/a.js'],
      })),
    ).rejects.toMatchObject({ kind: 'project_id_mismatch' });
  });
});

describe('D5 — T6: AS-2 snapshot from run X used under run Y', () => {
  it('throws SemanticError({ kind: "run_id_mismatch" })', async () => {
    const { deps, store } = await makeDeps();

    // Seed snapshot for run-X
    const snapId = await seedSnapshot(store, {
      projectId: 'proj-test',
      runId: 'run-X',
    });

    // Request under run-Y — same snapshot ref, different run
    await expect(
      auditDiff(deps, makeReq({ snapshotRefId: snapId, runId: 'run-Y', files: ['src/a.js'] })),
    ).rejects.toMatchObject({ kind: 'run_id_mismatch' });
  });
});

describe('D5 — T7: AS-2 snapshot with status "pending"', () => {
  it('throws SemanticError({ kind: "snapshot_not_committed" })', async () => {
    const { deps, store } = await makeDeps();

    await seedSnapshot(store, {
      status: 'pending',
    });

    await expect(
      auditDiff(deps, makeReq({ files: ['src/a.js'] })),
    ).rejects.toMatchObject({ kind: 'snapshot_not_committed' });
  });
});

describe('D5 — T8: AS-2 bogus snapshot id', () => {
  it('throws SemanticError({ kind: "snapshot_missing" })', async () => {
    const { deps } = await makeDeps();
    // No snapshot seeded

    await expect(
      auditDiff(deps, makeReq({ snapshotRefId: 'bogus-id-that-does-not-exist', files: [] })),
    ).rejects.toMatchObject({ kind: 'snapshot_missing' });
  });
});

// ---------------------------------------------------------------------------
// AS-3 per-file parse failure
// ---------------------------------------------------------------------------

describe('D5 — T9: AS-3 broken syntax file → parse_failure violation, audit continues', () => {
  it('parse failure yields BLOCK with one violation, does not crash the call', async () => {
    // For T9: test that parse failure is contained to one file.
    // We use file_too_large to reliably trigger parse failure for one file while
    // the other file passes. Tree-sitter is error-resilient and won't throw on
    // broken syntax — file_too_large is a deterministic failure path.
    const { deps, fs, store } = await makeDeps({ maxFileBytes: 100 });

    const twoFileManifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/big.js', scope: { kind: 'symbols', symbols: ['foo'] } },
        { path: 'src/good.js', scope: { kind: 'symbols', symbols: ['bar'] } },
      ],
    };
    const snapId = await seedSnapshot(store, { manifest: twoFileManifest });

    // big.js exceeds maxFileBytes → parse_failure
    await fs.write('src/big.js', enc('x'.repeat(200)));
    // good.js is fine and in-scope → no violation
    await fs.write('src/good.js', enc('function bar() {}\n'));

    const result = await auditDiff(deps, makeReq({
      snapshotRefId: snapId,
      files: ['src/big.js', 'src/good.js'],
    }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      // Only one violation — for big.js
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('parse_failure');
      if (v.kind === 'parse_failure') {
        expect(v.path).toBe('src/big.js');
        expect(v.parseError).toBe('file_too_large');
      }
    }
  });
});

describe('D5 — T10: AS-3 unsupported extension → parse_failure(unsupported_extension)', () => {
  it('auditing a .rb file produces parse_failure with unsupported_extension', async () => {
    const { deps, fs, store } = await makeDeps();

    const rbManifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/script.rb', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const snapId = await seedSnapshot(store, { manifest: rbManifest });

    await fs.write('src/script.rb', enc('def foo; end\n'));

    const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/script.rb'] }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('parse_failure');
      if (v.kind === 'parse_failure') {
        expect(v.parseError).toBe('unsupported_extension');
        expect(v.path).toBe('src/script.rb');
        expect(v.nodeKind).toBeNull();
      }
    }
  });
});

describe('D5 — T11: AS-3 file too large → parse_failure(file_too_large)', () => {
  it('file exceeding maxFileBytes produces parse_failure with file_too_large', async () => {
    const { deps, fs, store } = await makeDeps({ maxFileBytes: 50 });

    const bigManifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/big.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const snapId = await seedSnapshot(store, { manifest: bigManifest });

    // Write file larger than maxFileBytes
    await fs.write('src/big.js', enc('function foo() {}\n' + 'x'.repeat(100)));

    const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/big.js'] }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const v = result.violations[0]!;
      expect(v.kind).toBe('parse_failure');
      if (v.kind === 'parse_failure') {
        expect(v.parseError).toBe('file_too_large');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// H8 schema version
// ---------------------------------------------------------------------------

describe('D5 — T12: snapshot manifestSchemaVersion=2 → SemanticError(manifest_version_mismatch)', () => {
  it('rejects a future-version snapshot', async () => {
    const { deps, store } = await makeDeps();

    // Use the default manifest to derive a valid id (64 hex chars), but override
    // the manifestSchemaVersion column to 2 to simulate a future-version snapshot.
    const v2Manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const snapId = hashManifest(v2Manifest);

    const record: SnapshotRecord = {
      id: snapId,
      manifestSchemaVersion: 2, // Future version — should be rejected by H8 check
      engineId: 'test-engine',
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      status: 'committed',
      statusReason: null,
      gitRef: 'abc123',
      manifest: v2Manifest,
      createdAt: new Date().toISOString(),
      ttlExpires: null,
      replicaIds: [],
    };
    await store.put(record);

    await expect(
      auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/a.js'] })),
    ).rejects.toMatchObject({ kind: 'manifest_version_mismatch' });
  });
});

// ---------------------------------------------------------------------------
// Audit semantic shape
// ---------------------------------------------------------------------------

describe('D5 — T13: whole_file scope, any change → PASS', () => {
  it('extensive changes to a whole_file scoped entry produce PASS', async () => {
    const { deps, fs, store } = await makeDeps();

    const wholeFileManifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'whole_file' } }],
    };
    const snapId = await seedSnapshot(store, { manifest: wholeFileManifest });

    // Write completely different content — should be accepted (whole_file scope)
    await fs.write('src/a.js', enc(`
      function completely_new() {}
      class AlsoNew {}
    `));

    const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/a.js'] }));
    expect(result.status).toBe('PASS');
  });
});

describe('D5 — T14: reformatter pass → PASS (audit by structural shape, not formatting)', () => {
  it('adding/removing whitespace and comments without structural changes produces PASS', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Reformatted: extra blank lines, changed spacing, added comments
    // — same structural symbol 'foo' is still there
    await fs.write('src/a.js', enc(`
// This is a comment
function foo(  ) {
  // Inner comment
  return    42 ;
}
`));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    expect(result.status).toBe('PASS');
  });
});

describe('D5 — T15: multiple files — some PASS, some BLOCK', () => {
  it('3 files: one in-scope, one out-of-scope, one parse failure → BLOCK with 2 violations', async () => {
    const { deps, fs, store } = await makeDeps({ maxFileBytes: 50 });

    const multiManifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/good.js', scope: { kind: 'symbols', symbols: ['foo'] } },
        { path: 'src/bad.js', scope: { kind: 'symbols', symbols: ['foo'] } },
        { path: 'src/big.js', scope: { kind: 'symbols', symbols: ['foo'] } },
      ],
    };
    const snapId = await seedSnapshot(store, { manifest: multiManifest });

    // good.js — in-scope edit of foo → no violation
    await fs.write('src/good.js', enc('function foo() { return 42; }\n'));

    // bad.js — adds 'bar' out of scope → violation
    await fs.write('src/bad.js', enc('function foo() {}\nfunction bar() {}\n'));

    // big.js — too large → parse_failure violation
    await fs.write('src/big.js', enc('function foo() {}\n' + 'x'.repeat(200)));

    const result = await auditDiff(deps, makeReq({
      snapshotRefId: snapId,
      files: ['src/good.js', 'src/bad.js', 'src/big.js'],
    }));

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(2);
      const kinds = result.violations.map((v) => v.kind);
      expect(kinds).toContain('out_of_scope_symbol');
      expect(kinds).toContain('parse_failure');
    }
  });
});

// ---------------------------------------------------------------------------
// Audited node kinds whitelist
// ---------------------------------------------------------------------------

describe('D5 — T16: comment added → PASS', () => {
  it('adding a comment to an in-scope file does not trigger a violation', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Only a comment was added
    await fs.write('src/a.js', enc('// New comment here\nfunction foo() {}\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    expect(result.status).toBe('PASS');
  });
});

describe('D5 — T17: whitespace change → PASS', () => {
  it('adding whitespace to an in-scope file does not trigger a violation', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Significant whitespace changes, same structure
    await fs.write('src/a.js', enc('\n\n  function foo (  ) {\n\n  }\n\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    expect(result.status).toBe('PASS');
  });
});

describe('D5 — T18: out-of-scope nested symbol → does NOT block (only top-level audited)', () => {
  it('inner function inside in-scope function is not audited', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Inner function 'nested' inside 'foo' — not a top-level symbol
    await fs.write('src/a.js', enc('function foo() { function nested() {} return nested; }\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    // nested is inside foo, not at top level → no violation
    expect(result.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('D5 — T19: invalid correlationId → ValidationError(invalid_correlation_id)', () => {
  it('whitespace-only correlationId throws ValidationError', async () => {
    const { deps } = await makeDeps();

    await expect(
      auditDiff(deps, makeReq({ correlationId: '   ' })),
    ).rejects.toMatchObject({ kind: 'invalid_correlation_id' });
  });
});

describe('D5 — T20: path traversal in req.files → ValidationError(path_traversal)', () => {
  it('path escaping root throws ValidationError(path_traversal)', async () => {
    // Use a deeper fsRoot so that ../../../etc/passwd actually escapes it
    const { deps, store } = await makeDeps();
    const deepRootDeps: AuditDiffDeps = {
      ...deps,
      config: {
        ...deps.config,
        fsRoot: '/project/src/app',
      },
    };

    await seedSnapshot(store);

    await expect(
      auditDiff(deepRootDeps, makeReq({ files: ['../../../etc/passwd'] })),
    ).rejects.toMatchObject({ kind: 'path_traversal' });
  });
});

// ---------------------------------------------------------------------------
// Observability (H11, H13)
// ---------------------------------------------------------------------------

describe('D5 — T21: emitter receives start + end events with correct shape', () => {
  it('emits start and end events; end classification matches result status', async () => {
    const { deps, fs, store, emitter } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });
    await fs.write('src/a.js', enc('function foo() {}\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    const events = emitter.getEvents();
    const start = events.find((e) => e.phase === 'start' && e.op === 'auditDiff');
    const end = events.find((e) => e.phase === 'end' && e.op === 'auditDiff');

    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(end?.classification).toBe(result.status);
    expect(start?.correlationId).toBe('corr-001');
    expect(end?.correlationId).toBe('corr-001');
    expect(end?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('D5 — T22: error event on validation failure', () => {
  it('invalid request emits error event with errorCategory=validation', async () => {
    const { deps, emitter } = await makeDeps();

    await expect(
      auditDiff(deps, { correlationId: '' } as unknown as AuditRequest),
    ).rejects.toBeInstanceOf(ValidationError);

    const events = emitter.getEvents();
    const errEvent = events.find((e) => e.phase === 'error' && e.op === 'auditDiff');
    expect(errEvent).toBeDefined();
    expect(errEvent?.errorCategory).toBe('validation');
  });
});

describe('D5 — T23: H13 — no content in events (H13 invariant)', () => {
  it('assertEventIsContentFree passes for all events when violations carry sourceSlice', async () => {
    const { deps, fs, store, emitter } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    // Add 'bar' to trigger an out_of_scope_symbol violation with sourceSlice
    await fs.write('src/a.js', enc('function foo() {}\nfunction bar() { return 1; }\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    expect(result.status).toBe('BLOCK');

    // The AuditResult carries violations with sourceSlice
    // But events must be content-free
    const events = emitter.getEvents();
    for (const event of events) {
      assertEventIsContentFree(event);
    }
  });
});

describe('D5 — auditRef propagation', () => {
  it('returns the durable hoplon_audit_log id when appendAuditLog succeeds', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });
    await fs.write('src/a.js', enc('function foo() { return 42; }\n'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.status).toBe('PASS');
    expect(result.auditRef).toEqual(expect.any(String));

    const rows = await store.findAuditLogByProjectAndRun('proj-test', 'run-001');
    expect(rows).toHaveLength(1);
    expect(result.auditRef).toBe(rows[0]?.id);
  });

  it('returns auditRef=null and emits audit_log_write_failed when appendAuditLog fails', async () => {
    const { deps, fs, store, emitter } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });
    await fs.write('src/a.js', enc('function foo() { return 42; }\n'));

    vi.spyOn(store, 'appendAuditLog').mockRejectedValueOnce(new Error('audit log failed'));

    const result = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.status).toBe('PASS');
    expect(result.auditRef).toBeNull();
    expect(
      emitter.getEvents().some((event) =>
        event.phase === 'error' &&
        event.op === 'auditDiff' &&
        event.errorKind === 'audit_log_write_failed'
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal (H12)
// ---------------------------------------------------------------------------

describe('D5 — T24: pre-aborted signal → rejects without reading any file', () => {
  it('pre-aborted signal causes immediate rejection', async () => {
    const { deps, store } = await makeDeps();
    await seedSnapshot(store);

    const controller = new AbortController();
    controller.abort();

    await expect(
      auditDiff(deps, makeReq({ files: ['src/a.js'] }), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------
// AuditViolation shape proof
// ---------------------------------------------------------------------------

describe('D5 — T25: every violation kind has correction field (non-empty, distinct from message)', () => {
  it('each of the 4 violation kinds has a non-empty correction different from message', async () => {
    // We'll trigger: out_of_scope_symbol, uncontracted_file, parse_failure (two subtypes)
    // and verify shape.

    // --- out_of_scope_symbol ---
    {
      const { deps, fs, store } = await makeDeps();
      const snapId = await seedSnapshot(store);  // default manifest: src/a.js symbols=['foo']
      await fs.write('src/a.js', enc('function foo() {}\nfunction bar() {}\n'));
      const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/a.js'] }));
      expect(result.status).toBe('BLOCK');
      if (result.status === 'BLOCK') {
        const v = result.violations[0]!;
        expect(v.kind).toBe('out_of_scope_symbol');
        expect(v.correction).toBeTruthy();
        expect(v.message).toBeTruthy();
        expect(v.correction).not.toBe(v.message);
      }
    }

    // --- uncontracted_file ---
    {
      const { deps, fs, store } = await makeDeps();
      const snapId = await seedSnapshot(store);  // default manifest: src/a.js symbols=['foo']
      await fs.write('src/uncontracted.js', enc('function x() {}\n'));
      const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/uncontracted.js'] }));
      expect(result.status).toBe('BLOCK');
      if (result.status === 'BLOCK') {
        const v = result.violations[0]!;
        expect(v.kind).toBe('uncontracted_file');
        expect(v.correction).toBeTruthy();
        expect(v.message).toBeTruthy();
        expect(v.correction).not.toBe(v.message);
      }
    }

    // --- parse_failure (file_too_large) ---
    {
      const { deps, fs, store } = await makeDeps({ maxFileBytes: 10 });
      const bigManifest: WritableManifest = {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/big.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      };
      const snapId = await seedSnapshot(store, { manifest: bigManifest });
      await fs.write('src/big.js', enc('x'.repeat(100)));
      const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/big.js'] }));
      expect(result.status).toBe('BLOCK');
      if (result.status === 'BLOCK') {
        const v = result.violations[0]!;
        expect(v.kind).toBe('parse_failure');
        expect(v.correction).toBeTruthy();
        expect(v.message).toBeTruthy();
        expect(v.correction).not.toBe(v.message);
      }
    }

    // --- parse_failure (unsupported_extension) ---
    {
      const { deps, fs, store } = await makeDeps();
      const rbManifest: WritableManifest = {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/script.rb', scope: { kind: 'symbols', symbols: ['foo'] } }],
      };
      const snapId = await seedSnapshot(store, { manifest: rbManifest });
      await fs.write('src/script.rb', enc('def foo; end\n'));
      const result = await auditDiff(deps, makeReq({ snapshotRefId: snapId, files: ['src/script.rb'] }));
      expect(result.status).toBe('BLOCK');
      if (result.status === 'BLOCK') {
        const v = result.violations[0]!;
        expect(v.kind).toBe('parse_failure');
        expect(v.correction).toBeTruthy();
        expect(v.message).toBeTruthy();
        expect(v.correction).not.toBe(v.message);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism (H7-adjacent)
// ---------------------------------------------------------------------------

describe('D5 — Bonus: determinism (same inputs → identical AuditResult)', () => {
  it('calling auditDiff twice with same state produces JSON.stringify equal results', async () => {
    const { deps, fs, store } = await makeDeps();

    await seedSnapshot(store, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-seed',
        entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });
    await fs.write('src/a.js', enc('function foo() {}\nfunction bar() {}\n'));

    const r1 = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));
    const r2 = await auditDiff(deps, makeReq({ files: ['src/a.js'] }));

    // status and structure must match
    expect(r1.status).toBe(r2.status);
    expect(r1.correlationId).toBe(r2.correlationId);
    if (r1.status === 'BLOCK' && r2.status === 'BLOCK') {
      expect(r1.violations).toHaveLength(r2.violations.length);
      expect(JSON.stringify(r1.violations)).toBe(JSON.stringify(r2.violations));
    }
  });
});
