/**
 * DS1 — Distributed schema contract extension tests.
 *
 * Covers the two new optional SnapshotStore methods (H23):
 *   - listByReplica(replicaId): Promise<SnapshotRecord[]>
 *   - setReplicaIds(id, replicaIds: string[]): Promise<void>
 *
 * Also covers the new HoplonEngineConfig.replicaId field (Zod-enforced, optional).
 *
 * Invariant H23: `replica_ids` is the only distributed-state surface;
 * Phase 1/2 adapters may leave it empty.
 *
 * Test inventory:
 *   DS1-1.  1-replica deployment: put snapshot with empty replicaIds, call
 *           setReplicaIds with current node's replicaId, confirm listByReplica
 *           returns the record.
 *   DS1-2.  setReplicaIds round-trip: overwrite existing replicaIds array,
 *           verify updated array reads back correctly.
 *   DS1-3.  listByReplica returns only records listing that replicaId.
 *   DS1-4.  2-replica simulation: two store instances over the same SQLite file
 *           — each calls setReplicaIds with its own replicaId; listByReplica on
 *           either ID returns only the correct record.
 *   DS1-5.  setReplicaIds with empty array clears all replica confirmations.
 *   DS1-6.  listByReplica returns [] when no records match.
 *   DS1-7.  HoplonEngineConfig.replicaId: valid non-empty string accepted (no
 *           config_invalid error from factory).
 *   DS1-8.  HoplonEngineConfig.replicaId: empty string rejected (EngineError
 *           config_invalid thrown before reconcile).
 *   DS1-9.  HoplonEngineConfig.replicaId: omitted (undefined) is accepted.
 *   DS1-10. Phase 1 backward-compat — put/get with replicaIds: [] still works (H23).
 */

import { describe, it, expect } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestStore,
  createSqliteSnapshotStore,
} from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { EngineError } from '../../src/hoplon/contracts/errors.js';
import type { SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<WritableManifest> = {}): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-ds1',
    runId: 'run-ds1',
    correlationId: 'corr-ds1',
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
    projectId: 'proj-ds1',
    runId: 'run-ds1',
    correlationId: 'corr-ds1',
    status: 'committed',
    statusReason: null,
    gitRef: 'abc123',
    manifest: makeManifest(),
    createdAt: '2026-04-13T00:00:00Z',
    ttlExpires: null,
    replicaIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DS1-1. 1-replica deployment — setReplicaIds + listByReplica round-trip
// ---------------------------------------------------------------------------

describe('DS1-1: 1-replica deployment round-trip', () => {
  it('stores a snapshot with empty replicaIds, stamps with replicaId via setReplicaIds, listByReplica finds it', async () => {
    const store = await createIsolatedTestStore();
    const record = makeRecord({ id: '1'.repeat(64), replicaIds: [] });

    await store.put(record);

    // Optional interface methods must exist on SQLite implementation
    expect(typeof store.setReplicaIds).toBe('function');
    expect(typeof store.listByReplica).toBe('function');

    // Stamp the current node's replicaId
    const replicaId = 'node-alpha';
    await store.setReplicaIds!(record.id, [replicaId]);

    // Read back the record — replicaIds must contain node-alpha
    const updated = await store.get(record.id);
    expect(updated).not.toBeNull();
    expect(updated!.replicaIds).toEqual([replicaId]);

    // listByReplica must return this record
    const byReplica = await store.listByReplica!(replicaId);
    expect(byReplica).toHaveLength(1);
    expect(byReplica[0]!.id).toBe(record.id);
  });
});

// ---------------------------------------------------------------------------
// DS1-2. setReplicaIds round-trip — overwrite array
// ---------------------------------------------------------------------------

describe('DS1-2: setReplicaIds overwrites existing array', () => {
  it('replaces a prior replicaIds array with a new one', async () => {
    const store = await createIsolatedTestStore();
    const record = makeRecord({ id: '2'.repeat(64), replicaIds: ['node-old'] });

    await store.put(record);

    // Overwrite with a new set of replica IDs
    await store.setReplicaIds!(record.id, ['node-beta', 'node-gamma']);
    const updated = await store.get(record.id);

    expect(updated!.replicaIds).toEqual(['node-beta', 'node-gamma']);
  });
});

// ---------------------------------------------------------------------------
// DS1-3. listByReplica returns only matching records
// ---------------------------------------------------------------------------

describe('DS1-3: listByReplica filters by replicaId', () => {
  it('returns only records whose replica_ids array contains the queried replicaId', async () => {
    const store = await createIsolatedTestStore();

    const r1 = makeRecord({
      id: '3'.repeat(64),
      replicaIds: ['node-alpha'],
      correlationId: 'c1',
      manifest: makeManifest({ correlationId: 'c1' }),
    });
    const r2 = makeRecord({
      id: '4'.repeat(64),
      replicaIds: ['node-beta'],
      correlationId: 'c2',
      manifest: makeManifest({ correlationId: 'c2' }),
    });
    const r3 = makeRecord({
      id: '5'.repeat(64),
      replicaIds: ['node-alpha', 'node-beta'],  // appears in both
      correlationId: 'c3',
      manifest: makeManifest({ correlationId: 'c3' }),
    });

    await store.put(r1);
    await store.put(r2);
    await store.put(r3);

    const alphaRecords = await store.listByReplica!('node-alpha');
    const betaRecords = await store.listByReplica!('node-beta');
    const gammaRecords = await store.listByReplica!('node-gamma');

    // node-alpha: r1 and r3
    expect(alphaRecords.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());

    // node-beta: r2 and r3
    expect(betaRecords.map((r) => r.id).sort()).toEqual([r2.id, r3.id].sort());

    // node-gamma: none
    expect(gammaRecords).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DS1-4. 2-replica simulation — two store instances over the same SQLite file
// ---------------------------------------------------------------------------

describe('DS1-4: 2-replica simulation over shared SQLite file', () => {
  it('two stores over the same file — each stamps its own replicaId; listByReplica round-trips correctly', async () => {
    const tmpPath = `/tmp/hoplon_ds1_2replica_${randomUUID()}.db`;

    try {
      // Create the initial store and put two records
      const store1 = await createSqliteSnapshotStore({ dbPath: tmpPath });

      const snapshotA = makeRecord({
        id: 'a'.repeat(64),
        replicaIds: [],
        correlationId: 'ca',
        manifest: makeManifest({ correlationId: 'ca' }),
      });
      const snapshotB = makeRecord({
        id: 'b'.repeat(64),
        replicaIds: [],
        correlationId: 'cb',
        manifest: makeManifest({ correlationId: 'cb' }),
      });

      await store1.put(snapshotA);
      await store1.put(snapshotB);

      // store1 (node-1) stamps snapshotA
      await store1.setReplicaIds!(snapshotA.id, ['node-1']);

      // Open a second store instance pointing at the same file (simulates node-2)
      const store2 = await createSqliteSnapshotStore({ dbPath: tmpPath });

      // store2 (node-2) stamps snapshotB
      await store2.setReplicaIds!(snapshotB.id, ['node-2']);

      // Open a third store to read the final state (picks up both writes)
      const storeRead = await createSqliteSnapshotStore({ dbPath: tmpPath });

      // node-1 should see only snapshotA
      const byNode1 = await storeRead.listByReplica!('node-1');
      expect(byNode1).toHaveLength(1);
      expect(byNode1[0]!.id).toBe(snapshotA.id);

      // node-2 should see only snapshotB
      const byNode2 = await storeRead.listByReplica!('node-2');
      expect(byNode2).toHaveLength(1);
      expect(byNode2[0]!.id).toBe(snapshotB.id);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// DS1-5. setReplicaIds with empty array clears all replica confirmations
// ---------------------------------------------------------------------------

describe('DS1-5: setReplicaIds with [] clears replica confirmations', () => {
  it('overwriting with [] removes the record from listByReplica results', async () => {
    const store = await createIsolatedTestStore();
    const record = makeRecord({ id: '6'.repeat(64), replicaIds: ['node-alpha'] });

    await store.put(record);

    // Clear
    await store.setReplicaIds!(record.id, []);
    const cleared = await store.get(record.id);
    expect(cleared!.replicaIds).toEqual([]);

    // listByReplica should no longer find it
    const byAlpha = await store.listByReplica!('node-alpha');
    expect(byAlpha.map((r) => r.id)).not.toContain(record.id);
  });
});

// ---------------------------------------------------------------------------
// DS1-6. listByReplica returns [] when no records match
// ---------------------------------------------------------------------------

describe('DS1-6: listByReplica returns empty array when no match', () => {
  it('returns [] for a replicaId that is not in any record', async () => {
    const store = await createIsolatedTestStore();
    const result = await store.listByReplica!('no-such-replica');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DS1-7. HoplonEngineConfig.replicaId: valid string accepted
// ---------------------------------------------------------------------------

describe('DS1-7: HoplonEngineConfig.replicaId valid string accepted by factory', () => {
  it('createHoplonEngine does NOT throw config_invalid for a valid non-empty replicaId', async () => {
    // Use the buildProofEngine fixture with a replicaId override.
    // buildProofEngine wires all mandatory adapters and passes config overrides
    // into createHoplonEngine — the quickest way to prove Step 3 validation passes.
    const { buildProofEngine } = await import(
      '../proof/phase1/fixtures/buildEngine.js'
    );

    // Should not throw config_invalid — any other error is acceptable
    let threwConfigInvalid = false;
    try {
      await buildProofEngine({ replicaId: 'node-production-1' });
    } catch (err) {
      if (err instanceof EngineError && err.kind === 'config_invalid') {
        threwConfigInvalid = true;
      }
      // Other errors (reconcile_failed, missing_adapter, etc.) are fine —
      // they come AFTER replicaId validation and prove validation passed.
    }

    expect(threwConfigInvalid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DS1-8. HoplonEngineConfig.replicaId: empty string rejected
// ---------------------------------------------------------------------------

describe('DS1-8: HoplonEngineConfig.replicaId empty string rejected by factory', () => {
  it('createHoplonEngine throws EngineError(config_invalid) for replicaId: ""', async () => {
    const { buildProofEngine } = await import(
      '../proof/phase1/fixtures/buildEngine.js'
    );

    await expect(
      buildProofEngine({ replicaId: '' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof EngineError && err.kind === 'config_invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// DS1-9. HoplonEngineConfig.replicaId: omitted (undefined) is accepted
// ---------------------------------------------------------------------------

describe('DS1-9: HoplonEngineConfig.replicaId undefined is accepted (optional)', () => {
  it('createHoplonEngine does NOT throw config_invalid when replicaId is omitted', async () => {
    const { buildProofEngine } = await import(
      '../proof/phase1/fixtures/buildEngine.js'
    );

    // replicaId is omitted from the override — should not trigger config_invalid
    let threwConfigInvalid = false;
    try {
      await buildProofEngine({ /* replicaId intentionally omitted */ });
    } catch (err) {
      if (err instanceof EngineError && err.kind === 'config_invalid') {
        threwConfigInvalid = true;
      }
    }

    expect(threwConfigInvalid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DS1-10. Phase 1 backward-compat — put/get with replicaIds: [] still works (H23)
// ---------------------------------------------------------------------------

describe('DS1-10: Phase 1 backward-compat — replicaIds: [] round-trips correctly (H23)', () => {
  it('existing Phase 1 record shape with replicaIds: [] is accepted without change', async () => {
    const store = await createIsolatedTestStore();

    const record = makeRecord({ id: '7'.repeat(64), replicaIds: [] });
    await store.put(record);
    const retrieved = await store.get(record.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.replicaIds).toEqual([]);

    // Confirm the new optional methods do not break existing required interface methods
    expect(typeof store.put).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.findByProjectAndRun).toBe('function');
    expect(typeof store.updateStatus).toBe('function');
    expect(typeof store.listPending).toBe('function');
    expect(typeof store.gc).toBe('function');
  });
});
