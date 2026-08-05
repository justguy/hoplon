/**
 * tests/operations/queryStructure.test.ts — CI3-3 targeted test suite.
 *
 * Proof requirements:
 *  QS-1  Single-file query → expected captures returned
 *  QS-2  Multi-file query → results in sorted file order
 *  QS-3  Invalid S-expression → typed ValidationError or failure record
 *  QS-4  Language mismatch → query silently skipped (no failure, no match)
 *  QS-5  Missing file → failure record, other files still processed
 *  QS-6  Standard query: extract-function-signatures
 *  QS-7  Standard query: extract-exports
 *  QS-8  Standard query: extract-imports
 *  QS-9  Standard query: extract-class-methods
 *  QS-10 H20: byteRange is UTF-8 byte offset (multi-byte fixture)
 *  QS-11 H13: emitted events contain no source content
 *  QS-12 ASTStrategy tree_sitter_query variant accepted by Zod schema
 *  QS-13 Zod request schema rejects missing queries array
 *  QS-14 Zod request schema rejects empty files array
 *
 * Uses:
 *   - createMemFsAdapter()       — in-memory fs (C2)
 *   - createTreeSitterIntelligence() — real WASM grammars (D3)
 *   - createMemoryEmitter()      — in-memory event store (C5)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { queryStructure } from '../../src/hoplon/operations/queryStructure.js';
import type { QueryStructureDeps } from '../../src/hoplon/operations/queryStructure.js';
import {
  EXTRACT_FUNCTION_SIGNATURES_JS,
  EXTRACT_FUNCTION_SIGNATURES_TS,
  EXTRACT_EXPORTS_JS,
  EXTRACT_IMPORTS_TS,
  EXTRACT_CLASS_METHODS_JS,
} from '../../src/hoplon/operations/stdQueries.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import { ASTStrategySchema } from '../../src/hoplon/contracts/astStrategy.js';
import { QueryStructureRequestSchema } from '../../src/hoplon/contracts/queryStructure.js';
import type { QueryStructureRequest } from '../../src/hoplon/contracts/queryStructure.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeReq(overrides: Partial<QueryStructureRequest> = {}): QueryStructureRequest {
  return {
    projectId: 'proj-qs-test',
    runId: 'run-qs-001',
    correlationId: 'corr-qs-001',
    files: ['src/a.js'],
    queries: [EXTRACT_FUNCTION_SIGNATURES_JS],
    ...overrides,
  };
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(ci: CodeIntelligenceAdapter = sharedCI): {
  deps: QueryStructureDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const deps: QueryStructureDeps = {
    fs,
    codeIntelligence: ci,
    emitter,
    engineId: 'test-qs-engine',
    root: '/',
    config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 5000 },
  };
  return { deps, fs, emitter };
}

// ---------------------------------------------------------------------------
// QS-1 — Single-file query, expected captures
// ---------------------------------------------------------------------------

describe('QS-1: single-file query returns expected captures', () => {
  it('returns function name captures for a JS fixture', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('function hello() {} function world() {}'));

    const result = await queryStructure(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.failures).toHaveLength(0);
    const texts = result.matches.map((m) => m.text);
    expect(texts).toContain('hello');
    expect(texts).toContain('world');
    expect(result.matches.every((m) => m.queryId === 'extract-function-signatures')).toBe(true);
    expect(result.matches.every((m) => m.path === 'src/a.js')).toBe(true);
    expect(result.matches.every((m) => m.captureName === 'func_name')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QS-2 — Multi-file query, results in sorted file order
// ---------------------------------------------------------------------------

describe('QS-2: multi-file query returns results in sorted file order', () => {
  it('returns matches sorted by path then byteRange', async () => {
    const { deps, fs } = makeDeps();
    // Write files in reverse alphabetical order — result must still be sorted
    await fs.write('src/z.js', enc('function zeta() {}'));
    await fs.write('src/a.js', enc('function alpha() {}'));
    await fs.write('src/m.js', enc('function mu() {}'));

    const result = await queryStructure(
      deps,
      makeReq({ files: ['src/z.js', 'src/a.js', 'src/m.js'] }),
    );

    expect(result.failures).toHaveLength(0);
    const paths = result.matches.map((m) => m.path);
    expect(paths).toEqual(['src/a.js', 'src/m.js', 'src/z.js']);
    expect(result.matches.map((m) => m.text)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('multiple matches within same file are sorted by byteRange[0]', async () => {
    const { deps, fs } = makeDeps();
    // foo appears before bar in source order → byteRange[0] of foo < bar
    await fs.write('src/a.js', enc('function foo() {} function bar() {}'));

    const result = await queryStructure(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.failures).toHaveLength(0);
    expect(result.matches.length).toBe(2);
    // Source order: foo (0...) then bar (...)
    expect(result.matches[0]!.text).toBe('foo');
    expect(result.matches[1]!.text).toBe('bar');
    expect(result.matches[0]!.byteRange[0]).toBeLessThan(result.matches[1]!.byteRange[0]);
  });
});

// ---------------------------------------------------------------------------
// QS-3 — Invalid S-expression → failure record (not a thrown error)
// ---------------------------------------------------------------------------

describe('QS-3: invalid S-expression produces a failure record', () => {
  it('records an invalid_query failure for a malformed pattern', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('function foo() {}'));

    const result = await queryStructure(
      deps,
      makeReq({
        files: ['src/a.js'],
        queries: [{ id: 'bad-query', language: 'javascript', pattern: '(((invalid_node_type' }],
      }),
    );

    // No matches
    expect(result.matches).toHaveLength(0);
    // One failure with reason 'invalid_query'
    expect(result.failures.length).toBeGreaterThan(0);
    const f = result.failures.find((x) => x.reason === 'invalid_query');
    expect(f).toBeDefined();
    expect(f!.queryId).toBe('bad-query');
    expect(f!.path).toBe('src/a.js');
    expect(f!.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// QS-4 — Language mismatch → query silently skipped
// ---------------------------------------------------------------------------

describe('QS-4: language mismatch → query silently skipped', () => {
  it('does not produce failures or matches when query.language does not match file ext', async () => {
    const { deps, fs } = makeDeps();
    // File is TypeScript but query targets JavaScript
    await fs.write('src/a.ts', enc('function foo() {}'));

    const result = await queryStructure(
      deps,
      makeReq({
        files: ['src/a.ts'],
        queries: [EXTRACT_FUNCTION_SIGNATURES_JS], // language: 'javascript'
      }),
    );

    expect(result.matches).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  it('captures when query.language matches the file', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('function foo(): void {}'));

    const result = await queryStructure(
      deps,
      makeReq({
        files: ['src/a.ts'],
        queries: [EXTRACT_FUNCTION_SIGNATURES_TS], // language: 'typescript'
      }),
    );

    expect(result.matches.map((m) => m.text)).toContain('foo');
  });
});

// ---------------------------------------------------------------------------
// QS-5 — Missing file → failure record, other files unaffected
// ---------------------------------------------------------------------------

describe('QS-5: missing file produces failure, other files processed', () => {
  it('records file_not_found for missing file, returns matches from existing file', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/exists.js', enc('function present() {}'));

    const result = await queryStructure(
      deps,
      makeReq({ files: ['src/missing.js', 'src/exists.js'] }),
    );

    const notFoundFailures = result.failures.filter((f) => f.reason === 'file_not_found');
    expect(notFoundFailures.length).toBeGreaterThan(0);
    expect(notFoundFailures.some((f) => f.path === 'src/missing.js')).toBe(true);

    // Existing file still yields matches
    const texts = result.matches.map((m) => m.text);
    expect(texts).toContain('present');
  });
});

// ---------------------------------------------------------------------------
// QS-6 — Standard query: extract-function-signatures
// ---------------------------------------------------------------------------

describe('QS-6: standard query extract-function-signatures', () => {
  it('captures top-level function names from JS', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/a.js',
      enc(`function alpha() {}
function beta(x, y) { return x + y; }
const notAFn = 42;`),
    );

    const result = await queryStructure(
      deps,
      makeReq({ queries: [EXTRACT_FUNCTION_SIGNATURES_JS] }),
    );

    expect(result.failures).toHaveLength(0);
    const names = result.matches.map((m) => m.text);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('notAFn');
  });
});

// ---------------------------------------------------------------------------
// QS-7 — Standard query: extract-exports
// ---------------------------------------------------------------------------

describe('QS-7: standard query extract-exports', () => {
  it('captures exported declaration nodes from JS', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/a.js',
      enc(`export function foo() {}
export const bar = 1;
const notExported = 2;`),
    );

    const result = await queryStructure(
      deps,
      makeReq({ queries: [EXTRACT_EXPORTS_JS] }),
    );

    expect(result.failures).toHaveLength(0);
    // Each export_statement with a declaration produces one @exported capture
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches.every((m) => m.queryId === 'extract-exports')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QS-8 — Standard query: extract-imports
// ---------------------------------------------------------------------------

describe('QS-8: standard query extract-imports', () => {
  it('captures import path strings from TypeScript', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/a.ts',
      enc(`import { foo } from './foo.js';
import type { Bar } from './bar.js';`),
    );

    const result = await queryStructure(
      deps,
      makeReq({
        files: ['src/a.ts'],
        queries: [EXTRACT_IMPORTS_TS],
      }),
    );

    expect(result.failures).toHaveLength(0);
    const texts = result.matches.map((m) => m.text);
    expect(texts.some((t) => t.includes('foo.js'))).toBe(true);
    expect(texts.some((t) => t.includes('bar.js'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QS-9 — Standard query: extract-class-methods
// ---------------------------------------------------------------------------

describe('QS-9: standard query extract-class-methods', () => {
  it('captures method names from a JS class', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/a.js',
      enc(`class Greeter {
  hello() { return 'hi'; }
  goodbye() { return 'bye'; }
}`),
    );

    const result = await queryStructure(
      deps,
      makeReq({ queries: [EXTRACT_CLASS_METHODS_JS] }),
    );

    expect(result.failures).toHaveLength(0);
    const names = result.matches.map((m) => m.text);
    expect(names).toContain('hello');
    expect(names).toContain('goodbye');
  });
});

// ---------------------------------------------------------------------------
// QS-10 — H20: byteRange is UTF-8 byte offset, not char position
// ---------------------------------------------------------------------------

describe('QS-10: H20 — byteRange values are UTF-8 byte offsets', () => {
  it('byteRange round-trips correctly on multi-byte content', async () => {
    const { deps, fs } = makeDeps();
    // Preceding Unicode comment shifts byte vs char position
    const source = `// こんにちは コメント\nfunction target() {}`;
    await fs.write('src/a.js', enc(source));

    const result = await queryStructure(deps, makeReq({ files: ['src/a.js'] }));

    expect(result.failures).toHaveLength(0);
    const match = result.matches.find((m) => m.text === 'target');
    expect(match).toBeDefined();

    const [start, end] = match!.byteRange;
    const buf = Buffer.from(enc(source));
    const sliced = buf.subarray(start, end).toString('utf8');
    expect(sliced).toBe('target');

    // Verify byte offset differs from char position (multi-byte chars make them diverge)
    const charPos = source.indexOf('target');
    const bytePos = Buffer.byteLength(source.slice(0, charPos), 'utf8');
    expect(bytePos).toBe(start);
    expect(charPos).not.toBe(bytePos); // They differ due to CJK bytes
  });
});

// ---------------------------------------------------------------------------
// QS-11 — H13: emitted events contain no source content
// ---------------------------------------------------------------------------

describe('QS-11: H13 — emitted events contain no source content', () => {
  it('events do not include captured text, file content, or symbol names', async () => {
    const { deps, fs, emitter } = makeDeps();
    await fs.write('src/a.js', enc('function secretFunctionName() {}'));

    await queryStructure(deps, makeReq({ files: ['src/a.js'] }));

    const events = emitter.getEvents();
    for (const ev of events) {
      const serialized = JSON.stringify(ev);
      // No captured text, no source content, no function names in events
      expect(serialized).not.toContain('secretFunctionName');
      expect(serialized).not.toContain('function');
    }
    // Start and end events must be emitted
    expect(events.some((e) => e.op === 'queryStructure' && e.phase === 'start')).toBe(true);
    expect(events.some((e) => e.op === 'queryStructure' && e.phase === 'end')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QS-12 — ASTStrategy tree_sitter_query variant accepted by Zod schema
// ---------------------------------------------------------------------------

describe('QS-12: ASTStrategy tree_sitter_query variant', () => {
  it('is accepted by ASTStrategySchema', () => {
    const result = ASTStrategySchema.safeParse({
      kind: 'tree_sitter_query',
      queries: [{ id: 'test', language: 'javascript', pattern: '(identifier) @id' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects tree_sitter_query with empty queries array', () => {
    const result = ASTStrategySchema.safeParse({
      kind: 'tree_sitter_query',
      queries: [],
    });
    expect(result.success).toBe(false);
  });

  it('existing whole_file variant still accepted', () => {
    expect(ASTStrategySchema.safeParse({ kind: 'whole_file' }).success).toBe(true);
  });

  it('existing symbols variant still accepted', () => {
    expect(
      ASTStrategySchema.safeParse({ kind: 'symbols', symbols: ['foo'] }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QS-13 — Request schema rejects missing queries
// ---------------------------------------------------------------------------

describe('QS-13: request schema validation', () => {
  it('rejects request with missing queries field', () => {
    const result = QueryStructureRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      files: ['a.js'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects request with empty queries array', () => {
    const result = QueryStructureRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      files: ['a.js'],
      queries: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects query with unsupported language', () => {
    const result = QueryStructureRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      files: ['a.js'],
      queries: [{ id: 'x', language: 'python', pattern: '(x) @y' }],
    });
    expect(result.success).toBe(false);
  });

  it('throws ValidationError for structurally invalid request', async () => {
    const { deps } = makeDeps();
    await expect(
      queryStructure(deps, {
        projectId: '',
        runId: 'r',
        correlationId: 'c',
        files: ['a.js'],
        queries: [EXTRACT_FUNCTION_SIGNATURES_JS],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// QS-14 — Request schema rejects empty files array
// ---------------------------------------------------------------------------

describe('QS-14: request schema rejects empty files array', () => {
  it('rejects request with empty files', () => {
    const result = QueryStructureRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      files: [],
      queries: [EXTRACT_FUNCTION_SIGNATURES_JS],
    });
    expect(result.success).toBe(false);
  });
});
