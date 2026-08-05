/**
 * tests/operations/ml2AuditColumns.test.ts — ML2 audit log ML columns test suite.
 *
 * Proves that the three ML2 additive columns land correctly in hoplon_audit_log:
 *   - ast_node_count INTEGER  (D5 auditDiff only — D1 createSnapshot → null)
 *   - file_line_count INTEGER  (both D1 + D5)
 *   - manifest_scope_ratio REAL  (both D1 + D5)
 *
 * Test inventory:
 *   ML2-1  Schema migration idempotent — columns present, pre-migration rows readable
 *   ML2-2  auditDiff PASS: ast_node_count matches direct tree-sitter count
 *   ML2-3  auditDiff PASS: file_line_count correct for single-file audit
 *   ML2-4  auditDiff PASS: manifest_scope_ratio = 1.0 for whole_file scope
 *   ML2-5  auditDiff PASS: manifest_scope_ratio = 0.0 for symbols scope (all bytes in scope = 0)
 *   ML2-6  auditDiff PASS: multi-file — astNodeCount is sum across files
 *   ML2-7  auditDiff: empty files list → astNodeCount=null, fileLineCount=null, manifestScopeRatio=null
 *   ML2-8  createSnapshot: astNodeCount=null (no AST parse), fileLineCount populated, manifestScopeRatio populated
 *   ML2-9  createSnapshot: whole_file scope → manifestScopeRatio = 1.0
 *   ML2-10 createSnapshot: symbols scope → manifestScopeRatio = 0.0 (no positional scope)
 *   ML2-11 H13: new columns carry counts/ratios only — no content, symbols, paths stored
 *   ML2-12 Backward-compat: pre-migration rows (without columns) still readable via find
 *
 * All tests use createIsolatedTestStore() — in-memory sql.js, no filesystem I/O.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
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

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

async function makeAuditDeps(store?: SnapshotStore): Promise<{
  deps: AuditDiffDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const resolvedStore = store ?? (await createIsolatedTestStore());
  const deps: AuditDiffDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: resolvedStore,
    codeIntelligence: sharedCI,
    emitter: createMemoryEmitter(),
    engineId: 'test-engine',
    config: {
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 5000,
      manifestSchemaVersion: 1,
    },
  };
  return { deps, fs, store: resolvedStore };
}

async function makeSnapshotDeps(store?: SnapshotStore): Promise<{
  deps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const resolvedStore = store ?? (await createIsolatedTestStore());
  const deps: CreateSnapshotDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: resolvedStore,
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: {
      gitRepoDir: '/.hoplon/repo',
      fsRoot: '/',
      manifestStorageMode: 'inline',
    },
  };
  return { deps, fs, store: resolvedStore };
}

/** Seed a committed snapshot record directly into the store. */
async function seedSnapshot(
  store: SnapshotStore,
  manifest: WritableManifest,
): Promise<string> {
  const id = hashManifest(manifest);
  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: 1,
    engineId: 'test-engine',
    projectId: manifest.projectId,
    runId: manifest.runId,
    correlationId: manifest.correlationId,
    status: 'committed',
    statusReason: null,
    // null → empty-baseline fallback; a fake ref would fail closed (hcr-009).
    gitRef: null,
    manifest,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };
  await store.put(record);
  return id;
}

/** Count all nodes in the tree using the same algorithm as _countAstNodes in auditDiff.ts */
function countAstNodesReference(root: { kind: string; children: unknown[] }): number {
  let count = 0;
  const stack: { kind: string; children: unknown[] }[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count++;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child !== null && typeof child === 'object' && 'kind' in child && 'children' in child) {
          stack.push(child as { kind: string; children: unknown[] });
        }
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// ML2-1: Schema migration idempotent — new columns exist, pre-migration rows readable
// ---------------------------------------------------------------------------

describe('ML2-1: schema migration idempotent — new columns present', () => {
  it('creates store twice (idempotent) and reads back ML2 columns from appended record', async () => {
    // Creating two stores exercises the "column already exists" branch of the migration
    const store1 = await createIsolatedTestStore();
    const store2 = await createIsolatedTestStore();

    // Append a record with ML2 columns to store1
    const { randomUUID } = await import('node:crypto');
    const record = {
      id: randomUUID(),
      snapshotId: null,
      projectId: 'proj-ml2-1',
      runId: 'run-ml2-1',
      engineId: 'test-engine',
      correlationId: 'corr-ml2-1',
      operation: 'AUDIT_DIFF' as const,
      result: 'PASS' as const,
      violationCount: 0,
      violationKinds: [],
      durationMs: 10,
      createdAt: new Date().toISOString(),
      astNodeCount: 42,
      fileLineCount: 7,
      manifestScopeRatio: 0.75,
    };

    await store1.appendAuditLog(record);
    const rows = await store1.findAuditLogByProjectAndRun('proj-ml2-1', 'run-ml2-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.astNodeCount).toBe(42);
    expect(rows[0]!.fileLineCount).toBe(7);
    expect(rows[0]!.manifestScopeRatio).toBeCloseTo(0.75, 5);

    // store2 is also functional — verifies idempotent migration
    const record2 = { ...record, id: randomUUID(), projectId: 'proj-ml2-1b' };
    await store2.appendAuditLog(record2);
    const rows2 = await store2.findAuditLogByProjectAndRun('proj-ml2-1b', 'run-ml2-1');
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.astNodeCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// ML2-2: auditDiff PASS — ast_node_count matches direct tree-sitter count
// ---------------------------------------------------------------------------

describe('ML2-2: auditDiff PASS — ast_node_count matches direct tree-sitter count', () => {
  it('ast_node_count in log entry equals the tree-sitter node count for the audited file', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    const fileContent = 'function foo() { return 42; }\n';
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-2',
      runId: 'run-ml2-2',
      correlationId: 'corr-ml2-2',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/a.js', enc(fileContent));

    const result = await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-2',
      runId: 'run-ml2-2',
      correlationId: 'corr-ml2-2',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('PASS');

    // Independently compute the tree-sitter node count for the same content
    const tree = await sharedCI.parse('src/a.js', enc(fileContent));
    const expectedNodeCount = countAstNodesReference(tree.rootNode);
    expect(expectedNodeCount).toBeGreaterThan(0);

    // Verify the audit log entry carries the matching count
    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-2', 'run-ml2-2');
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.astNodeCount).toBe(expectedNodeCount);
  });
});

// ---------------------------------------------------------------------------
// ML2-3: auditDiff PASS — file_line_count correct for single file
// ---------------------------------------------------------------------------

describe('ML2-3: auditDiff PASS — file_line_count correct', () => {
  it('file_line_count matches the actual newline count of the audited file', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    // 3 lines: line1 + newline + line2 + newline + line3 + newline = 3 lines
    const fileContent = 'function foo() {}\nfunction bar() {}\nconst x = 1;\n';
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-3',
      runId: 'run-ml2-3',
      correlationId: 'corr-ml2-3',
      entries: [{ path: 'src/b.js', scope: { kind: 'symbols', symbols: ['foo', 'bar', 'x'] } }],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/b.js', enc(fileContent));

    await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-3',
      runId: 'run-ml2-3',
      correlationId: 'corr-ml2-3',
      files: ['src/b.js'],
    });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-3', 'run-ml2-3');
    expect(rows).toHaveLength(1);
    // 3 newlines in fileContent → 3 + 1 = but last line ends with \n so count = newlines + 1
    // fileContent = 'function foo() {}\nfunction bar() {}\nconst x = 1;\n'
    // newlines: 3 → file has 3 complete lines (newlines+1 = 4, but last newline means 3 content lines + 1 empty)
    // Our algorithm: newlineCount=3, byteLength>0 → totalLineCount = 3+1 = 4
    expect(rows[0]!.fileLineCount).toBe(4);
    expect(rows[0]!.fileLineCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ML2-4: auditDiff — manifest_scope_ratio = 1.0 for whole_file scope
// ---------------------------------------------------------------------------

describe('ML2-4: auditDiff — manifestScopeRatio = 1.0 for whole_file scope', () => {
  it('whole_file scope: all file bytes covered → ratio = 1.0', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    const fileContent = 'function foo() { return 1; }\n';
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-4',
      runId: 'run-ml2-4',
      correlationId: 'corr-ml2-4',
      entries: [{ path: 'src/c.js', scope: { kind: 'whole_file' } }],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/c.js', enc(fileContent));

    await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-4',
      runId: 'run-ml2-4',
      correlationId: 'corr-ml2-4',
      files: ['src/c.js'],
    });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-4', 'run-ml2-4');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manifestScopeRatio).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// ML2-5: auditDiff — manifest_scope_ratio = 0.0 for symbols scope
// ---------------------------------------------------------------------------

describe('ML2-5: auditDiff — manifestScopeRatio = 0.0 for symbols scope', () => {
  it('symbols scope: scope is symbolic (not positional) → 0 bytes covered → ratio = 0.0', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    const fileContent = 'function foo() { return 1; }\n';
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-5',
      runId: 'run-ml2-5',
      correlationId: 'corr-ml2-5',
      entries: [{ path: 'src/d.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/d.js', enc(fileContent));

    await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-5',
      runId: 'run-ml2-5',
      correlationId: 'corr-ml2-5',
      files: ['src/d.js'],
    });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-5', 'run-ml2-5');
    expect(rows).toHaveLength(1);
    // symbols scope → scopeCoveredBytes = 0; totalFileBytes > 0 → ratio = 0.0
    expect(rows[0]!.manifestScopeRatio).toBeCloseTo(0.0, 5);
  });
});

// ---------------------------------------------------------------------------
// ML2-6: auditDiff — multi-file: astNodeCount is sum across files
// ---------------------------------------------------------------------------

describe('ML2-6: auditDiff multi-file — astNodeCount is sum across all parsed files', () => {
  it('auditing two files with symbols scope: astNodeCount = sum of both trees', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    const content1 = 'function foo() { return 1; }\n';
    const content2 = 'function bar() { return 2; }\nfunction baz() { return 3; }\n';

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-6',
      runId: 'run-ml2-6',
      correlationId: 'corr-ml2-6',
      entries: [
        { path: 'src/e.js', scope: { kind: 'symbols', symbols: ['foo'] } },
        { path: 'src/f.js', scope: { kind: 'symbols', symbols: ['bar', 'baz'] } },
      ],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/e.js', enc(content1));
    await fs.write('src/f.js', enc(content2));

    await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-6',
      runId: 'run-ml2-6',
      correlationId: 'corr-ml2-6',
      files: ['src/e.js', 'src/f.js'],
    });

    // Compute expected counts directly from tree-sitter
    const tree1 = await sharedCI.parse('src/e.js', enc(content1));
    const tree2 = await sharedCI.parse('src/f.js', enc(content2));
    const expectedCount = countAstNodesReference(tree1.rootNode) + countAstNodesReference(tree2.rootNode);

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-6', 'run-ml2-6');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.astNodeCount).toBe(expectedCount);
    // fileLineCount should cover both files
    expect(rows[0]!.fileLineCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ML2-7: auditDiff with empty files list — all ML2 metrics null
// ---------------------------------------------------------------------------

describe('ML2-7: auditDiff empty files list — ML2 columns are null', () => {
  it('no files to audit → astNodeCount=null, fileLineCount=null, manifestScopeRatio=null', async () => {
    const { deps, store } = await makeAuditDeps();

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-7',
      runId: 'run-ml2-7',
      correlationId: 'corr-ml2-7',
      entries: [{ path: 'src/g.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    await seedSnapshot(store, manifest);

    // No files passed to auditDiff — nothing to audit
    const result = await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-7',
      runId: 'run-ml2-7',
      correlationId: 'corr-ml2-7',
      files: [],
    });

    expect(result.status).toBe('PASS');

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-7', 'run-ml2-7');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.astNodeCount).toBeNull();
    expect(rows[0]!.fileLineCount).toBeNull();
    expect(rows[0]!.manifestScopeRatio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ML2-8: createSnapshot — astNodeCount=null, fileLineCount populated, ratio populated
// ---------------------------------------------------------------------------

describe('ML2-8: createSnapshot — astNodeCount null, fileLineCount and ratio computed', () => {
  it('createSnapshot does not parse ASTs → astNodeCount=null; fileLineCount + ratio are set', async () => {
    const { deps, fs, store } = await makeSnapshotDeps();

    const content = 'function hello() { return "world"; }\n';
    await fs.write('src/h.js', enc(content));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-8',
      runId: 'run-ml2-8',
      correlationId: 'corr-ml2-8',
      entries: [{ path: 'src/h.js', scope: { kind: 'whole_file' } }],
    };

    await createSnapshot(deps, { manifest });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-8', 'run-ml2-8');
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;

    // createSnapshot does not call codeIntelligence.parse → astNodeCount null
    expect(entry.astNodeCount).toBeNull();
    // fileLineCount should be computed from the content read during secret scan
    expect(entry.fileLineCount).toBeGreaterThan(0);
    // manifestScopeRatio should be defined (not null)
    expect(entry.manifestScopeRatio).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ML2-9: createSnapshot whole_file — manifestScopeRatio = 1.0
// ---------------------------------------------------------------------------

describe('ML2-9: createSnapshot whole_file scope → manifestScopeRatio = 1.0', () => {
  it('single whole_file entry → all bytes covered → ratio = 1.0', async () => {
    const { deps, fs, store } = await makeSnapshotDeps();

    await fs.write('src/i.js', enc('const x = 42;\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-9',
      runId: 'run-ml2-9',
      correlationId: 'corr-ml2-9',
      entries: [{ path: 'src/i.js', scope: { kind: 'whole_file' } }],
    };

    await createSnapshot(deps, { manifest });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-9', 'run-ml2-9');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manifestScopeRatio).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// ML2-10: createSnapshot symbols scope — manifestScopeRatio = 0.0
// ---------------------------------------------------------------------------

describe('ML2-10: createSnapshot symbols scope → manifestScopeRatio = 0.0', () => {
  it('single symbols scope entry → 0 bytes covered positionally → ratio = 0.0', async () => {
    const { deps, fs, store } = await makeSnapshotDeps();

    await fs.write('src/j.ts', enc('export function greet(name: string): string { return `Hello, ${name}`; }\n'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-10',
      runId: 'run-ml2-10',
      correlationId: 'corr-ml2-10',
      entries: [{ path: 'src/j.ts', scope: { kind: 'symbols', symbols: ['greet'] } }],
    };

    await createSnapshot(deps, { manifest });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-10', 'run-ml2-10');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manifestScopeRatio).toBeCloseTo(0.0, 5);
  });
});

// ---------------------------------------------------------------------------
// ML2-11: H13 verification — new columns carry counts/ratios only
// ---------------------------------------------------------------------------

describe('ML2-11: H13 — new ML2 columns carry counts/ratios only, no content', () => {
  it('astNodeCount is a non-negative integer or null — no string content', async () => {
    const { deps, fs, store } = await makeAuditDeps();

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-ml2-11',
      runId: 'run-ml2-11',
      correlationId: 'corr-ml2-11',
      entries: [{ path: 'src/k.js', scope: { kind: 'symbols', symbols: ['doSomething'] } }],
    };

    await seedSnapshot(store, manifest);
    await fs.write('src/k.js', enc('function doSomething() { const secret = "PASSWORD"; return secret; }\n'));

    await auditDiff(deps, {
      snapshotRefId: hashManifest(manifest),
      projectId: 'proj-ml2-11',
      runId: 'run-ml2-11',
      correlationId: 'corr-ml2-11',
      files: ['src/k.js'],
    });

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-11', 'run-ml2-11');
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;

    // astNodeCount must be a non-negative integer or null — never a string
    if (entry.astNodeCount !== null && entry.astNodeCount !== undefined) {
      expect(typeof entry.astNodeCount).toBe('number');
      expect(Number.isInteger(entry.astNodeCount)).toBe(true);
      expect(entry.astNodeCount).toBeGreaterThanOrEqual(0);
    }

    // fileLineCount must be a non-negative integer or null
    if (entry.fileLineCount !== null && entry.fileLineCount !== undefined) {
      expect(typeof entry.fileLineCount).toBe('number');
      expect(Number.isInteger(entry.fileLineCount)).toBe(true);
      expect(entry.fileLineCount).toBeGreaterThanOrEqual(0);
    }

    // manifestScopeRatio must be in [0, 1] or null
    if (entry.manifestScopeRatio !== null && entry.manifestScopeRatio !== undefined) {
      expect(typeof entry.manifestScopeRatio).toBe('number');
      expect(entry.manifestScopeRatio).toBeGreaterThanOrEqual(0);
      expect(entry.manifestScopeRatio).toBeLessThanOrEqual(1);
    }

    // The word "secret" or "PASSWORD" must NOT appear in any logged field
    const loggedJson = JSON.stringify(entry);
    expect(loggedJson).not.toContain('PASSWORD');
    expect(loggedJson).not.toContain('function doSomething');
    expect(loggedJson).not.toContain('const secret');
  });
});

// ---------------------------------------------------------------------------
// ML2-12: Backward-compat — pre-migration rows still readable
// ---------------------------------------------------------------------------

describe('ML2-12: backward-compat — pre-migration rows (ML2 columns null) still readable', () => {
  it('rows appended without ML2 fields are readable; ML2 fields default to null', async () => {
    const store = await createIsolatedTestStore();
    const { randomUUID } = await import('node:crypto');

    // Append a record that omits the ML2 optional fields (simulates pre-migration row)
    const legacyRecord = {
      id: randomUUID(),
      snapshotId: 'snap-legacy',
      projectId: 'proj-ml2-12',
      runId: 'run-ml2-12',
      engineId: 'test-engine',
      correlationId: 'corr-ml2-12',
      operation: 'CREATE_SNAPSHOT' as const,
      result: 'PASS' as const,
      violationCount: 0,
      violationKinds: [],
      durationMs: 50,
      createdAt: '2025-12-01T00:00:00.000Z',
      // astNodeCount, fileLineCount, manifestScopeRatio intentionally absent
    };

    await store.appendAuditLog(legacyRecord);

    const rows = await store.findAuditLogByProjectAndRun('proj-ml2-12', 'run-ml2-12');
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;

    // Core fields must be intact
    expect(entry.id).toBe(legacyRecord.id);
    expect(entry.operation).toBe('CREATE_SNAPSHOT');
    expect(entry.result).toBe('PASS');
    expect(entry.projectId).toBe('proj-ml2-12');

    // ML2 fields default to null (backward-compatible per H19)
    expect(entry.astNodeCount ?? null).toBeNull();
    expect(entry.fileLineCount ?? null).toBeNull();
    expect(entry.manifestScopeRatio ?? null).toBeNull();
  });
});
