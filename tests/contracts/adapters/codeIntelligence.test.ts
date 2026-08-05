/**
 * Contract tests for createTreeSitterIntelligence — Slice D3.
 *
 * Proves: factory, language detection, symbol extraction, error handling,
 * AbortSignal, hard ceiling, malformed-source recovery, and determinism (H7).
 *
 * Does NOT modify tests/contracts/codeIntelligence.test.ts (A3.1 interface tests).
 *
 * Required grammars must be present in vendor/grammars/ (run: node scripts/fetch-grammars.js).
 * Tests use the real WASM grammars — no mocking of tree-sitter.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  createTreeSitterIntelligence,
} from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type {
  RefinedSyntaxTree,
} from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';
import { EngineError, AdapterError } from '../../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// We share a single adapter instance across tests to avoid re-initializing
// the WASM runtime multiple times (Parser.init is idempotent but expensive).
let adapter: CodeIntelligenceAdapter;

beforeAll(async () => {
  adapter = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// 1. Factory loads grammars
// ---------------------------------------------------------------------------

describe('D3 — factory', () => {
  it('resolves with a valid adapter object', () => {
    expect(adapter).toBeDefined();
    expect(typeof adapter.parse).toBe('function');
    expect(typeof adapter.getTopLevelSymbols).toBe('function');
  });

  it('optional LSP methods are not defined (feature-detection friendly)', () => {
    expect(adapter.findReferences).toBeUndefined();
    expect(adapter.getDiagnostics).toBeUndefined();
    expect(adapter.goToDefinition).toBeUndefined();
    expect(adapter.callHierarchy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Missing grammars fail fast
// ---------------------------------------------------------------------------

describe('D3 — missing grammars', () => {
  it('throws EngineError when grammarsDir is bogus', async () => {
    await expect(
      createTreeSitterIntelligence({ grammarsDir: '/nonexistent/path/grammars' })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EngineError &&
        (e.kind === 'wasm_load_failed' || e.kind === 'grammar_not_registered')
    );
  });
});

// ---------------------------------------------------------------------------
// 3. JS parse
// ---------------------------------------------------------------------------

describe('D3 — JS parse', () => {
  it('parses a trivial JS file and returns language=javascript', async () => {
    const tree = (await adapter.parse(
      'src/test.js',
      enc('const x = 1;')
    )) as RefinedSyntaxTree;

    expect(tree.rootNode.kind).toBe('program');
    expect(tree.language).toBe('javascript');
    expect(typeof tree.grammarVersion).toBe('string');
    expect(tree.grammarVersion.length).toBeGreaterThan(0);
  });

  it('returns a tree for a .mjs file', async () => {
    const tree = (await adapter.parse('mod.mjs', enc('export const a = 1;'))) as RefinedSyntaxTree;
    expect(tree.language).toBe('javascript');
  });

  it('returns a tree for a .jsx file (uses javascript grammar)', async () => {
    const tree = (await adapter.parse('comp.jsx', enc('const el = <div />;'))) as RefinedSyntaxTree;
    expect(tree.language).toBe('javascript');
  });
});

// ---------------------------------------------------------------------------
// 4. TypeScript parse
// ---------------------------------------------------------------------------

describe('D3 — TS parse', () => {
  it('parses a TypeScript fixture and returns language=typescript', async () => {
    const src = 'const x: number = 1;\nfunction foo(a: string): void {}';
    const tree = (await adapter.parse('src/test.ts', enc(src))) as RefinedSyntaxTree;
    expect(tree.rootNode.kind).toBe('program');
    expect(tree.language).toBe('typescript');
  });
});

// ---------------------------------------------------------------------------
// 5. TSX parse
// ---------------------------------------------------------------------------

describe('D3 — TSX parse', () => {
  it('parses a TSX fixture and returns language=tsx', async () => {
    const src = 'import React from "react";\nconst A = () => <div>hi</div>;';
    const tree = (await adapter.parse('comp.tsx', enc(src))) as RefinedSyntaxTree;
    expect(tree.rootNode.kind).toBe('program');
    expect(tree.language).toBe('tsx');
  });
});

// ---------------------------------------------------------------------------
// 6. Unsupported extension
// ---------------------------------------------------------------------------

describe('D3 — unsupported extension', () => {
  it('throws AdapterError(parser_init_failed) for .py', async () => {
    await expect(
      adapter.parse('foo.py', enc('x = 1'))
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdapterError && e.kind === 'parser_init_failed'
    );
  });

  it('throws AdapterError(parser_init_failed) for .rb', async () => {
    await expect(
      adapter.parse('script.rb', enc('puts "hi"'))
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdapterError && e.kind === 'parser_init_failed'
    );
  });

  it('throws AdapterError(parser_init_failed) for file with no extension', async () => {
    await expect(
      adapter.parse('Makefile', enc('all:'))
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdapterError && e.kind === 'parser_init_failed'
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Top-level symbols — functions
// ---------------------------------------------------------------------------

describe('D3 — getTopLevelSymbols: functions', () => {
  it('extracts function declarations in source order', async () => {
    const src = 'function foo() {}\nfunction bar() {}';
    const tree = await adapter.parse('f.js', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).toEqual(['foo', 'bar']);
  });

  it('includes byteRange for each symbol', async () => {
    const src = 'function foo() {}';
    const tree = await adapter.parse('f.js', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    expect(symbols).toHaveLength(1);
    const sym = symbols[0]!;
    expect(sym.byteRange[0]).toBeGreaterThanOrEqual(0);
    expect(sym.byteRange[1]).toBeGreaterThan(sym.byteRange[0]);
  });

  it('includes kind = function_declaration', async () => {
    const src = 'function foo() {}';
    const tree = await adapter.parse('f.js', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    expect(symbols[0]?.kind).toBe('function_declaration');
  });
});

// ---------------------------------------------------------------------------
// 8. Top-level symbols — classes; method NOT top-level
// ---------------------------------------------------------------------------

describe('D3 — getTopLevelSymbols: classes', () => {
  it('extracts class_declaration as top-level symbol', async () => {
    const src = 'class Foo { method() {} }';
    const tree = await adapter.parse('f.ts', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Foo');
  });

  it('does NOT include class methods as top-level symbols', async () => {
    const src = 'class Foo { method() {} }';
    const tree = await adapter.parse('f.ts', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('method');
  });
});

// ---------------------------------------------------------------------------
// 9. Top-level symbols — exports
// ---------------------------------------------------------------------------

describe('D3 — getTopLevelSymbols: exports', () => {
  it('extracts exported function name', async () => {
    const src = 'export function baz() {}';
    const tree = await adapter.parse('f.ts', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('baz');
  });

  it('extracts exported class name', async () => {
    const src = 'export class MyService {}';
    const tree = await adapter.parse('f.ts', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('MyService');
  });
});

// ---------------------------------------------------------------------------
// 10. Top-level symbols — variables
// ---------------------------------------------------------------------------

describe('D3 — getTopLevelSymbols: variables', () => {
  it('extracts const and let declarations', async () => {
    const src = 'const x = 1;\nlet y = 2;';
    const tree = await adapter.parse('f.js', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('x');
    expect(names).toContain('y');
  });

  it('preserves source order for variables', async () => {
    const src = 'const x = 1;\nlet y = 2;';
    const tree = await adapter.parse('f.js', enc(src));
    const symbols = adapter.getTopLevelSymbols(tree);
    const names = symbols.map((s) => s.name);
    expect(names.indexOf('x')).toBeLessThan(names.indexOf('y'));
  });
});

// ---------------------------------------------------------------------------
// 11. Order determinism (H7)
// ---------------------------------------------------------------------------

describe('D3 — determinism (H7)', () => {
  it('two parses of the same source produce identical symbol arrays', async () => {
    const src = [
      'const a = 1;',
      'function foo() {}',
      'class Bar {}',
      'export const z = 3;',
    ].join('\n');

    const tree1 = await adapter.parse('f.ts', enc(src));
    const tree2 = await adapter.parse('f.ts', enc(src));

    const s1 = adapter.getTopLevelSymbols(tree1);
    const s2 = adapter.getTopLevelSymbols(tree2);

    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});

// ---------------------------------------------------------------------------
// 12. AbortSignal honored
// ---------------------------------------------------------------------------

describe('D3 — AbortSignal', () => {
  it('pre-aborted signal causes parse to reject', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.parse('f.js', enc('const x = 1;'), controller.signal)
    ).rejects.toBeDefined();
  });

  it('AbortSignal.timeout(0) causes parse to reject', async () => {
    const signal = AbortSignal.timeout(0);
    // Give the timeout a tick to fire
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      adapter.parse('f.js', enc('const x = 1;'), signal)
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. Hard ceiling (10 MB)
// ---------------------------------------------------------------------------

describe('D3 — hard ceiling', () => {
  it('rejects content larger than 10 MB with AdapterError', async () => {
    const oversize = new Uint8Array(10 * 1024 * 1024 + 1);

    await expect(
      adapter.parse('big.js', oversize)
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdapterError && e.kind === 'parser_init_failed'
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Malformed source produces error-recoverant tree (no throw)
// ---------------------------------------------------------------------------

describe('D3 — malformed source recovery', () => {
  it('parse does NOT throw on syntactically invalid JS', async () => {
    const badSrc = 'function ({}{ const; = if => ))';
    const tree = (await adapter.parse('bad.js', enc(badSrc))) as RefinedSyntaxTree;
    // tree-sitter is error-recoverant: always returns a tree
    expect(tree).toBeDefined();
    expect(tree.rootNode).toBeDefined();
    // rootNode may have ERROR subtree but parse itself succeeds
  });

  it('parse does NOT throw on empty source', async () => {
    const tree = (await adapter.parse('empty.js', enc(''))) as RefinedSyntaxTree;
    expect(tree.rootNode.kind).toBe('program');
  });

  it('parse does NOT throw on valid TS with type errors (semantic, not parse errors)', async () => {
    // This is syntactically valid TS but semantically wrong (type mismatch)
    const src = 'const x: number = "not a number";';
    const tree = (await adapter.parse('typed.ts', enc(src))) as RefinedSyntaxTree;
    expect(tree.rootNode.kind).toBe('program');
  });
});
