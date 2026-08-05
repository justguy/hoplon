/**
 * tests/adapters/snapshotStore/postgres.test.ts — PG1 PostgreSQL SnapshotStore tests.
 *
 * Primary test path: uses `pg-mem` (pure-JS PG emulator — no Docker, no network).
 * All contract tests run in CI without external services.
 *
 * Test inventory:
 *
 * Contract tests (Phase 1 SnapshotStore contract — mirrors SQLite contract tests):
 *   PG1-C1.  put() + get() round-trip — basic record persists and reads back
 *   PG1-C2.  put() is idempotent on id (INSERT ON CONFLICT DO NOTHING)
 *   PG1-C3.  get() returns null for unknown id
 *   PG1-C4.  findByProjectAndRun() returns records for project+run, ordered by createdAt
 *   PG1-C5.  findByProjectAndRun() returns [] for unknown project+run
 *   PG1-C6.  updateStatus() pending → committed with gitRef
 *   PG1-C7.  updateStatus() pending → failed with statusReason
 *   PG1-C8.  listPending() returns only pending records older than cutoff
 *   PG1-C9.  gc() with projectId filter deletes matching records
 *   PG1-C10. gc() with olderThan filter deletes old records
 *   PG1-C11. gc() with expiredBefore (TTL) filter
 *   PG1-C12. gc() without any filter throws ValidationError(invalid_scope)
 *
 * H10 two-phase atomic write proof:
 *   PG1-H10-1. put() inserts as pending; crash simulation (no updateStatus called);
 *              listPending() finds orphan; updateStatus('failed') reconciles it
 *   PG1-H10-2. Full happy-path two-phase: put pending → updateStatus committed → get confirms
 *
 * DS1 replica tracking (H23):
 *   PG1-DS1-1. setReplicaIds() + listByReplica() round-trip
 *   PG1-DS1-2. listByReplica() returns only matching records
 *   PG1-DS1-3. setReplicaIds([]) clears replica confirmations
 *   PG1-DS1-4. listByReplica() returns [] when no match
 *
 * ML2 audit log columns:
 *   PG1-ML2-1. appendAuditLog() with ML2 columns populated reads back correctly
 *   PG1-ML2-2. appendAuditLog() with ML2 columns null reads back as null
 *
 * H21 append-only discipline:
 *   PG1-H21-1. appendAuditLog() is idempotent on id (re-insert same UUID = no-op)
 *   PG1-H21-2. findAuditLogByProjectAndRun() returns entries ordered by createdAt
 *   PG1-H21-3. gcAuditLog() with projectId filter deletes matching rows
 *   PG1-H21-4. gcAuditLog() without any filter throws ValidationError(invalid_scope)
 *
 * t-134 audit-log integrity hash chain:
 *   PG1-T134-1. verifyAuditLogIntegrity() returns PASS for chained rows
 *   PG1-T134-2. verifyAuditLogIntegrity() returns FAIL after row metadata tampering
 *   PG1-T134-3. verifyAuditLogIntegrity() returns UNCHECKED for legacy rows
 *
 * HA1 backward-compat:
 *   PG1-HA1-1. get() with sha256: prefix finds record stored under bare hex id
 *   PG1-HA1-2. get() with bare hex id finds record stored under sha256: prefix id
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createIsolatedPgTestStore,
  createPostgresSnapshotStore,
} from '../../../src/hoplon/adapters/snapshotStore/postgres.js';
import { ValidationError } from '../../../src/hoplon/contracts/errors.js';
import type { SnapshotRecord, SnapshotStore } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';
import type { AuditLogRecord } from '../../../src/hoplon/contracts/auditLog.js';

type AuditLogIntegrityRequest = {
  projectId: string;
  runId?: string;
  since?: string;
  until?: string;
};

type AuditLogIntegrityStore = SnapshotStore & {
  verifyAuditLogIntegrity(request: AuditLogIntegrityRequest): Promise<unknown>;
};

function asIntegrityStore(candidate: SnapshotStore): AuditLogIntegrityStore {
  const method = (candidate as { verifyAuditLogIntegrity?: unknown }).verifyAuditLogIntegrity;
  expect(typeof method).toBe('function');
  return candidate as AuditLogIntegrityStore;
}

function integrityResultStatus(result: unknown): string {
  if (typeof result !== 'object' || result === null) {
    throw new TypeError('integrity result must be an object');
  }
  const record = result as Record<string, unknown>;
  const status = record['status'] ?? record['result'] ?? record['outcome'];
  if (typeof status !== 'string') {
    throw new TypeError('integrity result must expose status, result, or outcome');
  }
  return status;
}

async function createPgMemStoreWithPool(): Promise<{
  store: AuditLogIntegrityStore;
  pool: Pool;
}> {
  const { newDb } = await import('pg-mem');
  const db = newDb();
  const adapters = db.adapters.createPg();
  const pool = new adapters.Pool() as Pool;
  const pgStore = await createPostgresSnapshotStore({ pool });
  return { store: asIntegrityStore(pgStore), pool };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<WritableManifest> = {}): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-pg1',
    runId: 'run-pg1',
    correlationId: 'corr-pg1',
    entries: [{ path: 'src/index.ts', scope: { kind: 'whole_file' } }],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  const id = overrides.id ?? 'a'.repeat(64);
  return {
    id,
    manifestSchemaVersion: 1,
    engineId: 'local-0',
    projectId: 'proj-pg1',
    runId: 'run-pg1',
    correlationId: 'corr-pg1',
    status: 'pending',
    statusReason: null,
    gitRef: null,
    manifest: makeManifest(),
    createdAt: '2026-04-13T00:00:00.000Z',
    ttlExpires: null,
    replicaIds: [],
    ...overrides,
  };
}

function makeAuditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: 'a'.repeat(64),
    projectId: 'proj-pg1',
    runId: 'run-pg1',
    engineId: 'local-0',
    correlationId: 'corr-pg1',
    operation: 'AUDIT_DIFF',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 42,
    createdAt: '2026-04-13T00:00:00.000Z',
    astNodeCount: null,
    fileLineCount: null,
    manifestScopeRatio: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared store fixture — fresh pg-mem instance per test
// ---------------------------------------------------------------------------

let store: SnapshotStore;

beforeEach(async () => {
  store = await createIsolatedPgTestStore();
});

// ---------------------------------------------------------------------------
// PG1-C1: put() + get() round-trip
// ---------------------------------------------------------------------------

describe('PG1-C1: put() + get() round-trip', () => {
  it('stores a record and reads it back with all fields intact', async () => {
    const record = makeRecord({
      id: '1'.repeat(64),
      status: 'committed',
      gitRef: 'deadbeef',
      statusReason: null,
    });

    await store.put(record);
    const retrieved = await store.get(record.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(record.id);
    expect(retrieved!.status).toBe('committed');
    expect(retrieved!.gitRef).toBe('deadbeef');
    expect(retrieved!.projectId).toBe('proj-pg1');
    expect(retrieved!.replicaIds).toEqual([]);
    expect(retrieved!.manifest).toEqual(record.manifest);
  });
});

// ---------------------------------------------------------------------------
// PG1-C2: put() is idempotent on id
// ---------------------------------------------------------------------------

describe('PG1-C2: put() is idempotent on id', () => {
  it('re-inserting the same id is a no-op (INSERT ON CONFLICT DO NOTHING)', async () => {
    const record = makeRecord({ id: '2'.repeat(64), status: 'pending' });
    await store.put(record);

    // Attempt to re-insert with different fields — should be silently ignored
    const modified = { ...record, status: 'committed' as const, gitRef: 'should-not-persist' };
    await store.put(modified);

    const retrieved = await store.get(record.id);
    expect(retrieved!.status).toBe('pending');  // original value preserved
    expect(retrieved!.gitRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C3: get() returns null for unknown id
// ---------------------------------------------------------------------------

describe('PG1-C3: get() returns null for unknown id', () => {
  it('returns null when the id does not exist in the store', async () => {
    const result = await store.get('f'.repeat(64));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C4: findByProjectAndRun() returns records ordered by createdAt
// ---------------------------------------------------------------------------

describe('PG1-C4: findByProjectAndRun() returns ordered records', () => {
  it('returns all records for the given project+run ordered by createdAt ascending', async () => {
    const r1 = makeRecord({
      id: '3'.repeat(64),
      createdAt: '2026-04-13T00:00:01.000Z',
      correlationId: 'c1',
      manifest: makeManifest({ correlationId: 'c1' }),
    });
    const r2 = makeRecord({
      id: '4'.repeat(64),
      createdAt: '2026-04-13T00:00:02.000Z',
      correlationId: 'c2',
      manifest: makeManifest({ correlationId: 'c2' }),
    });
    const r3 = makeRecord({
      id: '5'.repeat(64),
      projectId: 'other-project',
      createdAt: '2026-04-13T00:00:00.000Z',
      manifest: makeManifest({ projectId: 'other-project' }),
    });

    await store.put(r2);  // insert out-of-order to verify sorting
    await store.put(r1);
    await store.put(r3);

    const results = await store.findByProjectAndRun('proj-pg1', 'run-pg1');

    // Only records for proj-pg1 + run-pg1 — not r3
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe(r1.id);  // earlier createdAt first
    expect(results[1]!.id).toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// PG1-C5: findByProjectAndRun() returns [] for unknown project+run
// ---------------------------------------------------------------------------

describe('PG1-C5: findByProjectAndRun() returns [] for unknown project+run', () => {
  it('returns empty array when no records match', async () => {
    const result = await store.findByProjectAndRun('no-such-project', 'no-such-run');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PG1-C6: updateStatus() pending → committed
// ---------------------------------------------------------------------------

describe('PG1-C6: updateStatus() pending → committed', () => {
  it('transitions status to committed and persists gitRef', async () => {
    const record = makeRecord({ id: '6'.repeat(64), status: 'pending' });
    await store.put(record);

    await store.updateStatus(record.id, 'committed', undefined, 'abc123gitref');

    const updated = await store.get(record.id);
    expect(updated!.status).toBe('committed');
    expect(updated!.gitRef).toBe('abc123gitref');
    expect(updated!.statusReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C7: updateStatus() pending → failed
// ---------------------------------------------------------------------------

describe('PG1-C7: updateStatus() pending → failed', () => {
  it('transitions status to failed with a reason', async () => {
    const record = makeRecord({ id: '7'.repeat(64), status: 'pending' });
    await store.put(record);

    await store.updateStatus(record.id, 'failed', 'git commit crashed');

    const updated = await store.get(record.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.statusReason).toBe('git commit crashed');
    expect(updated!.gitRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C8: listPending() returns only pending records older than cutoff
// ---------------------------------------------------------------------------

describe('PG1-C8: listPending() returns only pending records older than cutoff', () => {
  it('returns pending records older than the cutoff; excludes recent and non-pending', async () => {
    const old = makeRecord({
      id: '8'.repeat(64),
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',  // old
    });
    const recent = makeRecord({
      id: '9'.repeat(64),
      status: 'pending',
      createdAt: new Date(Date.now() + 60_000).toISOString(),  // future
      correlationId: 'c-recent',
      manifest: makeManifest({ correlationId: 'c-recent' }),
    });
    const committed = makeRecord({
      id: 'a'.repeat(64),
      status: 'committed',
      createdAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'c-committed',
      manifest: makeManifest({ correlationId: 'c-committed' }),
    });

    await store.put(old);
    await store.put(recent);
    await store.put(committed);

    // Cutoff: anything older than 1 second ago (old record qualifies)
    const pending = await store.listPending(1000);

    expect(pending.map((r) => r.id)).toContain(old.id);
    expect(pending.map((r) => r.id)).not.toContain(recent.id);
    expect(pending.map((r) => r.id)).not.toContain(committed.id);
  });
});

// ---------------------------------------------------------------------------
// PG1-C9: gc() with projectId filter
// ---------------------------------------------------------------------------

describe('PG1-C9: gc() with projectId filter', () => {
  it('deletes only records matching projectId', async () => {
    const r1 = makeRecord({
      id: 'b'.repeat(64),
      projectId: 'to-delete',
      manifest: makeManifest({ projectId: 'to-delete' }),
    });
    const r2 = makeRecord({
      id: 'c'.repeat(64),
      projectId: 'keep-this',
      correlationId: 'c2',
      manifest: makeManifest({ projectId: 'keep-this', correlationId: 'c2' }),
    });

    await store.put(r1);
    await store.put(r2);

    const result = await store.gc({ projectId: 'to-delete' });
    expect(result.deletedCount).toBe(1);

    expect(await store.get(r1.id)).toBeNull();
    expect(await store.get(r2.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C10: gc() with olderThan filter
// ---------------------------------------------------------------------------

describe('PG1-C10: gc() with olderThan filter', () => {
  it('deletes records older than the given ISO timestamp', async () => {
    const r1 = makeRecord({
      id: 'd'.repeat(64),
      createdAt: '2025-01-01T00:00:00.000Z',
      correlationId: 'c-old',
      manifest: makeManifest({ correlationId: 'c-old' }),
    });
    const r2 = makeRecord({
      id: 'e'.repeat(64),
      createdAt: '2027-01-01T00:00:00.000Z',
      correlationId: 'c-new',
      manifest: makeManifest({ correlationId: 'c-new' }),
    });

    await store.put(r1);
    await store.put(r2);

    const result = await store.gc({ olderThan: '2026-01-01T00:00:00.000Z' });
    expect(result.deletedCount).toBe(1);

    expect(await store.get(r1.id)).toBeNull();
    expect(await store.get(r2.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-C11: gc() with expiredBefore (TTL) filter
// ---------------------------------------------------------------------------

describe('PG1-C11: gc() with expiredBefore TTL filter', () => {
  it('deletes records where ttl_expires is set and has passed', async () => {
    const r1 = makeRecord({
      id: 'f'.repeat(64),
      ttlExpires: '2025-06-01T00:00:00.000Z',  // expired
      correlationId: 'c-expired',
      manifest: makeManifest({ correlationId: 'c-expired' }),
    });
    const r2 = makeRecord({
      id: '0'.repeat(64),
      ttlExpires: '2027-06-01T00:00:00.000Z',  // not yet expired
      correlationId: 'c-not-expired',
      manifest: makeManifest({ correlationId: 'c-not-expired' }),
    });
    const r3 = makeRecord({
      id: '1'.repeat(64),
      ttlExpires: null,  // no TTL
      correlationId: 'c-no-ttl',
      manifest: makeManifest({ correlationId: 'c-no-ttl' }),
    });

    await store.put(r1);
    await store.put(r2);
    await store.put(r3);

    const result = await store.gc({ expiredBefore: '2026-01-01T00:00:00.000Z' });
    expect(result.deletedCount).toBe(1);

    expect(await store.get(r1.id)).toBeNull();    // expired → deleted
    expect(await store.get(r2.id)).not.toBeNull(); // not yet expired
    expect(await store.get(r3.id)).not.toBeNull(); // no TTL → never deleted by expiredBefore
  });
});

// ---------------------------------------------------------------------------
// PG1-C12: gc() without any filter throws ValidationError
// ---------------------------------------------------------------------------

describe('PG1-C12: gc() without filter throws ValidationError(invalid_scope)', () => {
  it('throws ValidationError when no filter is provided', async () => {
    await expect(store.gc({})).rejects.toSatisfy(
      (err: unknown) => err instanceof ValidationError && err.kind === 'invalid_scope',
    );
  });
});

// ---------------------------------------------------------------------------
// PG1-H10-1: Two-phase atomic write — crash simulation
// ---------------------------------------------------------------------------

describe('PG1-H10: two-phase atomic write', () => {
  it('PG1-H10-1: crash between pending insert and committed update — listPending finds orphan, reconcile converts to failed', async () => {
    const record = makeRecord({
      id: '2'.repeat(64),
      status: 'pending',
      // Simulate an old pending record (1 hour ago)
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    // Step 1: put() inserts as pending
    await store.put(record);

    // Verify it's pending
    const afterPut = await store.get(record.id);
    expect(afterPut!.status).toBe('pending');

    // Step 2: simulate crash — updateStatus('committed') is never called
    // Step 3: reconcile finds the orphan via listPending
    const orphans = await store.listPending(1000); // older than 1 second
    expect(orphans.map((r) => r.id)).toContain(record.id);

    // Step 4: reconcile converts to failed
    await store.updateStatus(record.id, 'failed', 'reconcile: orphaned pending snapshot');

    const reconciled = await store.get(record.id);
    expect(reconciled!.status).toBe('failed');
    expect(reconciled!.statusReason).toBe('reconcile: orphaned pending snapshot');
  });

  it('PG1-H10-2: happy-path two-phase — put pending → updateStatus committed → get confirms', async () => {
    const record = makeRecord({
      id: '3'.repeat(64),
      status: 'pending',
    });

    // Phase 1: insert pending
    await store.put(record);
    const pendingState = await store.get(record.id);
    expect(pendingState!.status).toBe('pending');
    expect(pendingState!.gitRef).toBeNull();

    // Phase 2: caller commits git, then calls updateStatus
    await store.updateStatus(record.id, 'committed', undefined, 'abc123sha');

    const committedState = await store.get(record.id);
    expect(committedState!.status).toBe('committed');
    expect(committedState!.gitRef).toBe('abc123sha');

    // Verify it does NOT appear in listPending
    const pending = await store.listPending(0);
    expect(pending.map((r) => r.id)).not.toContain(record.id);
  });
});

// ---------------------------------------------------------------------------
// PG1-DS1: DS1 optional methods — listByReplica + setReplicaIds
// ---------------------------------------------------------------------------

describe('PG1-DS1: DS1 replica tracking (H23)', () => {
  it('PG1-DS1-1: setReplicaIds() + listByReplica() round-trip', async () => {
    const record = makeRecord({ id: '4'.repeat(64), replicaIds: [] });
    await store.put(record);

    expect(typeof store.setReplicaIds).toBe('function');
    expect(typeof store.listByReplica).toBe('function');

    await store.setReplicaIds!(record.id, ['node-alpha']);

    const updated = await store.get(record.id);
    expect(updated!.replicaIds).toEqual(['node-alpha']);

    const byReplica = await store.listByReplica!('node-alpha');
    expect(byReplica).toHaveLength(1);
    expect(byReplica[0]!.id).toBe(record.id);
  });

  it('PG1-DS1-2: listByReplica() returns only matching records', async () => {
    const r1 = makeRecord({
      id: '5'.repeat(64),
      replicaIds: ['node-alpha'],
      correlationId: 'c1',
      manifest: makeManifest({ correlationId: 'c1' }),
    });
    const r2 = makeRecord({
      id: '6'.repeat(64),
      replicaIds: ['node-beta'],
      correlationId: 'c2',
      manifest: makeManifest({ correlationId: 'c2' }),
    });
    const r3 = makeRecord({
      id: '7'.repeat(64),
      replicaIds: ['node-alpha', 'node-beta'],
      correlationId: 'c3',
      manifest: makeManifest({ correlationId: 'c3' }),
    });

    await store.put(r1);
    await store.put(r2);
    await store.put(r3);

    const alphaRecords = await store.listByReplica!('node-alpha');
    const betaRecords = await store.listByReplica!('node-beta');
    const gammaRecords = await store.listByReplica!('node-gamma');

    expect(alphaRecords.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());
    expect(betaRecords.map((r) => r.id).sort()).toEqual([r2.id, r3.id].sort());
    expect(gammaRecords).toHaveLength(0);
  });

  it('PG1-DS1-3: setReplicaIds([]) clears all replica confirmations', async () => {
    const record = makeRecord({ id: '8'.repeat(64), replicaIds: ['node-alpha'] });
    await store.put(record);

    await store.setReplicaIds!(record.id, []);

    const cleared = await store.get(record.id);
    expect(cleared!.replicaIds).toEqual([]);

    const byAlpha = await store.listByReplica!('node-alpha');
    expect(byAlpha.map((r) => r.id)).not.toContain(record.id);
  });

  it('PG1-DS1-4: listByReplica() returns [] when no match', async () => {
    const result = await store.listByReplica!('no-such-replica');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PG1-ML2: ML2 audit log columns
// ---------------------------------------------------------------------------

describe('PG1-ML2: ML2 audit log columns', () => {
  it('PG1-ML2-1: appendAuditLog() with ML2 columns populated reads back correctly', async () => {
    const snapshot = makeRecord({ id: '9'.repeat(64), status: 'committed', gitRef: 'abc' });
    await store.put(snapshot);

    const logRecord = makeAuditRecord({
      snapshotId: snapshot.id,
      astNodeCount: 1234,
      fileLineCount: 567,
      manifestScopeRatio: 0.75,
    });

    await store.appendAuditLog(logRecord);

    const entries = await store.findAuditLogByProjectAndRun('proj-pg1', 'run-pg1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.astNodeCount).toBe(1234);
    expect(entries[0]!.fileLineCount).toBe(567);
    expect(entries[0]!.manifestScopeRatio).toBeCloseTo(0.75);
  });

  it('PG1-ML2-2: appendAuditLog() with ML2 columns null reads back as null', async () => {
    const logRecord = makeAuditRecord({
      astNodeCount: null,
      fileLineCount: null,
      manifestScopeRatio: null,
    });

    await store.appendAuditLog(logRecord);

    const entries = await store.findAuditLogByProjectAndRun('proj-pg1', 'run-pg1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.astNodeCount ?? null).toBeNull();
    expect(entries[0]!.fileLineCount ?? null).toBeNull();
    expect(entries[0]!.manifestScopeRatio ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG1-H21: Append-only audit log discipline
// ---------------------------------------------------------------------------

describe('PG1-H21: append-only audit log (H21)', () => {
  it('PG1-H21-1: appendAuditLog() is idempotent on id (re-insert same UUID = no-op)', async () => {
    const logRecord = makeAuditRecord({ violationCount: 0, result: 'PASS' });
    await store.appendAuditLog(logRecord);

    // Re-insert with different fields — should be silently ignored (H21)
    const modified: AuditLogRecord = { ...logRecord, result: 'BLOCK', violationCount: 3 };
    await store.appendAuditLog(modified);

    const entries = await store.findAuditLogByProjectAndRun('proj-pg1', 'run-pg1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.result).toBe('PASS');        // original preserved
    expect(entries[0]!.violationCount).toBe(0);
  });

  it('PG1-H21-2: findAuditLogByProjectAndRun() returns entries ordered by createdAt ascending', async () => {
    const r1 = makeAuditRecord({
      createdAt: '2026-04-13T00:00:01.000Z',
      violationKinds: ['first'],
    });
    const r2 = makeAuditRecord({
      createdAt: '2026-04-13T00:00:02.000Z',
      violationKinds: ['second'],
    });

    // Insert out-of-order
    await store.appendAuditLog(r2);
    await store.appendAuditLog(r1);

    const entries = await store.findAuditLogByProjectAndRun('proj-pg1', 'run-pg1');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.violationKinds).toEqual(['first']);   // earlier first
    expect(entries[1]!.violationKinds).toEqual(['second']);
  });

  it('PG1-H21-3: gcAuditLog() with projectId filter deletes matching rows', async () => {
    const r1 = makeAuditRecord({ projectId: 'to-delete' });
    const r2 = makeAuditRecord({ projectId: 'keep-this' });

    await store.appendAuditLog(r1);
    await store.appendAuditLog(r2);

    const result = await store.gcAuditLog({ projectId: 'to-delete' });
    expect(result.deletedCount).toBe(1);

    const remaining = await store.findAuditLogByProjectAndRun('keep-this', 'run-pg1');
    expect(remaining).toHaveLength(1);
  });

  it('PG1-H21-4: gcAuditLog() without filter throws ValidationError(invalid_scope)', async () => {
    await expect(store.gcAuditLog({})).rejects.toSatisfy(
      (err: unknown) => err instanceof ValidationError && err.kind === 'invalid_scope',
    );
  });
});

// ---------------------------------------------------------------------------
// PG1-T134: SOC2 audit-log integrity hash chain
// ---------------------------------------------------------------------------

describe('PG1-T134: audit-log integrity hash chain', () => {
  it('PG1-T134-1: verifyAuditLogIntegrity() returns PASS for chained rows', async () => {
    const integrityStore = asIntegrityStore(store);

    await integrityStore.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      createdAt: '2026-04-13T00:00:01.000Z',
      correlationId: 'corr-chain-1',
    }));
    await integrityStore.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      createdAt: '2026-04-13T00:00:02.000Z',
      correlationId: 'corr-chain-2',
      violationCount: 1,
      violationKinds: ['contract_scope'],
      result: 'BLOCK',
    }));
    await integrityStore.appendAuditLog(makeAuditRecord({
      id: randomUUID(),
      createdAt: '2026-04-13T00:00:03.000Z',
      correlationId: 'corr-chain-3',
      astNodeCount: 12,
      fileLineCount: 34,
      manifestScopeRatio: 0.25,
    }));

    const result = await integrityStore.verifyAuditLogIntegrity({
      projectId: 'proj-pg1',
      runId: 'run-pg1',
      since: '2026-04-13T00:00:00.000Z',
      until: '2026-04-13T00:00:04.000Z',
    });

    expect(integrityResultStatus(result)).toBe('PASS');
  });

  it('PG1-T134-2: verifyAuditLogIntegrity() returns FAIL after row metadata tampering', async () => {
    const { store: integrityStore, pool } = await createPgMemStoreWithPool();
    const tamperedId = randomUUID();

    try {
      await integrityStore.appendAuditLog(makeAuditRecord({
        id: randomUUID(),
        createdAt: '2026-04-13T00:00:01.000Z',
        correlationId: 'corr-tamper-1',
      }));
      await integrityStore.appendAuditLog(makeAuditRecord({
        id: tamperedId,
        createdAt: '2026-04-13T00:00:02.000Z',
        correlationId: 'corr-tamper-2',
        violationCount: 1,
        violationKinds: ['contract_scope'],
        result: 'BLOCK',
        manifestScopeRatio: 0.25,
      }));

      await pool.query(
        `UPDATE hoplon_audit_log
            SET violation_count = $1,
                manifest_scope_ratio = $2
          WHERE id = $3`,
        [9, 0.99, tamperedId],
      );

      const result = await integrityStore.verifyAuditLogIntegrity({
        projectId: 'proj-pg1',
        runId: 'run-pg1',
      });

      expect(integrityResultStatus(result)).toBe('FAIL');
    } finally {
      await pool.end();
    }
  });

  it('PG1-T134-3: verifyAuditLogIntegrity() returns UNCHECKED for legacy rows', async () => {
    const { store: integrityStore, pool } = await createPgMemStoreWithPool();

    try {
      await pool.query(
        `INSERT INTO hoplon_audit_log (
          id, snapshot_id, project_id, run_id, engine_id, correlation_id,
          operation, result, violation_count, violation_kinds, duration_ms, created_at,
          ast_node_count, file_line_count, manifest_scope_ratio, policy_event
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          randomUUID(),
          'a'.repeat(64),
          'legacy-project',
          'legacy-run',
          'local-0',
          'corr-legacy',
          'AUDIT_DIFF',
          'PASS',
          0,
          JSON.stringify([]),
          42,
          '2026-04-13T00:00:01.000Z',
          null,
          null,
          null,
          null,
        ],
      );

      const result = await integrityStore.verifyAuditLogIntegrity({
        projectId: 'legacy-project',
        runId: 'legacy-run',
      });

      expect(integrityResultStatus(result)).toBe('UNCHECKED');
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// PG1-HA1: HA1 hash-prefix backward-compat (sha256: ↔ bare hex)
// ---------------------------------------------------------------------------

describe('PG1-HA1: HA1 hash-prefix backward-compatibility', () => {
  it('PG1-HA1-1: get() with sha256: prefix finds record stored under bare hex id', async () => {
    const bareId = 'a'.repeat(64);
    const record = makeRecord({ id: bareId });
    await store.put(record);

    // Retrieve with prefixed form
    const retrieved = await store.get(`sha256:${bareId}`);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(bareId);
  });

  it('PG1-HA1-2: get() with bare hex id finds record stored under sha256: prefix id', async () => {
    const bareId = 'b'.repeat(64);
    const prefixedId = `sha256:${bareId}`;
    const record = makeRecord({ id: prefixedId });
    await store.put(record);

    // Retrieve with bare hex form
    const retrieved = await store.get(bareId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(prefixedId);
  });
});
