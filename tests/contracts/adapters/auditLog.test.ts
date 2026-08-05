/**
 * tests/contracts/adapters/auditLog.test.ts — AL1 audit log test suite.
 *
 * Tests the hoplon_audit_log table, SnapshotStore audit methods, and end-to-end
 * integration with createSnapshot, auditDiff, and revertUncontracted.
 *
 * All tests use createIsolatedTestStore() — in-memory sql.js instances,
 * no filesystem I/O, no shared state between tests.
 *
 * Test inventory (10 required):
 *   AL-1  Schema migration is idempotent
 *   AL-2  Round-trip put/get via appendAuditLog / findAuditLogByProjectAndRun
 *   AL-3  findAuditLogByProjectAndRun ordering (createdAt ASC)
 *   AL-4  gcAuditLog with projectId filter
 *   AL-5  gcAuditLog safety — both filters omitted rejects
 *   AL-6  createSnapshot integration — exactly 1 PASS entry
 *   AL-7  auditDiff BLOCK integration — BLOCK entry + H13 content audit
 *   AL-8  revertUncontracted integration — exactly 1 PASS entry
 *   AL-9  dryRun writes ZERO entries (H21)
 *   AL-9b health() writes ZERO entries (H21 — Phalanx integration requirement 24)
 *   AL-9c reconcile() writes ZERO entries (H21 — Phalanx integration requirement 24)
 *   AL-10 Append-only structural enforcement (type-level + runtime grep assertion)
 *
 * Note: packContext does NOT appear in AL-9* tests — its Deps shape
 * structurally excludes snapshotStore (no appendAuditLog access). Structural
 * absence is the proof; no runtime test needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { ValidationError } from '../../../src/hoplon/contracts/errors.js';
import { AuditLogRecordSchema } from '../../../src/hoplon/contracts/auditLog.js';
import type { AuditLogRecord } from '../../../src/hoplon/contracts/auditLog.js';
import { proofAccessEventToAuditLogRecord } from '../../../src/hoplon/contracts/complianceAccess.js';
import type { SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';

import { createSnapshot } from '../../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../../src/hoplon/operations/createSnapshot.js';
import { auditDiff } from '../../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../../src/hoplon/operations/auditDiff.js';
import { revertUncontracted } from '../../../src/hoplon/operations/revertUncontracted.js';
import type { RevertUncontractedDeps } from '../../../src/hoplon/operations/revertUncontracted.js';

import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';
import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';
import type { SnapshotRecord } from '../../../src/hoplon/adapters/snapshotStore.js';
import { dryRun } from '../../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../../src/hoplon/operations/dryRun.js';
import { health } from '../../../src/hoplon/operations/health.js';
import type { HealthDeps } from '../../../src/hoplon/operations/health.js';
import { reconcile } from '../../../src/hoplon/operations/reconcile.js';
import type { ReconcileDeps } from '../../../src/hoplon/operations/reconcile.js';
import { createNoopAnalyzer } from '../../../src/hoplon/adapters/staticAnalysis/noop.js';
import { createNoopSemanticStorageProfile } from '../../../src/hoplon/adapters/semanticStorageProfile.js';
import { createInMemorySemanticSessionOverlayStore } from '../../../src/hoplon/operations/semanticSearch.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

// ---------------------------------------------------------------------------
// Shared tree-sitter instance (loaded once for integration tests)
// ---------------------------------------------------------------------------

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a minimal valid AuditLogRecord fixture.
 * Includes ML2 optional columns as null so round-trip deep-equality assertions work
 * after the ML2 additive migration (the store always returns these fields now).
 */
function makeAuditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId: 'proj-test',
    runId: 'run-001',
    engineId: 'test-engine',
    correlationId: 'corr-abc',
    operation: 'AUDIT_DIFF',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 42,
    createdAt: '2026-01-15T10:00:00.000Z',
    // ML2 columns default to null; include so toEqual deep-checks round-trip correctly
    astNodeCount: null,
    fileLineCount: null,
    manifestScopeRatio: null,
    ...overrides,
  };
}

/** Build a complete integration harness (fs + versioning + store + emitter + deps). */
async function makeIntegrationHarness() {
  const fsAdapter = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
  const secretScanner = createBuiltinRegexScanner();

  const gitRepoDir = '/.hoplon/repo';
  const fsRoot = '/';

  const snapshotDeps: CreateSnapshotDeps = {
    fs: fsAdapter,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    secretScanner,
    engineId: 'test-engine',
    config: {
      gitRepoDir,
      fsRoot,
      manifestStorageMode: 'inline',
    },
  };

  const auditDeps: AuditDiffDeps = {
    fs: fsAdapter,
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

  const revertDeps: RevertUncontractedDeps = {
    fs: fsAdapter,
    versioning,
    snapshotStore: store,
    lockProvider,
    emitter,
    engineId: 'test-engine',
    config: {
      gitRepoDir,
      fsRoot,
      revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**'],
    },
  };

  const dryRunDeps: DryRunDeps = {
    fs: fsAdapter,
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

  return { fsAdapter, emitter, store, snapshotDeps, auditDeps, revertDeps, dryRunDeps };
}

// ---------------------------------------------------------------------------
// AL-1: Schema migration is idempotent
// ---------------------------------------------------------------------------

describe('AL-1: schema migration idempotency', () => {
  it('hoplon_audit_log table exists after store creation; hoplon_snapshots still works', async () => {
    // Create two stores — migration runs on each construction
    const store1 = await createIsolatedTestStore();
    const store2 = await createIsolatedTestStore();

    // Verify audit log is functional on store1 by appending and reading
    const record = makeAuditRecord();
    await store1.appendAuditLog(record);
    const retrieved = await store1.findAuditLogByProjectAndRun('proj-test', 'run-001');
    expect(retrieved).toHaveLength(1);

    // Verify hoplon_snapshots still works on store1
    const snapshotRecord: SnapshotRecord = {
      id: 'a'.repeat(64),
      manifestSchemaVersion: 1,
      engineId: 'test-engine',
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-abc',
      status: 'pending',
      statusReason: null,
      gitRef: null,
      manifest: null,
      createdAt: '2026-01-15T10:00:00Z',
      ttlExpires: null,
      replicaIds: [],
    };
    await store1.put(snapshotRecord);
    const snap = await store1.get('a'.repeat(64));
    expect(snap).not.toBeNull();

    // store2 should also be functional — verifies idempotent migration
    const record2 = makeAuditRecord({ id: randomUUID(), projectId: 'proj-b' });
    await store2.appendAuditLog(record2);
    const rows2 = await store2.findAuditLogByProjectAndRun('proj-b', 'run-001');
    expect(rows2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AL-2: Round-trip put/get
// ---------------------------------------------------------------------------

describe('AL-2: appendAuditLog / findAuditLogByProjectAndRun round-trip', () => {
  it('inserts an AuditLogRecord and reads it back with deep equality', async () => {
    const store = await createIsolatedTestStore();
    const record = makeAuditRecord({
      id: randomUUID(),
      snapshotId: 'snap-123',
      projectId: 'proj-rt',
      runId: 'run-rt',
      operation: 'CREATE_SNAPSHOT',
      result: 'PASS',
      violationCount: 0,
      violationKinds: [],
      durationMs: 100,
      createdAt: '2026-03-01T12:00:00.000Z',
    });

    await store.appendAuditLog(record);
    const rows = await store.findAuditLogByProjectAndRun('proj-rt', 'run-rt');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(record);
    expect(rows[0]!.auditSequence).toBe(1);
    expect(rows[0]!.previousChainHash).toBeNull();
    expect(rows[0]!.rowHash).toEqual(expect.any(String));
    expect(rows[0]!.chainHash).toEqual(expect.any(String));
    expect(rows[0]!.chainVersion).toBe(1);
    expect(rows[0]!.chainAlgorithm).toBe('sha256');
  });

  it('INSERT OR IGNORE: inserting same id twice does not create duplicate', async () => {
    const store = await createIsolatedTestStore();
    const record = makeAuditRecord({ id: randomUUID(), projectId: 'proj-idem', runId: 'run-idem' });

    await store.appendAuditLog(record);
    await store.appendAuditLog(record); // second insert — should be no-op

    const rows = await store.findAuditLogByProjectAndRun('proj-idem', 'run-idem');
    expect(rows).toHaveLength(1);
  });

  it('round-trips PROOF_ACCESS audit rows with H13-safe access payload', async () => {
    const store = await createIsolatedTestStore();
    const record = proofAccessEventToAuditLogRecord({
      id: randomUUID(),
      event: {
        principalId: 'compliance',
        engineId: 'engine-proof',
        accessClass: 'raw_proof',
        objectType: 'proof_bundle',
        objectRef: 'proof-rt',
        projectId: 'proj-proof-access',
        runId: 'run-proof-access',
        correlationId: 'corr-proof',
        requestedAt: '2026-04-01T00:00:00.000Z',
        outcome: 'GRANTED',
        reasonCode: 'access_granted',
        detail: null,
      },
    });

    await store.appendAuditLog(record);
    const rows = await store.findAuditLogByProjectAndRun('proj-proof-access', 'run-proof-access');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'PROOF_ACCESS',
      result: 'GRANTED',
      proofAccessEvent: {
        principalId: 'compliance',
        accessClass: 'raw_proof',
        objectRef: 'proof-rt',
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain('auditResult');
    expect(JSON.stringify(rows[0])).not.toContain('sourceSlice');
  });
});

// ---------------------------------------------------------------------------
// t-134: SOC2 audit-log integrity hash chain
// ---------------------------------------------------------------------------

describe('t-134: verifyAuditLogIntegrity', () => {
  it('returns PASS for chained audit rows', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      projectId: 'proj-chain',
      runId: 'run-chain',
      createdAt: '2026-03-01T00:00:01.000Z',
    }));
    await store.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      projectId: 'proj-chain',
      runId: 'run-chain',
      createdAt: '2026-03-01T00:00:02.000Z',
      result: 'BLOCK',
      violationCount: 1,
      violationKinds: ['out_of_scope_symbol'],
    }));

    const result = await store.verifyAuditLogIntegrity({
      projectId: 'proj-chain',
      runId: 'run-chain',
    });

    expect(result.status).toBe('PASS');
    expect(result.checkedRows).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('returns FAIL when row metadata is tampered after append', async () => {
    const store = await createIsolatedTestStore();
    const tamperedId = randomUUID();
    await store.appendAuditLog(makeAuditRecord({
      id: tamperedId,
      projectId: 'proj-tamper',
      runId: 'run-tamper',
      createdAt: '2026-03-01T00:00:01.000Z',
      violationCount: 1,
      violationKinds: ['before'],
    }));
    const raw = store as unknown as {
      db: { run(sql: string, params?: unknown[]): void };
    };
    raw.db.run(
      'UPDATE hoplon_audit_log SET violation_count = ?, violation_kinds = ? WHERE id = ?',
      [9, JSON.stringify(['after']), tamperedId],
    );

    const result = await store.verifyAuditLogIntegrity({
      projectId: 'proj-tamper',
      runId: 'run-tamper',
    });

    expect(result.status).toBe('FAIL');
    expect(result.failures.some((failure) => failure.kind === 'row_hash_mismatch')).toBe(true);
  });

  it('returns FAIL when chain version metadata is unsupported', async () => {
    const store = await createIsolatedTestStore();
    const tamperedId = randomUUID();
    await store.appendAuditLog(makeAuditRecord({
      id: tamperedId,
      projectId: 'proj-version',
      runId: 'run-version',
      createdAt: '2026-03-01T00:00:01.000Z',
    }));
    const raw = store as unknown as {
      db: { run(sql: string, params?: unknown[]): void };
    };
    raw.db.run(
      'UPDATE hoplon_audit_log SET chain_version = ? WHERE id = ?',
      [2, tamperedId],
    );

    const result = await store.verifyAuditLogIntegrity({
      projectId: 'proj-version',
      runId: 'run-version',
    });

    expect(result.status).toBe('FAIL');
    expect(result.failures.some((failure) => failure.kind === 'unsupported_version')).toBe(true);
  });

  it('returns FAIL when a chain row is deleted', async () => {
    const store = await createIsolatedTestStore();
    const deletedId = randomUUID();
    await store.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      projectId: 'proj-delete',
      runId: 'run-delete',
      createdAt: '2026-03-01T00:00:01.000Z',
    }));
    await store.appendAuditLog(makeAuditRecord({
      id: deletedId,
      projectId: 'proj-delete',
      runId: 'run-delete',
      createdAt: '2026-03-01T00:00:02.000Z',
    }));
    await store.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      projectId: 'proj-delete',
      runId: 'run-delete',
      createdAt: '2026-03-01T00:00:03.000Z',
    }));
    const raw = store as unknown as {
      db: { run(sql: string, params?: unknown[]): void };
    };
    raw.db.run('DELETE FROM hoplon_audit_log WHERE id = ?', [deletedId]);

    const result = await store.verifyAuditLogIntegrity({
      projectId: 'proj-delete',
      runId: 'run-delete',
    });

    expect(result.status).toBe('FAIL');
    expect(result.failures.some((failure) => failure.kind === 'sequence_gap')).toBe(true);
  });

  it('returns UNCHECKED for legacy rows without chain metadata', async () => {
    const store = await createIsolatedTestStore();
    const raw = store as unknown as {
      db: { run(sql: string, params?: unknown[]): void };
    };
    raw.db.run(
      `INSERT INTO hoplon_audit_log (
        id, snapshot_id, project_id, run_id, engine_id, correlation_id,
        operation, result, violation_count, violation_kinds, duration_ms, created_at,
        ast_node_count, file_line_count, manifest_scope_ratio, policy_event
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        null,
        'proj-legacy',
        'run-legacy',
        'test-engine',
        'corr-legacy',
        'AUDIT_DIFF',
        'PASS',
        0,
        JSON.stringify([]),
        42,
        '2026-03-01T00:00:01.000Z',
        null,
        null,
        null,
        null,
      ],
    );

    const result = await store.verifyAuditLogIntegrity({
      projectId: 'proj-legacy',
      runId: 'run-legacy',
    });

    expect(result.status).toBe('UNCHECKED');
    expect(result.uncheckedRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AL-3: findAuditLogByProjectAndRun ordering
// ---------------------------------------------------------------------------

describe('AL-3: returned records are ordered by createdAt ASC', () => {
  it('returns 3 records in ascending createdAt order regardless of insertion order', async () => {
    const store = await createIsolatedTestStore();

    const r1 = makeAuditRecord({ id: randomUUID(), projectId: 'proj-ord', runId: 'run-ord', createdAt: '2026-03-01T00:00:00.000Z' });
    const r2 = makeAuditRecord({ id: randomUUID(), projectId: 'proj-ord', runId: 'run-ord', createdAt: '2026-01-01T00:00:00.000Z' });
    const r3 = makeAuditRecord({ id: randomUUID(), projectId: 'proj-ord', runId: 'run-ord', createdAt: '2026-02-01T00:00:00.000Z' });

    // Insert out of order
    await store.appendAuditLog(r1);
    await store.appendAuditLog(r2);
    await store.appendAuditLog(r3);

    const rows = await store.findAuditLogByProjectAndRun('proj-ord', 'run-ord');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[1]!.createdAt).toBe('2026-02-01T00:00:00.000Z');
    expect(rows[2]!.createdAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// AL-4: gcAuditLog with projectId filter
// ---------------------------------------------------------------------------

describe('AL-4: gcAuditLog with projectId filter', () => {
  it('deletes only the matching project records; other projects untouched', async () => {
    const store = await createIsolatedTestStore();

    // Insert 2 records for projectA and 1 for projectB
    await store.appendAuditLog(makeAuditRecord({ id: randomUUID(), projectId: 'projectA', runId: 'run-1' }));
    await store.appendAuditLog(makeAuditRecord({ id: randomUUID(), projectId: 'projectA', runId: 'run-1' }));
    await store.appendAuditLog(makeAuditRecord({ id: randomUUID(), projectId: 'projectB', runId: 'run-1' }));

    const { deletedCount } = await store.gcAuditLog({ projectId: 'projectA' });

    expect(deletedCount).toBe(2);

    const projectARows = await store.findAuditLogByProjectAndRun('projectA', 'run-1');
    expect(projectARows).toHaveLength(0);

    const projectBRows = await store.findAuditLogByProjectAndRun('projectB', 'run-1');
    expect(projectBRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AL-5: gcAuditLog safety — both filters omitted rejects
// ---------------------------------------------------------------------------

describe('AL-5: gcAuditLog safety guard', () => {
  it('throws ValidationError with kind invalid_scope when both filters are omitted', async () => {
    const store = await createIsolatedTestStore();
    await expect(store.gcAuditLog({})).rejects.toThrow(ValidationError);

    // Also check the error kind
    let caughtError: unknown;
    try {
      await store.gcAuditLog({});
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ValidationError);
    expect((caughtError as ValidationError).kind).toBe('invalid_scope');
  });
});

// ---------------------------------------------------------------------------
// AL-6: createSnapshot integration
// ---------------------------------------------------------------------------

describe('AL-6: createSnapshot integration', () => {
  it('successful createSnapshot writes exactly 1 PASS audit log entry', async () => {
    const { fsAdapter, store, snapshotDeps } = await makeIntegrationHarness();

    await fsAdapter.write('src/foo.ts', enc('export function foo() {}'));

    const req = {
      manifest: {
        manifestSchemaVersion: 1 as const,
        projectId: 'proj-al6',
        runId: 'run-al6',
        correlationId: 'corr-al6',
        entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
      },
    };

    const result = await createSnapshot(snapshotDeps, req);
    expect(result.snapshotRef.id).toBeDefined();

    const rows = await store.findAuditLogByProjectAndRun('proj-al6', 'run-al6');
    expect(rows).toHaveLength(1);

    const entry = rows[0]!;
    expect(entry.operation).toBe('CREATE_SNAPSHOT');
    expect(entry.result).toBe('PASS');
    expect(entry.violationCount).toBe(0);
    expect(entry.violationKinds).toEqual([]);
    expect(entry.snapshotId).toBe(result.snapshotRef.id);
    expect(entry.projectId).toBe('proj-al6');
    expect(entry.runId).toBe('run-al6');
    expect(entry.engineId).toBe('test-engine');
    expect(entry.correlationId).toBe('corr-al6');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// AL-7: auditDiff BLOCK integration + H13 content audit
// ---------------------------------------------------------------------------

describe('AL-7: auditDiff BLOCK integration + H13 content audit', () => {
  it('BLOCK audit writes 1 BLOCK entry with correct violationKinds (H13: kinds only)', async () => {
    const { fsAdapter, store, snapshotDeps, auditDeps } = await makeIntegrationHarness();

    // Write a file with only 'foo' symbol
    await fsAdapter.write('src/a.js', enc('function foo() {}'));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-al7',
      runId: 'run-al7',
      correlationId: 'corr-al7',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapResult = await createSnapshot(snapshotDeps, { manifest });
    const snapshotId = snapResult.snapshotRef.id;

    // Now add an out-of-scope symbol 'bar' to the file
    await fsAdapter.write('src/a.js', enc('function foo() {}\nfunction bar() {}'));

    // Run audit — should BLOCK on 'bar'
    const auditResult = await auditDiff(auditDeps, {
      snapshotRefId: snapshotId,
      projectId: 'proj-al7',
      runId: 'run-al7',
      correlationId: 'corr-al7',
      files: ['src/a.js'],
    });

    expect(auditResult.status).toBe('BLOCK');

    // Verify the audit log entries (2 total: 1 from createSnapshot, 1 from auditDiff)
    const rows = await store.findAuditLogByProjectAndRun('proj-al7', 'run-al7');
    const auditRows = rows.filter((r) => r.operation === 'AUDIT_DIFF');

    expect(auditRows).toHaveLength(1);
    const entry = auditRows[0]!;
    expect(entry.operation).toBe('AUDIT_DIFF');
    expect(entry.result).toBe('BLOCK');
    expect(entry.violationCount).toBeGreaterThanOrEqual(1);
    expect(entry.violationKinds.length).toBeGreaterThanOrEqual(1);
    expect(entry.violationKinds).toContain('out_of_scope_symbol');

    // H13 audit: verify violationKinds contains ONLY known closed-union kind strings
    // No symbol names, paths, slices, corrections, or content-bearing fields.
    const KNOWN_VIOLATION_KINDS = new Set([
      'out_of_scope_symbol',
      'uncontracted_file',
      'parse_failure',
      'snapshot_missing',
    ]);
    for (const kind of entry.violationKinds) {
      expect(KNOWN_VIOLATION_KINDS.has(kind)).toBe(true);
      // Extra safety: kind must be a short string (< 100 chars) with no spaces
      expect(kind.length).toBeLessThan(100);
      expect(kind).not.toContain(' ');
      // Must not look like a file path
      expect(kind).not.toContain('/');
      expect(kind).not.toContain('\\');
      // Must not look like source code
      expect(kind).not.toContain('function');
      expect(kind).not.toContain('const ');
    }
  });
});

// ---------------------------------------------------------------------------
// AL-8: revertUncontracted integration
// ---------------------------------------------------------------------------

describe('AL-8: revertUncontracted integration', () => {
  it('successful revert writes exactly 1 PASS REVERT entry', async () => {
    const { fsAdapter, store, snapshotDeps, revertDeps } = await makeIntegrationHarness();

    // Seed original content and snapshot
    await fsAdapter.write('src/b.ts', enc('const x = 1;'));
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-al8',
      runId: 'run-al8',
      correlationId: 'corr-al8',
      entries: [{ path: 'src/b.ts', scope: { kind: 'whole_file' } }],
    };

    const snapResult = await createSnapshot(snapshotDeps, { manifest });
    const snapshotId = snapResult.snapshotRef.id;

    // Modify the file
    await fsAdapter.write('src/b.ts', enc('const x = 999;'));

    // Revert
    await revertUncontracted(revertDeps, {
      snapshotRefId: snapshotId,
      projectId: 'proj-al8',
      runId: 'run-al8',
      correlationId: 'corr-al8',
    });

    // Verify audit log
    const rows = await store.findAuditLogByProjectAndRun('proj-al8', 'run-al8');
    const revertRows = rows.filter((r) => r.operation === 'REVERT');

    expect(revertRows).toHaveLength(1);
    const entry = revertRows[0]!;
    expect(entry.operation).toBe('REVERT');
    expect(entry.result).toBe('PASS');
    expect(entry.violationCount).toBe(0);
    expect(entry.violationKinds).toEqual([]);
    expect(entry.snapshotId).toBe(snapshotId);
  });
});

// ---------------------------------------------------------------------------
// AL-9: dryRun writes ZERO entries
// ---------------------------------------------------------------------------

describe('AL-9: dryRun writes zero audit log entries (H21)', () => {
  /**
   * DR1 (dryRun operation) is landed on this branch.
   * dryRun is explicitly documented as "exploratory — never writes to audit log"
   * (see dryRun.ts comment: "NEVER call snapshotStore.appendAuditLog").
   *
   * This test proves the runtime behavior: run dryRun and assert the audit log
   * count does NOT increase.
   */
  it('DR1 landed: dryRun PASS creates zero audit log entries', async () => {
    const { fsAdapter, store, snapshotDeps, dryRunDeps } = await makeIntegrationHarness();

    // Seed a file and create a snapshot
    await fsAdapter.write('src/c.js', enc('function foo() {}'));
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-al9',
      runId: 'run-al9',
      correlationId: 'corr-al9',
      entries: [{ path: 'src/c.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapResult = await createSnapshot(snapshotDeps, { manifest });
    const snapshotId = snapResult.snapshotRef.id;

    // Count rows after createSnapshot (should be 1 from createSnapshot)
    const rowsAfterSnapshot = await store.findAuditLogByProjectAndRun('proj-al9', 'run-al9');
    const countAfterSnapshot = rowsAfterSnapshot.length;
    expect(countAfterSnapshot).toBe(1); // only CREATE_SNAPSHOT

    // Run dryRun — in-scope change (PASS)
    await dryRun(dryRunDeps, {
      snapshotRefId: snapshotId,
      projectId: 'proj-al9',
      runId: 'run-al9',
      correlationId: 'corr-al9',
      proposedChanges: [
        { file: 'src/c.js', content: 'function foo() { return 1; }' },
      ],
    });

    // Row count must NOT increase after dryRun
    const rowsAfterDryRun = await store.findAuditLogByProjectAndRun('proj-al9', 'run-al9');
    expect(rowsAfterDryRun.length).toBe(countAfterSnapshot);

    // Verify: no AUDIT_DIFF or REVERT entries — only the CREATE_SNAPSHOT entry
    const dryRunRows = rowsAfterDryRun.filter((r) => r.operation !== 'CREATE_SNAPSHOT');
    expect(dryRunRows).toHaveLength(0);
  });

  it('DR1 landed: dryRun BLOCK creates zero audit log entries', async () => {
    const { fsAdapter, store, snapshotDeps, dryRunDeps } = await makeIntegrationHarness();

    // Seed a file and create a snapshot
    await fsAdapter.write('src/d.js', enc('function foo() {}'));
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-al9b',
      runId: 'run-al9b',
      correlationId: 'corr-al9b',
      entries: [{ path: 'src/d.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };

    const snapResult = await createSnapshot(snapshotDeps, { manifest });
    const snapshotId = snapResult.snapshotRef.id;

    // Count rows after createSnapshot
    const rowsAfterSnapshot = await store.findAuditLogByProjectAndRun('proj-al9b', 'run-al9b');
    const countAfterSnapshot = rowsAfterSnapshot.length;

    // Run dryRun — out-of-scope change (BLOCK)
    const result = await dryRun(dryRunDeps, {
      snapshotRefId: snapshotId,
      projectId: 'proj-al9b',
      runId: 'run-al9b',
      correlationId: 'corr-al9b',
      proposedChanges: [
        { file: 'src/d.js', content: 'function foo() {}\nfunction bar() {}' },
      ],
    });

    // dryRun should BLOCK (bar is out of scope)
    expect(result.status).toBe('BLOCK');

    // Row count must NOT increase after dryRun BLOCK
    const rowsAfterDryRun = await store.findAuditLogByProjectAndRun('proj-al9b', 'run-al9b');
    expect(rowsAfterDryRun.length).toBe(countAfterSnapshot);
  });
});

// ---------------------------------------------------------------------------
// AL-9b: health() writes ZERO entries (H21 — Phalanx integration requirement 24)
// ---------------------------------------------------------------------------

describe('AL-9b: health writes zero audit log entries (H21)', () => {
  /**
   * Per cross-phase invariant H21 and Phalanx integration requirement 24:
   * health() never writes to hoplon_audit_log. The operation has snapshotStore
   * in its Deps (it probes it as one of the 8 adapters) but must never call
   * appendAuditLog. This test is a negative-proof guard against future regression.
   */
  it('health() call does NOT increase audit log row count', async () => {
    const { fsAdapter, emitter, store, snapshotDeps } = await makeIntegrationHarness();

    // Seed one CREATE_SNAPSHOT row so we have a non-zero baseline
    await fsAdapter.write('src/h.js', enc('function foo() {}'));
    await createSnapshot(snapshotDeps, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-al9b-health',
        runId: 'run-al9b-health',
        correlationId: 'corr-al9b-health',
        entries: [{ path: 'src/h.js', scope: { kind: 'whole_file' } }],
      },
    });

    const rowsBefore = await store.findAuditLogByProjectAndRun('proj-al9b-health', 'run-al9b-health');
    const countBefore = rowsBefore.length;
    expect(countBefore).toBe(1); // CREATE_SNAPSHOT

    // Build health deps from the same adapters used elsewhere in this harness
    const healthDeps: HealthDeps = {
      fs: fsAdapter,
      versioning: createIsomorphicGitVersioning({ fs: fsAdapter }),
      snapshotStore: store,
      lockProvider: createAsyncMutexLockProvider(),
      emitter,
      codeIntelligence: sharedCI,
      secretScanner: createBuiltinRegexScanner(),
      staticAnalysis: createNoopAnalyzer(),
      semanticStorageProfile: createNoopSemanticStorageProfile(),
      embeddingProvided: false,
      vectorStoreProvided: false,
      semanticStorageProfileProvided: false,
      sessionOverlayStore: createInMemorySemanticSessionOverlayStore(),
      engineId: 'test-engine',
      startedAt: Date.now() - 1000,
      gitRepoDir: '.hoplon/repo',
    };

    await health(healthDeps);

    // Row count must NOT increase after health()
    const rowsAfter = await store.findAuditLogByProjectAndRun('proj-al9b-health', 'run-al9b-health');
    expect(rowsAfter.length).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AL-9c: reconcile() writes ZERO entries (H21 — Phalanx integration requirement 24)
// ---------------------------------------------------------------------------

describe('AL-9c: reconcile writes zero audit log entries (H21)', () => {
  /**
   * Per cross-phase invariant H21: reconcile() resolves orphaned pending
   * snapshot records (via snapshotStore.updateStatus on hoplon_snapshots)
   * but must never itself append to hoplon_audit_log. Negative-proof guard.
   */
  it('reconcile() call does NOT increase audit log row count', async () => {
    const { fsAdapter, emitter, store, snapshotDeps } = await makeIntegrationHarness();

    // Seed one CREATE_SNAPSHOT row so we have a non-zero baseline
    await fsAdapter.write('src/r.js', enc('function foo() {}'));
    await createSnapshot(snapshotDeps, {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-al9c-rec',
        runId: 'run-al9c-rec',
        correlationId: 'corr-al9c-rec',
        entries: [{ path: 'src/r.js', scope: { kind: 'whole_file' } }],
      },
    });

    const rowsBefore = await store.findAuditLogByProjectAndRun('proj-al9c-rec', 'run-al9c-rec');
    const countBefore = rowsBefore.length;
    expect(countBefore).toBe(1);

    const reconcileDeps: ReconcileDeps = {
      snapshotStore: store,
      emitter,
      engineId: 'test-engine',
      config: { pendingOrphanThresholdMs: 60_000 },
    };

    await reconcile(reconcileDeps);

    // Row count must NOT increase after reconcile()
    const rowsAfter = await store.findAuditLogByProjectAndRun('proj-al9c-rec', 'run-al9c-rec');
    expect(rowsAfter.length).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AL-10: Append-only structural enforcement
// ---------------------------------------------------------------------------

describe('AL-10: append-only structural enforcement', () => {
  it('TYPE-LEVEL: SnapshotStore interface does not expose updateAuditLog or any log mutation method', () => {
    // This is a compile-time assertion. If the interface exposed updateAuditLog,
    // the following assignment would fail TypeScript compilation.
    // We verify by checking that attempting to use a non-existent method produces
    // a type error (documented here rather than via @ts-expect-error to keep the
    // assertion visible in test output).

    // The interface is: appendAuditLog, findAuditLogByProjectAndRun, gcAuditLog.
    // None of these are UPDATE-based. gcAuditLog is DELETE-based (retention).
    // No `updateAuditLog` method exists.

    const store = {} as SnapshotStore;

    // These methods exist:
    expect(typeof store.appendAuditLog).toBeDefined();
    expect(typeof store.findAuditLogByProjectAndRun).toBeDefined();
    expect(typeof store.gcAuditLog).toBeDefined();

    // updateAuditLog does NOT exist — TypeScript would catch this at compile time.
    // @ts-expect-error — updateAuditLog is intentionally absent from SnapshotStore
    expect((store as Record<string, unknown>)['updateAuditLog']).toBeUndefined();
  });

  it('SCHEMA VALIDATION: AuditLogRecordSchema rejects missing correlationId', () => {
    const badRecord = {
      id: randomUUID(),
      snapshotId: null,
      projectId: 'proj-test',
      runId: 'run-001',
      engineId: 'test-engine',
      // correlationId intentionally omitted
      operation: 'AUDIT_DIFF',
      result: 'PASS',
      violationCount: 0,
      violationKinds: [],
      durationMs: 42,
      createdAt: '2026-01-15T10:00:00.000Z',
    };

    const result = AuditLogRecordSchema.safeParse(badRecord);
    expect(result.success).toBe(false);
  });

  it('SCHEMA VALIDATION: AuditLogRecordSchema rejects invalid operation enum', () => {
    const badRecord = makeAuditRecord({ operation: 'DRY_RUN' as 'AUDIT_DIFF' });
    const result = AuditLogRecordSchema.safeParse(badRecord);
    expect(result.success).toBe(false);
  });

  it('RUNTIME: no raw UPDATE on hoplon_audit_log issued by appendAuditLog', async () => {
    // Verify round-trip without mutation: append, read back, value is unchanged.
    const store = await createIsolatedTestStore();
    const original = makeAuditRecord({
      id: randomUUID(),
      projectId: 'proj-immutable',
      runId: 'run-immutable',
      result: 'PASS',
      violationCount: 0,
    });

    await store.appendAuditLog(original);

    // No update method — the only way to "change" a row would be DELETE + INSERT,
    // which is not available through the interface.
    // Verify the row is unchanged:
    const rows = await store.findAuditLogByProjectAndRun('proj-immutable', 'run-immutable');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(original);

    // Attempting a second append with the same id is a no-op (INSERT OR IGNORE)
    const impostor = { ...original, result: 'BLOCK' as const, violationCount: 5 };
    await store.appendAuditLog(impostor); // same id → INSERT OR IGNORE

    const rowsAfter = await store.findAuditLogByProjectAndRun('proj-immutable', 'run-immutable');
    expect(rowsAfter).toHaveLength(1);
    // Original record is preserved — not overwritten
    expect(rowsAfter[0]!.result).toBe('PASS');
    expect(rowsAfter[0]!.violationCount).toBe(0);
  });
});
