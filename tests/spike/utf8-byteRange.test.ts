/**
 * tests/spike/utf8-byteRange.test.ts — SPIKE-UTF8
 *
 * Verifies that byteRange values in AuditViolation.out_of_scope_symbol use
 * UTF-8 Buffer byte offsets (as returned by Buffer.byteLength) and NOT
 * JavaScript string character positions (as returned by str.indexOf / str.length).
 *
 * For ASCII-only content the two are identical. For multi-byte UTF-8 content
 * (Japanese, emoji, accented Latin) they diverge. This spike detects that
 * divergence and documents whether the shipped code is correct.
 *
 * Fixture strategy:
 *   - Line 1: a Unicode comment (Japanese characters) that precedes all functions
 *   - Line 2: export function foo() — in contracted scope (no violation expected)
 *   - Line 3: export function bar() — out of scope (violation expected)
 *   - Line 4: export function baz() — out of scope (violation expected)
 *
 * Because the Unicode comment on line 1 contains multi-byte UTF-8 sequences,
 * the byte offset of "bar" and "baz" in the Buffer differs from their char
 * position in the JS string.
 *
 * Test plan:
 *   T1 — Assert violation count is 2 (bar, baz)
 *   T2 — Assert byteRange[0] for bar equals Buffer byte offset, NOT char position
 *   T3 — Assert byteRange[0] for baz equals Buffer byte offset, NOT char position
 *   T4 — Slice round-trip: Buffer.slice(byteRange[0], byteRange[1]).toString('utf8') contains 'bar'
 *   T5 — Slice round-trip for baz: Buffer.slice(byteRange[0], byteRange[1]).toString('utf8') contains 'baz'
 *   T6 — Assert char position and byte position ACTUALLY diverge (validates the fixture has effect)
 */

import { describe, it, expect, beforeAll } from 'vitest';
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
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditRequest } from '../../src/hoplon/contracts/requests.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { hashManifest } from '../../src/hoplon/util/hashManifest.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

// ---------------------------------------------------------------------------
// Fixture — multi-byte UTF-8 characters preceding the functions under test.
//
// Line 1: Japanese comment — each CJK char is 3 UTF-8 bytes, space is 1.
//   "// こんにちは コメント" (greeting + "comment" in Japanese)
//   Char count: 14 chars (including "// " prefix + newline = 15 chars total with \n)
//   Byte count: "// " = 3 bytes + "こんにちは" = 15 bytes + " " = 1 byte +
//               "コメント" = 12 bytes = 31 bytes + "\n" = 32 bytes
//
// The divergence between char position and byte position of 'bar' (line 3):
//   char position = indexOf('export function bar')
//   byte position = Buffer.byteLength(source.slice(0, indexOf('export function bar')), 'utf8')
//   These differ by exactly: (byte_count_of_line1 - char_count_of_line1)
// ---------------------------------------------------------------------------

const FIXTURE_LINE1 = '// こんにちは コメント';
const FIXTURE_LINE2 = "export function foo() { return 1; }";
const FIXTURE_LINE3 = "export function bar() { return 2; }";
const FIXTURE_LINE4 = "export function baz() { return '🎉 party'; }";

const FIXTURE_SOURCE = [
  FIXTURE_LINE1,
  FIXTURE_LINE2,
  FIXTURE_LINE3,
  FIXTURE_LINE4,
].join('\n');

const FIXTURE_PATH = 'src/utf8-spike.js';

const FIXTURE_MANIFEST: WritableManifest = {
  manifestSchemaVersion: 1,
  projectId: 'spike-utf8-project',
  runId: 'spike-run-001',
  correlationId: 'spike-corr-seed',
  entries: [
    {
      path: FIXTURE_PATH,
      scope: { kind: 'symbols', symbols: ['foo'] },
    },
  ],
};

// ---------------------------------------------------------------------------
// Shared adapter state
// ---------------------------------------------------------------------------

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function makeSpikeDeps(): Promise<{
  deps: AuditDiffDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();

  const deps: AuditDiffDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'spike-engine',
    config: {
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 10_000,
      manifestSchemaVersion: 1,
    },
  };
  return { deps, fs, store };
}

/** Seed the snapshot store with the fixture manifest and return the snapshotRefId. */
async function seedFixtureSnapshot(store: SnapshotStore): Promise<string> {
  const id = hashManifest(FIXTURE_MANIFEST);
  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: 1,
    engineId: 'spike-engine',
    projectId: FIXTURE_MANIFEST.projectId,
    runId: FIXTURE_MANIFEST.runId,
    correlationId: FIXTURE_MANIFEST.correlationId,
    status: 'committed',
    statusReason: null,
    // null → empty-baseline fallback; a fake ref would fail closed (hcr-009).
    gitRef: null,
    manifest: FIXTURE_MANIFEST,
    createdAt: new Date().toISOString(),
    ttlExpires: null,
    replicaIds: [],
  };
  await store.put(record);
  return id;
}

function makeAuditRequest(snapshotRefId: string): AuditRequest {
  return {
    snapshotRefId,
    projectId: FIXTURE_MANIFEST.projectId,
    runId: FIXTURE_MANIFEST.runId,
    correlationId: 'spike-corr-audit',
    files: [FIXTURE_PATH],
  };
}

// ---------------------------------------------------------------------------
// Pre-computation of expected byte positions
// ---------------------------------------------------------------------------

/**
 * Compute the CORRECT byte offset of a substring in a string.
 * This is what byteRange should report if the shipped code is correct.
 */
function expectedByteOffset(source: string, searchStr: string): number {
  const charPos = source.indexOf(searchStr);
  if (charPos === -1) throw new Error(`'${searchStr}' not found in fixture source`);
  return Buffer.byteLength(source.slice(0, charPos), 'utf8');
}

/**
 * The raw JS string character position (what byteRange would report if the
 * shipped code incorrectly uses string indices instead of byte offsets).
 */
function charPosition(source: string, searchStr: string): number {
  const pos = source.indexOf(searchStr);
  if (pos === -1) throw new Error(`'${searchStr}' not found in fixture source`);
  return pos;
}

// ---------------------------------------------------------------------------
// T0 — Fixture self-check: confirm multi-byte divergence actually exists
// ---------------------------------------------------------------------------

describe('SPIKE-UTF8 — T0: fixture self-check (divergence exists)', () => {
  it('char position and byte position of "export function bar" MUST differ', () => {
    const charPos = charPosition(FIXTURE_SOURCE, 'export function bar');
    const bytePos = expectedByteOffset(FIXTURE_SOURCE, 'export function bar');

    // Sanity: both positions must be > 0
    expect(charPos).toBeGreaterThan(0);
    expect(bytePos).toBeGreaterThan(0);

    // The critical invariant: the fixture MUST produce divergence.
    // If this test fails, the fixture itself is wrong (ASCII-only line 1).
    expect(bytePos).toBeGreaterThan(charPos);

    // Document the divergence magnitude for the report
    const divergence = bytePos - charPos;
    expect(divergence).toBeGreaterThan(0);

    // Also verify for baz
    const charPosBaz = charPosition(FIXTURE_SOURCE, 'export function baz');
    const bytePossBaz = expectedByteOffset(FIXTURE_SOURCE, 'export function baz');
    expect(bytePossBaz).toBeGreaterThan(charPosBaz);
  });
});

// ---------------------------------------------------------------------------
// T1-T5 — Main spike assertions
// ---------------------------------------------------------------------------

describe('SPIKE-UTF8 — byteRange in AuditViolation uses UTF-8 byte offsets', () => {
  it('T1: auditDiff produces BLOCK with exactly 2 violations (bar, baz)', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));

    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const oos = result.violations.filter((v) => v.kind === 'out_of_scope_symbol');
    expect(oos).toHaveLength(2);

    const names = oos
      .filter((v) => v.kind === 'out_of_scope_symbol')
      .map((v) => (v as { symbolName: string }).symbolName)
      .sort();
    expect(names).toEqual(['bar', 'baz']);
  });

  it('T2: byteRange[0] for bar equals UTF-8 byte offset, NOT char position', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));
    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const barViolation = result.violations.find(
      (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName: string }).symbolName === 'bar'
    ) as { kind: 'out_of_scope_symbol'; byteRange: [number, number] } | undefined;

    expect(barViolation).toBeDefined();
    if (!barViolation) return;

    const charPos = charPosition(FIXTURE_SOURCE, 'export function bar');
    const bytePos = expectedByteOffset(FIXTURE_SOURCE, 'export function bar');

    // The divergence must exist for this assertion to be meaningful
    expect(bytePos).toBeGreaterThan(charPos);

    // CRITICAL: byteRange[0] must equal the Buffer byte offset
    // If it equals charPos instead, the shipped code uses string indices (BUG)
    expect(barViolation.byteRange[0]).toBe(bytePos);
    expect(barViolation.byteRange[0]).not.toBe(charPos);
  });

  it('T3: byteRange[0] for baz equals UTF-8 byte offset, NOT char position', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));
    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const bazViolation = result.violations.find(
      (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName: string }).symbolName === 'baz'
    ) as { kind: 'out_of_scope_symbol'; byteRange: [number, number] } | undefined;

    expect(bazViolation).toBeDefined();
    if (!bazViolation) return;

    const charPos = charPosition(FIXTURE_SOURCE, 'export function baz');
    const bytePos = expectedByteOffset(FIXTURE_SOURCE, 'export function baz');

    expect(bytePos).toBeGreaterThan(charPos);

    expect(bazViolation.byteRange[0]).toBe(bytePos);
    expect(bazViolation.byteRange[0]).not.toBe(charPos);
  });

  it('T4: Buffer.slice(byteRange) for bar round-trips to valid UTF-8 containing "bar"', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));
    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const barViolation = result.violations.find(
      (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName: string }).symbolName === 'bar'
    ) as { kind: 'out_of_scope_symbol'; byteRange: [number, number] } | undefined;

    expect(barViolation).toBeDefined();
    if (!barViolation) return;

    const [start, end] = barViolation.byteRange;
    const fileBuffer = Buffer.from(FIXTURE_SOURCE, 'utf8');

    // Slice using the reported byteRange — must produce valid UTF-8 containing 'bar'
    const sliced = fileBuffer.subarray(start, end).toString('utf8');

    expect(sliced).toContain('bar');
    // Must not contain replacement character (U+FFFD) — proof of valid UTF-8 boundary alignment
    expect(sliced).not.toContain('\uFFFD');
  });

  it('T5: Buffer.slice(byteRange) for baz round-trips to valid UTF-8 containing "baz"', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));
    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const bazViolation = result.violations.find(
      (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName: string }).symbolName === 'baz'
    ) as { kind: 'out_of_scope_symbol'; byteRange: [number, number] } | undefined;

    expect(bazViolation).toBeDefined();
    if (!bazViolation) return;

    const [start, end] = bazViolation.byteRange;
    const fileBuffer = Buffer.from(FIXTURE_SOURCE, 'utf8');

    const sliced = fileBuffer.subarray(start, end).toString('utf8');

    expect(sliced).toContain('baz');
    expect(sliced).not.toContain('\uFFFD');
  });

  it('T6: byteRange[1] >= byteRange[0] + byteLength of "export function bar"', async () => {
    const { deps, fs, store } = await makeSpikeDeps();
    const snapshotRefId = await seedFixtureSnapshot(store);
    await fs.write(FIXTURE_PATH, enc(FIXTURE_SOURCE));

    const result = await auditDiff(deps, makeAuditRequest(snapshotRefId));
    expect(result.status).toBe('BLOCK');
    if (result.status !== 'BLOCK') return;

    const barViolation = result.violations.find(
      (v) => v.kind === 'out_of_scope_symbol' && (v as { symbolName: string }).symbolName === 'bar'
    ) as { kind: 'out_of_scope_symbol'; byteRange: [number, number] } | undefined;

    expect(barViolation).toBeDefined();
    if (!barViolation) return;

    const [start, end] = barViolation.byteRange;
    const expectedBodyByteLength = Buffer.byteLength(FIXTURE_LINE3, 'utf8');

    expect(end).toBeGreaterThanOrEqual(start + expectedBodyByteLength);
  });
});
