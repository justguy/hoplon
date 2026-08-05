/**
 * HA1 — Hash agility integration tests.
 *
 * Proof requirements (verbatim from task list):
 * - New snapshot `id` has `sha256:` prefix
 * - Lookup with prefixed and bare both find snapshot
 * - Migration helper round-trips
 *
 * Uses createIsolatedTestStore() — fully in-memory, no filesystem I/O.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import { hashManifest, addHashPrefix, stripHashPrefix, HASH_ALGORITHM } from '../../src/hoplon/util/hashManifest.js';
import { WritableManifestSchema } from '../../src/hoplon/contracts/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANIFEST = WritableManifestSchema.parse({
  manifestSchemaVersion: 1,
  projectId: 'ha1-test-project',
  runId: 'run-ha1-001',
  correlationId: 'corr-ha1-001',
  entries: [{ path: 'src/index.ts', scope: { kind: 'whole_file' } }],
});

function makeRecord(id: string) {
  return {
    id,
    manifestSchemaVersion: 1,
    engineId: 'engine-ha1-test',
    projectId: 'ha1-test-project',
    runId: 'run-ha1-001',
    correlationId: 'corr-ha1-001',
    status: 'committed' as const,
    statusReason: null,
    gitRef: 'abc'.repeat(13).slice(0, 40), // dummy 40-char git ref
    manifest: MANIFEST,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };
}

// ---------------------------------------------------------------------------
// HA1-1: New snapshot IDs have sha256: prefix
// ---------------------------------------------------------------------------

describe('HA1-1: hashManifest produces prefixed IDs', () => {
  it('new ID starts with sha256: prefix', () => {
    const id = hashManifest(MANIFEST);
    expect(id.startsWith(`${HASH_ALGORITHM}:`)).toBe(true);
  });

  it('new ID matches pattern sha256:<64-char-hex>', () => {
    const id = hashManifest(MANIFEST);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('new ID is deterministic across calls', () => {
    const id1 = hashManifest(MANIFEST);
    const id2 = hashManifest(MANIFEST);
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// HA1-2: Store lookup accepts both prefixed and bare IDs
// ---------------------------------------------------------------------------

describe('HA1-2: SnapshotStore.get accepts both prefixed and bare IDs', () => {
  let store: SnapshotStore;

  beforeEach(async () => {
    store = await createIsolatedTestStore();
  });

  it('lookup by prefixed ID finds a record stored with the prefixed ID', async () => {
    const prefixedId = hashManifest(MANIFEST);
    await store.put(makeRecord(prefixedId));

    const found = await store.get(prefixedId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(prefixedId);
  });

  it('lookup by bare ID finds a record stored with the bare ID (legacy backward compat)', async () => {
    const prefixedId = hashManifest(MANIFEST);
    const bareId = stripHashPrefix(prefixedId);
    // Simulate a legacy record stored with a bare 64-hex ID
    await store.put(makeRecord(bareId));

    const found = await store.get(bareId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(bareId);
  });

  it('lookup by prefixed ID finds a record stored with the bare ID (cross-format compat)', async () => {
    const prefixedId = hashManifest(MANIFEST);
    const bareId = stripHashPrefix(prefixedId);
    // Simulate a legacy record stored with a bare 64-hex ID
    await store.put(makeRecord(bareId));

    // Caller passes the prefixed form — should still find the bare record
    const found = await store.get(prefixedId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(bareId);
  });

  it('lookup by bare ID finds a record stored with the prefixed ID (cross-format compat)', async () => {
    const prefixedId = hashManifest(MANIFEST);
    const bareId = stripHashPrefix(prefixedId);
    // Store with the new prefixed ID
    await store.put(makeRecord(prefixedId));

    // Caller passes the bare form — should still find the prefixed record
    const found = await store.get(bareId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(prefixedId);
  });

  it('returns null for an ID that does not exist in either form', async () => {
    const prefixedId = hashManifest(MANIFEST);
    // Store nothing
    const found = await store.get(prefixedId);
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HA1-3: Migration helper addHashPrefix round-trips
// ---------------------------------------------------------------------------

describe('HA1-3: addHashPrefix migration helper', () => {
  it('converts bare hex ID to sha256: prefixed form', () => {
    const prefixedId = hashManifest(MANIFEST);
    const bareId = stripHashPrefix(prefixedId);
    expect(addHashPrefix(bareId)).toBe(prefixedId);
  });

  it('is idempotent on already-prefixed IDs', () => {
    const prefixedId = hashManifest(MANIFEST);
    expect(addHashPrefix(prefixedId)).toBe(prefixedId);
  });

  it('round-trips: addHashPrefix(stripHashPrefix(id)) === id', () => {
    const id = hashManifest(MANIFEST);
    expect(addHashPrefix(stripHashPrefix(id))).toBe(id);
  });

  it('round-trips: stripHashPrefix(addHashPrefix(bare)) === bare', () => {
    const id = hashManifest(MANIFEST);
    const bare = stripHashPrefix(id);
    expect(stripHashPrefix(addHashPrefix(bare))).toBe(bare);
  });

  it('throws TypeError for completely invalid input', () => {
    expect(() => addHashPrefix('invalid')).toThrow(TypeError);
    expect(() => addHashPrefix('')).toThrow(TypeError);
    // 63-char hex (one char too short) — not valid
    expect(() => addHashPrefix('a'.repeat(63))).toThrow(TypeError);
  });
});
