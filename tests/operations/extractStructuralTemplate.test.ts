/**
 * tests/operations/extractStructuralTemplate.test.ts — LC4 targeted test suite.
 *
 * Proof requirements:
 *  EST-1  Multiple exports → template lists each with name + kind + signature
 *  EST-2  Import declarations correctly extracted into imports[]
 *  EST-3  TypeScript type/interface declarations appear in types[]
 *  EST-4  H7 determinism: identical inputs → byte-identical StructuralTemplate
 *  EST-5  Sorted file order (alphabetical) — H7
 *  EST-6  snapshotRef field is null when no snapshotRefId provided
 *  EST-7  customQueries parameter replaces built-in bundle
 *  EST-8  queryId defaults to 'structural-template'; custom queryId respected
 *  EST-9  H13: emitted events contain no source content (structure only)
 *  EST-10 Missing file → silently omitted, other files still processed
 *  EST-11 Invalid request (empty files array) → ValidationError thrown
 *  EST-12 Snapshot mode: reads content via versioning.readBlob (not live FS)
 *
 * Uses:
 *   - createMemFsAdapter()             — in-memory fs (C2)
 *   - createTreeSitterIntelligence()   — real WASM grammars (D3)
 *   - createMemoryEmitter()            — in-memory event store (C5)
 *   - createIsomorphicGitVersioning()  — real in-memory git (C4) for snapshot tests
 *   - createIsolatedTestStore()        — in-memory SQLite (C1) for snapshot tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { extractStructuralTemplate, DEFAULT_TEMPLATE_QUERY_ID } from '../../src/hoplon/operations/extractStructuralTemplate.js';
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
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { ExtractStructuralTemplateRequest } from '../../src/hoplon/contracts/structuralTemplate.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { EXTRACT_FUNCTION_SIGNATURES_TS } from '../../src/hoplon/operations/stdQueries.js';

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
// Test harness helpers
// ---------------------------------------------------------------------------

const GIT_REPO_DIR = '/.hoplon/repo';
const FS_ROOT = '/';

function makeDeps(
  ci: CodeIntelligenceAdapter = sharedCI,
  overrides?: {
    versioning?: VersioningAdapter;
    snapshotStore?: SnapshotStore;
  },
): {
  deps: ExtractStructuralTemplateDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const fs = createMemFsAdapter();
  const versioning = overrides?.versioning ?? createIsomorphicGitVersioning({ fs });
  const snapshotStore = overrides?.snapshotStore ?? {
    get: async () => null,
    put: async () => {},
    update: async () => {},
    listByProject: async () => [],
    gc: async () => ({ deletedCount: 0 }),
    appendAuditLog: async () => {},
    close: () => {},
  } as unknown as SnapshotStore;
  const emitter = createMemoryEmitter();

  const deps: ExtractStructuralTemplateDeps = {
    fs,
    versioning,
    snapshotStore,
    codeIntelligence: ci,
    emitter,
    engineId: 'test-est-engine',
    root: FS_ROOT,
    config: {
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 5000,
      gitRepoDir: GIT_REPO_DIR,
    },
  };
  return { deps, fs, emitter };
}

function makeReq(
  overrides: Partial<ExtractStructuralTemplateRequest> = {},
): ExtractStructuralTemplateRequest {
  return {
    projectId: 'proj-est-test',
    runId: 'run-est-001',
    correlationId: 'corr-est-001',
    files: ['src/a.ts'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EST-1: Multiple exports → template lists each with name, kind, signature
// ---------------------------------------------------------------------------

describe('EST-1: multiple exports appear in template', () => {
  it('lists each export with name, kind, and signature text', async () => {
    const { deps, fs } = makeDeps();
    const src = [
      'export function add(a: number, b: number): number { return a + b; }',
      'export class Calculator { }',
      'export const PI = 3.14;',
    ].join('\n');
    await fs.write('src/a.ts', enc(src));

    const result = await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/a.ts');
    expect(file.exports.length).toBeGreaterThanOrEqual(3);

    const names = file.exports.map((e) => e.name);
    expect(names).toContain('add');
    expect(names).toContain('Calculator');
    expect(names).toContain('PI');

    // Each export has a non-empty signature
    file.exports.forEach((e) => {
      expect(e.signature.length).toBeGreaterThan(0);
    });

    // Kind discrimination
    const addEntry = file.exports.find((e) => e.name === 'add')!;
    expect(addEntry).toBeDefined();
    expect(addEntry.kind).toBe('function');

    const calcEntry = file.exports.find((e) => e.name === 'Calculator')!;
    expect(calcEntry).toBeDefined();
    expect(calcEntry.kind).toBe('class');
  });
});

// ---------------------------------------------------------------------------
// EST-2: Import declarations correctly extracted
// ---------------------------------------------------------------------------

describe('EST-2: imports correctly extracted', () => {
  it('extracts import source strings for each import statement', async () => {
    const { deps, fs } = makeDeps();
    const src = [
      `import { resolve } from 'node:path';`,
      `import type { Foo } from './foo.js';`,
      `import './side-effect.js';`,
    ].join('\n');
    await fs.write('src/a.ts', enc(src));

    const result = await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    const file = result.files[0]!;
    const sources = file.imports.map((i) => i.source);
    expect(sources).toContain('node:path');
    expect(sources).toContain('./foo.js');
    expect(sources).toContain('./side-effect.js');
  });

  it('handles file with no imports (empty imports array)', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/b.ts', enc('export function noop() {}'));

    const result = await extractStructuralTemplate(deps, makeReq({ files: ['src/b.ts'] }));

    const file = result.files[0]!;
    expect(file.imports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EST-3: TypeScript type and interface declarations appear in types[]
// ---------------------------------------------------------------------------

describe('EST-3: type and interface declarations extracted into types[]', () => {
  it('extracts interface and type alias names', async () => {
    const { deps, fs } = makeDeps();
    const src = [
      'export interface Foo { x: number; }',
      'export type Bar = string | number;',
      'export function baz(): void {}',
    ].join('\n');
    await fs.write('src/a.ts', enc(src));

    const result = await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    const file = result.files[0]!;
    const typeNames = file.types.map((t) => t.name);
    expect(typeNames).toContain('Foo');
    expect(typeNames).toContain('Bar');
  });

  it('returns empty types[] for JavaScript files (no TS type declarations)', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('export function hello() {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({ files: ['src/a.js'] }),
    );

    const file = result.files[0]!;
    expect(file.types).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EST-4: H7 determinism — identical inputs → byte-identical StructuralTemplate
// ---------------------------------------------------------------------------

describe('EST-4: determinism — same inputs produce byte-identical output', () => {
  it('produces identical results across two calls with the same input', async () => {
    const { deps, fs } = makeDeps();
    const src = [
      `import { z } from 'zod';`,
      'export function validate(x: unknown): boolean { return true; }',
      'export interface Schema { id: string; }',
      'export type Result = { ok: boolean };',
    ].join('\n');
    await fs.write('src/determinism.ts', enc(src));

    const req = makeReq({ files: ['src/determinism.ts'] });

    const result1 = await extractStructuralTemplate(deps, req);
    const result2 = await extractStructuralTemplate(deps, req);

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  it('produces byte-identical output when file content is identical but calls are interleaved', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export function foo(): void {}'));
    await fs.write('src/b.ts', enc('export function bar(): void {}'));

    const req1 = makeReq({ files: ['src/a.ts', 'src/b.ts'], correlationId: 'corr-det-1' });
    const req2 = makeReq({ files: ['src/a.ts', 'src/b.ts'], correlationId: 'corr-det-2' });

    const r1 = await extractStructuralTemplate(deps, req1);
    const r2 = await extractStructuralTemplate(deps, req2);

    // Files and structural content should be identical (correlationId is not in result)
    expect(r1.files.map((f) => f.path)).toEqual(r2.files.map((f) => f.path));
    expect(JSON.stringify(r1.files)).toBe(JSON.stringify(r2.files));
  });
});

// ---------------------------------------------------------------------------
// EST-5: Sorted file order (alphabetical) — H7
// ---------------------------------------------------------------------------

describe('EST-5: files in result are sorted alphabetically', () => {
  it('returns files in alphabetical order regardless of request order', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/z.ts', enc('export function zeta(): void {}'));
    await fs.write('src/a.ts', enc('export function alpha(): void {}'));
    await fs.write('src/m.ts', enc('export function mu(): void {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({ files: ['src/z.ts', 'src/a.ts', 'src/m.ts'] }),
    );

    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });
});

// ---------------------------------------------------------------------------
// EST-6: snapshotRef is null when no snapshotRefId provided
// ---------------------------------------------------------------------------

describe('EST-6: snapshotRef is null for live-FS mode', () => {
  it('has snapshotRef: null when snapshotRefId is not in the request', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export function noop(): void {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({ files: ['src/a.ts'] }),
    );

    expect(result.snapshotRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EST-7: customQueries parameter replaces built-in bundle
// ---------------------------------------------------------------------------

describe('EST-7: customQueries replaces built-in query bundle', () => {
  it('uses custom queries instead of built-in extract-exports when provided', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('function named(): void {} export function exported(): void {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({
        files: ['src/a.ts'],
        customQueries: [EXTRACT_FUNCTION_SIGNATURES_TS],
      }),
    );

    // With function-signatures query, we get function names but not the full export+import+type bundle.
    // Result files are still present; the exports/imports/types arrays are populated from the queryId mapping.
    // Since customQueries uses a different queryId ('extract-function-signatures' != 'extract-exports'),
    // the exports[] array will be empty (we only map 'extract-exports' captures to exports).
    const file = result.files[0]!;
    // The template was produced — file entry exists.
    expect(file.path).toBe('src/a.ts');
    // With custom queries, the built-in export/import/type assembly is not used.
    expect(file.exports).toHaveLength(0);
    expect(file.imports).toHaveLength(0);
    expect(file.types).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EST-8: queryId defaults and custom queryId respected
// ---------------------------------------------------------------------------

describe('EST-8: queryId in result', () => {
  it('defaults to "structural-template" when no queryId in request', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export function foo(): void {}'));

    const result = await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    expect(result.queryId).toBe(DEFAULT_TEMPLATE_QUERY_ID);
    expect(result.queryId).toBe('structural-template');
  });

  it('uses custom queryId when provided in request', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export function foo(): void {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({ files: ['src/a.ts'], queryId: 'my-custom-bundle-v2' }),
    );

    expect(result.queryId).toBe('my-custom-bundle-v2');
  });
});

// ---------------------------------------------------------------------------
// EST-9: H13 — emitted events contain no source content
// ---------------------------------------------------------------------------

describe('EST-9: H13 — events contain no source content', () => {
  it('all emitted events pass content-free assertion', async () => {
    const { deps, fs, emitter } = makeDeps();
    const src = [
      `import { readFile } from 'node:fs/promises';`,
      'export const SECRET = "top-secret";',
      'export interface Config { apiKey: string; }',
    ].join('\n');
    await fs.write('src/a.ts', enc(src));

    await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      // assertEventIsContentFree runs both Zod schema check and content heuristics
      assertEventIsContentFree(event);
    }
  });

  it('start and end events have correct op and phase', async () => {
    const { deps, fs, emitter } = makeDeps();
    await fs.write('src/a.ts', enc('export function noop(): void {}'));

    await extractStructuralTemplate(deps, makeReq({ files: ['src/a.ts'] }));

    // Filter to only extractStructuralTemplate events (queryStructure also emits)
    const estEvents = emitter.getEvents().filter((e) => e.op === 'extractStructuralTemplate');
    const startEvent = estEvents.find((e) => e.phase === 'start');
    const endEvent = estEvents.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(startEvent?.op).toBe('extractStructuralTemplate');
    expect(endEvent).toBeDefined();
    expect(endEvent?.op).toBe('extractStructuralTemplate');
    expect(endEvent?.classification).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// EST-10: Missing file → silently omitted, other files still processed
// ---------------------------------------------------------------------------

describe('EST-10: missing file silently omitted, others processed', () => {
  it('returns template for existing file even when another file is missing', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/exists.ts', enc('export function present(): void {}'));

    const result = await extractStructuralTemplate(
      deps,
      makeReq({ files: ['src/missing.ts', 'src/exists.ts'] }),
    );

    // Both files appear in the result (sorted alphabetically); missing file has empty arrays
    expect(result.files).toHaveLength(2);

    const existsFile = result.files.find((f) => f.path === 'src/exists.ts')!;
    expect(existsFile).toBeDefined();
    const exportNames = existsFile.exports.map((e) => e.name);
    expect(exportNames).toContain('present');

    const missingFile = result.files.find((f) => f.path === 'src/missing.ts')!;
    expect(missingFile).toBeDefined();
    expect(missingFile.exports).toHaveLength(0);
    expect(missingFile.imports).toHaveLength(0);
    expect(missingFile.types).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EST-11: Invalid request → ValidationError thrown
// ---------------------------------------------------------------------------

describe('EST-11: invalid request throws ValidationError', () => {
  it('throws ValidationError when files array is empty', async () => {
    const { deps } = makeDeps();

    await expect(
      extractStructuralTemplate(
        deps,
        makeReq({ files: [] }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when correlationId is missing', async () => {
    const { deps } = makeDeps();

    await expect(
      extractStructuralTemplate(
        deps,
        // @ts-expect-error — deliberately passing invalid shape
        { projectId: 'p', runId: 'r', files: ['src/a.ts'] },
      ),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// EST-12: Snapshot mode — reads from git blob, not live FS
// ---------------------------------------------------------------------------

describe('EST-12: snapshot mode reads from git blob', () => {
  it('returns template from snapshot content, not live filesystem', async () => {
    // Build a real snapshot using createSnapshot, then verify extractStructuralTemplate
    // reads the snapshot-time content (not any subsequent live-FS changes).

    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const store = await createIsolatedTestStore();
    const lock = createAsyncMutexLockProvider();
    const emitter = createMemoryEmitter();
    const secretScanner = createBuiltinRegexScanner();

    const snapshotSrc = 'export function snapshotVersion(): string { return "v1"; }';
    const liveSrc = 'export function liveVersion(): string { return "v2"; }';
    const FILE = 'src/target.ts';

    // Write and snapshot the v1 content.
    await fs.write(FILE, enc(snapshotSrc));

    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-est-snap',
      runId: 'run-est-snap-001',
      correlationId: 'corr-est-snap-001',
      entries: [{ path: FILE, scope: { kind: 'whole_file' } }],
    };

    const createSnapshotDeps: CreateSnapshotDeps = {
      fs,
      versioning,
      snapshotStore: store,
      lockProvider: lock,
      emitter,
      secretScanner,
      engineId: 'test-est-snap',
      config: {
        gitRepoDir: GIT_REPO_DIR,
        fsRoot: FS_ROOT,
        manifestStorageMode: 'inline',
        ttlRetentionMs: 0,
      },
    };

    const snapResult = await createSnapshot(createSnapshotDeps, { manifest });
    const snapshotRefId = snapResult.snapshotRef.id;

    // Now overwrite the live file with v2 content.
    await fs.write(FILE, enc(liveSrc));

    // extractStructuralTemplate with snapshotRefId should use v1 (snapshot content).
    const deps: ExtractStructuralTemplateDeps = {
      fs,
      versioning,
      snapshotStore: store,
      codeIntelligence: sharedCI,
      emitter,
      engineId: 'test-est-snap',
      root: FS_ROOT,
      config: {
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        gitRepoDir: GIT_REPO_DIR,
      },
    };

    const result = await extractStructuralTemplate(deps, {
      projectId: 'proj-est-snap',
      runId: 'run-est-snap-001',
      correlationId: 'corr-est-snap-002',
      files: [FILE],
      snapshotRefId,
    });

    expect(result.snapshotRef).toBe(snapshotRefId);

    // Template should contain 'snapshotVersion' (from v1), not 'liveVersion' (from v2).
    const file = result.files[0]!;
    const exportNames = file.exports.map((e) => e.name);
    expect(exportNames).toContain('snapshotVersion');
    expect(exportNames).not.toContain('liveVersion');
  }, 30_000);
});
