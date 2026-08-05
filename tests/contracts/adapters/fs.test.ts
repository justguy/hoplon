/**
 * tests/contracts/adapters/fs.test.ts
 *
 * Shared contract test suite for HoplonFsAdapter.
 * Run against BOTH createNodeFsAdapter (disk I/O) and createMemFsAdapter (in-memory)
 * via describe.each to prove behavioral equivalence.
 *
 * Node adapter: uses a fresh tmpdir fixture per test (beforeEach / afterEach).
 * MemFs adapter: each describe.each row gets a fresh Volume (createMemFsAdapter() starts empty).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNodeFsAdapter } from '../../../src/hoplon/adapters/fs/node.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../../src/hoplon/adapters/fs.js';
import { AdapterError, ValidationError } from '../../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Adapter factory helpers — return { adapter, cleanup } for each describe.each row
// ---------------------------------------------------------------------------

/** Node adapter factory: creates a fresh tmpdir each time (cleaned up in afterEach). */
async function makeNodeAdapter(): Promise<{ adapter: HoplonFsAdapter; cleanup: () => Promise<void> }> {
  const tmpRoot = await fsNative.mkdtemp(path.join(os.tmpdir(), 'hoplon-fs-test-'));
  return {
    adapter: createNodeFsAdapter({ root: tmpRoot }),
    cleanup: async () => {
      await fsNative.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** MemFs adapter factory: fresh Volume per call (no cleanup needed — in-memory). */
async function makeMemfsAdapter(): Promise<{ adapter: HoplonFsAdapter; cleanup: () => Promise<void> }> {
  return {
    adapter: createMemFsAdapter(),
    cleanup: async () => { /* nothing to clean up */ },
  };
}

// ---------------------------------------------------------------------------
// Parameterized test suite
// ---------------------------------------------------------------------------

const adapters: Array<[name: string, factory: () => Promise<{ adapter: HoplonFsAdapter; cleanup: () => Promise<void> }>]> = [
  ['NodeFsAdapter', makeNodeAdapter],
  ['MemFsAdapter', makeMemfsAdapter],
];

describe.each(adapters)('%s', (_adapterName, factory) => {
  let adapter: HoplonFsAdapter;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await factory();
    adapter = result.adapter;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Test 1: write then read round-trips Uint8Array bytes exactly
  // -------------------------------------------------------------------------
  it('write then read round-trips Uint8Array bytes exactly', async () => {
    const content = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe]);
    await adapter.write('roundtrip.bin', content);
    const result = await adapter.read('roundtrip.bin');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual(Array.from(content));
  });

  // -------------------------------------------------------------------------
  // Test 2: read on missing path → AdapterError({ kind: 'fs_read_failed' })
  // -------------------------------------------------------------------------
  it('read on missing path throws AdapterError fs_read_failed', async () => {
    await expect(adapter.read('does-not-exist.txt')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdapterError && err.kind === 'fs_read_failed',
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: list returns sorted names
  // -------------------------------------------------------------------------
  it('list returns alphabetically sorted names', async () => {
    await adapter.write('gamma.txt', new Uint8Array([1]));
    await adapter.write('alpha.txt', new Uint8Array([2]));
    await adapter.write('beta.txt', new Uint8Array([3]));
    const entries = await adapter.list('.');
    // Names (not paths) in sorted order
    expect(entries).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt']);
  });

  // -------------------------------------------------------------------------
  // Test 4: list on missing directory → AdapterError({ kind: 'fs_read_failed' })
  // -------------------------------------------------------------------------
  it('list on missing directory throws AdapterError fs_read_failed', async () => {
    await expect(adapter.list('no-such-directory')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdapterError && err.kind === 'fs_read_failed',
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: stat on existing file → { exists: true, isFile: true, size: N }
  // -------------------------------------------------------------------------
  it('stat on existing file returns exists=true isFile=true size=N', async () => {
    const content = new Uint8Array([10, 20, 30, 40, 50]);
    await adapter.write('stattest.bin', content);
    const s = await adapter.stat('stattest.bin');
    expect(s.exists).toBe(true);
    expect(s.isFile).toBe(true);
    expect(s.size).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 6: stat on missing path → { exists: false, isFile: false, size: 0 }
  // -------------------------------------------------------------------------
  it('stat on missing path returns exists=false without throwing', async () => {
    const s = await adapter.stat('nonexistent-file.txt');
    expect(s).toEqual({ exists: false, isFile: false, size: 0 });
  });

  // -------------------------------------------------------------------------
  // Test 7: stat on directory → { exists: true, isFile: false, ... }
  // -------------------------------------------------------------------------
  it('stat on directory returns exists=true isFile=false', async () => {
    await adapter.mkdir('mydir');
    const s = await adapter.stat('mydir');
    expect(s.exists).toBe(true);
    expect(s.isFile).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 8: mkdir non-recursive fails on missing parent with AdapterError
  // -------------------------------------------------------------------------
  it('mkdir non-recursive fails when parent is missing', async () => {
    await expect(adapter.mkdir('parent/child')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdapterError && err.kind === 'fs_write_failed',
    );
  });

  // -------------------------------------------------------------------------
  // Test 9: mkdir with recursive: true creates nested structure
  // -------------------------------------------------------------------------
  it('mkdir with recursive creates nested structure', async () => {
    await adapter.mkdir('a/b/c', { recursive: true });
    const s = await adapter.stat('a/b/c');
    expect(s.exists).toBe(true);
    expect(s.isFile).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 10: remove on existing file succeeds; on missing path is a no-op
  // -------------------------------------------------------------------------
  it('remove on existing file succeeds and remove on missing path is a no-op', async () => {
    await adapter.write('to-remove.txt', new Uint8Array([1]));
    // Exists before remove
    const before = await adapter.stat('to-remove.txt');
    expect(before.exists).toBe(true);

    // Remove succeeds
    await expect(adapter.remove('to-remove.txt')).resolves.toBeUndefined();

    // Gone after remove
    const after = await adapter.stat('to-remove.txt');
    expect(after.exists).toBe(false);

    // Remove of nonexistent is a no-op (no throw)
    await expect(adapter.remove('no-such-file.txt')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 12: write creates parent directories automatically
  // -------------------------------------------------------------------------
  it('write creates parent directories automatically', async () => {
    const content = new Uint8Array([7, 8, 9]);
    // deep/nested/ does not exist yet
    await adapter.write('deep/nested/file.txt', content);
    const result = await adapter.read('deep/nested/file.txt');
    expect(Array.from(result)).toEqual([7, 8, 9]);
  });

  // -------------------------------------------------------------------------
  // Test 13 (cross-adapter equivalence): same write+read sequence produces
  // byte-identical output on both adapters
  // -------------------------------------------------------------------------
  it('cross-adapter: same write+read sequence produces identical bytes', async () => {
    // Create a dedicated node adapter and memfs adapter for the cross-adapter comparison.
    // Track the tmpdir explicitly so cleanup is deterministic.
    const equivTmp = await fsNative.mkdtemp(path.join(os.tmpdir(), 'hoplon-equiv-'));
    const node = createNodeFsAdapter({ root: equivTmp });
    const mem = createMemFsAdapter();

    try {
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await adapter.write('equiv/file.bin', bytes);
      await node.write('equiv/file.bin', bytes);
      await mem.write('equiv/file.bin', bytes);

      const fromAdapter = await adapter.read('equiv/file.bin');
      const fromNode = await node.read('equiv/file.bin');
      const fromMem = await mem.read('equiv/file.bin');

      expect(Array.from(fromNode)).toEqual(Array.from(bytes));
      expect(Array.from(fromMem)).toEqual(Array.from(bytes));
      expect(Array.from(fromAdapter)).toEqual(Array.from(bytes));
    } finally {
      await fsNative.rm(equivTmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 11: Path traversal defense (Node adapter only)
// ---------------------------------------------------------------------------
describe('NodeFsAdapter — path traversal defense', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsNative.mkdtemp(path.join(os.tmpdir(), 'hoplon-traversal-'));
  });

  afterEach(async () => {
    await fsNative.rm(tmpRoot, { recursive: true, force: true });
  });

  it('read("../secret") throws AdapterError with ValidationError cause', async () => {
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    let thrown: unknown;
    try {
      await adapter.read('../secret');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    const adapterErr = thrown as AdapterError;
    expect(adapterErr.kind).toBe('fs_read_failed');
    expect(adapterErr.cause).toBeInstanceOf(ValidationError);
    expect((adapterErr.cause as ValidationError).kind).toBe('path_traversal');
  });

  it('write("../../etc/passwd", ...) throws AdapterError with ValidationError cause', async () => {
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    let thrown: unknown;
    try {
      await adapter.write('../../etc/passwd', new Uint8Array([1]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    const adapterErr = thrown as AdapterError;
    expect(adapterErr.kind).toBe('fs_write_failed');
    expect(adapterErr.cause).toBeInstanceOf(ValidationError);
    expect((adapterErr.cause as ValidationError).kind).toBe('path_traversal');
  });

  it('list("../sibling") throws AdapterError with ValidationError cause', async () => {
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    let thrown: unknown;
    try {
      await adapter.list('../sibling');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    const adapterErr = thrown as AdapterError;
    expect(adapterErr.kind).toBe('fs_read_failed');
    expect(adapterErr.cause).toBeInstanceOf(ValidationError);
    expect((adapterErr.cause as ValidationError).kind).toBe('path_traversal');
  });
});
