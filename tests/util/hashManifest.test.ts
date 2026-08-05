/**
 * Tests for hashManifest.
 *
 * Key invariants:
 * - Same manifest → same ID (determinism)
 * - Reordered keys → same ID (stableStringify normalization)
 * - Different content → different ID (collision resistance)
 * - Phase 2 HA1: ID format is `sha256:<64-char-hex>` (73 chars total)
 *
 * A3.1 update: WritableManifest now requires manifestSchemaVersion: 1, runId, correlationId.
 * HA1 update: hashManifest now returns prefixed IDs; addHashPrefix + stripHashPrefix helpers added.
 */

import { describe, it, expect } from 'vitest';
import {
  hashManifest,
  addHashPrefix,
  stripHashPrefix,
  HASH_ALGORITHM,
} from '../../src/hoplon/util/hashManifest.js';
import { WritableManifestSchema } from '../../src/hoplon/contracts/manifest.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures — validated through the real Zod schema
// ---------------------------------------------------------------------------

function parseManifest(raw: unknown): WritableManifest {
  return WritableManifestSchema.parse(raw);
}

const MANIFEST_A = parseManifest({
  manifestSchemaVersion: 1,
  projectId: 'widget-app',
  runId: 'run-001',
  correlationId: 'corr-001',
  entries: [
    { path: 'src/util/format.ts', scope: { kind: 'symbols', symbols: ['formatPrice'] } },
    { path: 'src/types.ts', scope: { kind: 'whole_file' } },
  ],
});

// Same content as MANIFEST_A but entries in different order
const MANIFEST_A_REORDERED = parseManifest({
  manifestSchemaVersion: 1,
  projectId: 'widget-app',
  runId: 'run-001',
  correlationId: 'corr-001',
  entries: [
    { path: 'src/types.ts', scope: { kind: 'whole_file' } },
    { path: 'src/util/format.ts', scope: { kind: 'symbols', symbols: ['formatPrice'] } },
  ],
});

// NOTE: entries are arrays, and stableStringify preserves array order.
// MANIFEST_A and MANIFEST_A_REORDERED have different array orders → different hashes.
// This is CORRECT behavior — the manifest IS different (entry order matters for git add).

const MANIFEST_B = parseManifest({
  manifestSchemaVersion: 1,
  projectId: 'widget-app',
  runId: 'run-001',
  correlationId: 'corr-001',
  entries: [
    { path: 'src/util/format.ts', scope: { kind: 'symbols', symbols: ['formatCurrency'] } },
  ],
});

// Manifest with keys in different insertion order (object-level reordering)
const MANIFEST_A_KEY_REORDERED = parseManifest({
  entries: [
    { path: 'src/util/format.ts', scope: { kind: 'symbols', symbols: ['formatPrice'] } },
    { path: 'src/types.ts', scope: { kind: 'whole_file' } },
  ],
  correlationId: 'corr-001',
  runId: 'run-001',
  projectId: 'widget-app',
  manifestSchemaVersion: 1,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hashManifest', () => {
  it('same manifest → same ID (determinism)', () => {
    const id1 = hashManifest(MANIFEST_A);
    const id2 = hashManifest(MANIFEST_A);
    expect(id1).toBe(id2);
  });

  it('reordered object keys → same ID (key normalization)', () => {
    // MANIFEST_A and MANIFEST_A_KEY_REORDERED have same content
    // but the top-level object keys were inserted in different order.
    // stableStringify normalizes this → same ID.
    const idA = hashManifest(MANIFEST_A);
    const idKeyReordered = hashManifest(MANIFEST_A_KEY_REORDERED);
    expect(idA).toBe(idKeyReordered);
  });

  it('different content → different ID', () => {
    const idA = hashManifest(MANIFEST_A);
    const idB = hashManifest(MANIFEST_B);
    expect(idA).not.toBe(idB);
  });

  it('different entry array order → different ID (arrays are ordered)', () => {
    // Arrays are not sorted by stableStringify — element order matters.
    const idA = hashManifest(MANIFEST_A);
    const idReordered = hashManifest(MANIFEST_A_REORDERED);
    expect(idA).not.toBe(idReordered);
  });

  it('HA1: ID has sha256: prefix (new format)', () => {
    const id = hashManifest(MANIFEST_A);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id).toHaveLength(7 + 64); // 'sha256:' (7) + 64-char hex = 71
  });

  it('HA1: HASH_ALGORITHM constant is sha256', () => {
    expect(HASH_ALGORITHM).toBe('sha256');
  });

  it('ID is not an empty string', () => {
    const id = hashManifest(MANIFEST_A);
    expect(id.length).toBeGreaterThan(0);
  });

  it('A3.1 schema and B1 hash are compatible — parse validates, hash computes (HA1 format)', () => {
    // Prove: the A3.1 Zod schema and B1 hashManifest work end-to-end.
    const manifest = WritableManifestSchema.parse({
      manifestSchemaVersion: 1,
      projectId: 'compatibility-test',
      runId: 'run-compat-001',
      correlationId: 'corr-compat-001',
      entries: [{ path: 'src/index.ts', scope: { kind: 'whole_file' } }],
    });
    const id = hashManifest(manifest);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('different runId → different ID', () => {
    const m1 = parseManifest({
      manifestSchemaVersion: 1,
      projectId: 'test',
      runId: 'run-aaa',
      correlationId: 'corr-001',
      entries: [{ path: 'src/x.ts', scope: { kind: 'whole_file' } }],
    });
    const m2 = parseManifest({
      manifestSchemaVersion: 1,
      projectId: 'test',
      runId: 'run-bbb',
      correlationId: 'corr-001',
      entries: [{ path: 'src/x.ts', scope: { kind: 'whole_file' } }],
    });
    expect(hashManifest(m1)).not.toBe(hashManifest(m2));
  });
});

// ---------------------------------------------------------------------------
// HA1 helpers — addHashPrefix + stripHashPrefix
// ---------------------------------------------------------------------------

describe('addHashPrefix', () => {
  it('adds sha256: prefix to a bare 64-char hex ID', () => {
    const bare = 'a'.repeat(64);
    expect(addHashPrefix(bare)).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('is idempotent — does not double-prefix an already-prefixed ID', () => {
    const prefixed = `sha256:${'b'.repeat(64)}`;
    expect(addHashPrefix(prefixed)).toBe(prefixed);
  });

  it('round-trips: addHashPrefix(stripHashPrefix(id)) === id for prefixed IDs', () => {
    const id = hashManifest(MANIFEST_A);
    expect(addHashPrefix(stripHashPrefix(id))).toBe(id);
  });

  it('throws TypeError for an invalid input (not 64-char hex and not prefixed)', () => {
    expect(() => addHashPrefix('tooshort')).toThrow(TypeError);
    expect(() => addHashPrefix('g'.repeat(64))).toThrow(TypeError); // not hex
    expect(() => addHashPrefix('')).toThrow(TypeError);
  });
});

describe('stripHashPrefix', () => {
  it('strips sha256: prefix from a prefixed ID', () => {
    const prefixed = `sha256:${'c'.repeat(64)}`;
    expect(stripHashPrefix(prefixed)).toBe('c'.repeat(64));
  });

  it('passes through a bare-hex ID unchanged', () => {
    const bare = 'd'.repeat(64);
    expect(stripHashPrefix(bare)).toBe(bare);
  });

  it('round-trips: stripHashPrefix(addHashPrefix(bare)) === bare', () => {
    const bare = 'e'.repeat(64);
    expect(stripHashPrefix(addHashPrefix(bare))).toBe(bare);
  });
});
