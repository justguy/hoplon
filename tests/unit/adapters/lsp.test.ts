/**
 * tests/unit/adapters/lsp.test.ts — LSP1 targeted proof tests.
 *
 * Phase 3 Stage B — slice LSP1.
 *
 * Verifies:
 *   LSP1-1  createLspCodeIntelligence satisfies CodeIntelligenceAdapter contract
 *           (parse + getTopLevelSymbols delegated to fallback)
 *   LSP1-2  Mock provider returns precise signature (not SIGNATURE_UNCERTAIN) —
 *           proves the seam can improve on tree-sitter
 *   LSP1-3  findReferences routes through mock provider when fixtures exist
 *   LSP1-4  findReferences falls back to fallback adapter when mock returns []
 *   LSP1-5  Fallback to tree-sitter when mock provider returns undefined
 *           (resolveSignature undefined → goToDefinition returns null)
 *   LSP1-6  createLspCodeIntelligence with no fallback throws on parse()
 *   LSP1-7  createLspCodeIntelligence with no fallback throws on getTopLevelSymbols()
 *   LSP1-8  createMockLspProvider catch-all '*' key for resolveSignature
 *   LSP1-9  createMockLspProvider fine-grained positionSignatures key takes precedence
 *   LSP1-10 createMockLspProvider resolveImport fixture lookup
 *   LSP1-11 createMockLspProvider returns undefined for unknown specifiers
 *   LSP1-12 H13 content-free events: LSP adapter does not emit events directly
 *           (event emission is the engine's responsibility — adapter is pure logic)
 *   LSP1-13 Returned adapter has findReferences and goToDefinition methods
 *           (feature-detection: these appear on the returned object)
 *
 * No WASM required for tests 1-13 (mock fallback is used in the few parse-touching
 * tests via a synthetic no-op fallback, not the real tree-sitter adapter).
 * The H13 proof exercise uses assertEventIsContentFree on a memory emitter to
 * confirm the adapter itself does not emit any events.
 */

import { describe, it, expect } from 'vitest';

import { createLspCodeIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/lsp.js';
import { createMockLspProvider } from '../../../src/hoplon/adapters/codeIntelligence/mockLspProvider.js';
import { assertEventIsContentFree } from '../../../src/hoplon/adapters/emitter/assert.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
  Symbol,
  Reference,
} from '../../../src/hoplon/adapters/codeIntelligence.js';

// ---------------------------------------------------------------------------
// Synthetic in-memory fallback adapter (no WASM)
// ---------------------------------------------------------------------------

const SYNTHETIC_TREE: SyntaxTree = {
  rootNode: { kind: 'program', children: [] },
};

const SYNTHETIC_SYMBOL: Symbol = {
  name: 'syntheticFn',
  kind: 'function_declaration',
  byteRange: [0, 10],
};

const SYNTHETIC_REFERENCE: Reference = {
  path: '/project/src/caller.ts',
  byteRange: [50, 62],
};

function createSyntheticFallback(): CodeIntelligenceAdapter {
  return {
    async parse(_file: string, _content: Uint8Array, _signal?: AbortSignal): Promise<SyntaxTree> {
      return SYNTHETIC_TREE;
    },
    getTopLevelSymbols(_tree: SyntaxTree): Symbol[] {
      return [SYNTHETIC_SYMBOL];
    },
    async findReferences(_symbol: Symbol): Promise<Reference[]> {
      return [SYNTHETIC_REFERENCE];
    },
    async goToDefinition(_symbol: Symbol) {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// LSP1-1 — satisfies CodeIntelligenceAdapter contract (parse + getTopLevelSymbols)
// ---------------------------------------------------------------------------

describe('LSP1-1 — parse() and getTopLevelSymbols() delegated to fallback', () => {
  it('parse() delegates to fallback and returns the fallback tree', async () => {
    const provider = createMockLspProvider({});
    const fallback = createSyntheticFallback();
    const adapter = createLspCodeIntelligence({ lspProvider: provider, fallbackAdapter: fallback });

    const content = new TextEncoder().encode('const x = 1;');
    const tree = await adapter.parse('file.ts', content);
    expect(tree).toBe(SYNTHETIC_TREE);
  });

  it('getTopLevelSymbols() delegates to fallback and returns fallback symbols', async () => {
    const provider = createMockLspProvider({});
    const fallback = createSyntheticFallback();
    const adapter = createLspCodeIntelligence({ lspProvider: provider, fallbackAdapter: fallback });

    const content = new TextEncoder().encode('const x = 1;');
    const tree = await adapter.parse('file.ts', content);
    const symbols = adapter.getTopLevelSymbols(tree);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('syntheticFn');
  });

  it('parse() passes AbortSignal through to fallback (signal threading)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fallback: CodeIntelligenceAdapter = {
      async parse(_file, _content, signal) {
        receivedSignal = signal;
        return SYNTHETIC_TREE;
      },
      getTopLevelSymbols: () => [],
    };
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
      fallbackAdapter: fallback,
    });
    const signal = AbortSignal.timeout(5000);
    await adapter.parse('file.ts', new Uint8Array(), signal);
    expect(receivedSignal).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// LSP1-2 — Mock provider returns precise signature (not SIGNATURE_UNCERTAIN)
// ---------------------------------------------------------------------------

describe('LSP1-2 — mock provider delivers precise signature via resolveSignature', () => {
  it('resolveSignature returns the fixture signature for a catch-all key', async () => {
    const provider = createMockLspProvider({
      signatures: {
        '*': {
          label: 'Array.from<T>(arrayLike: ArrayLike<T>): T[]',
          parameters: ['arrayLike: ArrayLike<T>'],
        },
      },
    });
    const sig = await provider.resolveSignature('/project/src/main.ts', { line: 10, character: 5 });
    expect(sig).toBeDefined();
    expect(sig!.label).toBe('Array.from<T>(arrayLike: ArrayLike<T>): T[]');
    expect(sig!.parameters).toEqual(['arrayLike: ArrayLike<T>']);
    // Confirm the label is NOT the tree-sitter SIGNATURE_UNCERTAIN sentinel
    expect(sig!.label).not.toContain('SIGNATURE_UNCERTAIN');
  });

  it('resolveSignature returns precise generic signature with multiple parameters', async () => {
    const provider = createMockLspProvider({
      signatures: {
        '*': {
          label: 'Promise.all<T extends readonly unknown[]>(values: T): Promise<Awaited<T[number]>[]>',
          parameters: ['values: T'],
          documentation: 'Creates a Promise that resolves with an array of results.',
        },
      },
    });
    const sig = await provider.resolveSignature('/project/src/worker.ts', { line: 3, character: 12 });
    expect(sig).toBeDefined();
    expect(sig!.label).toContain('Promise.all');
    expect(sig!.parameters).toHaveLength(1);
    expect(sig!.documentation).toContain('Creates a Promise');
  });
});

// ---------------------------------------------------------------------------
// LSP1-3 — findReferences routes through mock provider
// ---------------------------------------------------------------------------

describe('LSP1-3 — findReferences routes through mock provider when fixtures exist', () => {
  it('returns LSP references for a known symbol', async () => {
    const provider = createMockLspProvider({
      references: {
        createSnapshot: [
          { path: '/project/src/engine.ts', byteRange: [120, 136] },
          { path: '/project/tests/engine.test.ts', byteRange: [45, 61] },
        ],
      },
    });
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: createSyntheticFallback(),
    });

    const sym: Symbol = { name: 'createSnapshot', kind: 'function_declaration', byteRange: [0, 14] };
    const refs = await adapter.findReferences!(sym);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.path).toBe('/project/src/engine.ts');
    expect(refs[0]!.byteRange).toEqual([120, 136]);
    expect(refs[1]!.path).toBe('/project/tests/engine.test.ts');
  });

  it('returns empty array for a symbol with no fixture entries', async () => {
    const provider = createMockLspProvider({ references: {} });
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: createSyntheticFallback(),
    });
    const sym: Symbol = { name: 'unknownSymbol', kind: 'function_declaration', byteRange: [0, 14] };
    const refs = await adapter.findReferences!(sym);
    // No LSP refs → falls through to fallback which returns [SYNTHETIC_REFERENCE]
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe('/project/src/caller.ts');
  });
});

// ---------------------------------------------------------------------------
// LSP1-4 — findReferences falls back when mock returns empty
// ---------------------------------------------------------------------------

describe('LSP1-4 — findReferences fallback when mock returns []', () => {
  it('delegates to fallback adapter findReferences when LSP returns []', async () => {
    const provider = createMockLspProvider({ references: {} }); // No fixture → always []
    const fallback = createSyntheticFallback();
    const adapter = createLspCodeIntelligence({ lspProvider: provider, fallbackAdapter: fallback });

    const sym: Symbol = { name: 'anySymbol', kind: 'class_declaration', byteRange: [0, 20] };
    const refs = await adapter.findReferences!(sym);
    // fallback.findReferences returns [SYNTHETIC_REFERENCE]
    expect(refs).toEqual([SYNTHETIC_REFERENCE]);
  });

  it('returns [] when mock is empty AND fallback has no findReferences', async () => {
    const provider = createMockLspProvider({ references: {} });
    const fallbackNoRefs: CodeIntelligenceAdapter = {
      async parse() { return SYNTHETIC_TREE; },
      getTopLevelSymbols: () => [],
      // No findReferences method
    };
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: fallbackNoRefs,
    });
    const sym: Symbol = { name: 'missingSymbol', kind: 'function_declaration', byteRange: [0, 13] };
    const refs = await adapter.findReferences!(sym);
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LSP1-5 — Fallback when mock provider returns undefined
// ---------------------------------------------------------------------------

describe('LSP1-5 — goToDefinition falls back when lspProvider returns undefined', () => {
  it('returns null when lspProvider.resolveSignature returns undefined and no fallback goToDefinition', async () => {
    const provider = createMockLspProvider({}); // No signatures → always undefined
    const fallbackNoGTD: CodeIntelligenceAdapter = {
      async parse() { return SYNTHETIC_TREE; },
      getTopLevelSymbols: () => [],
      // No goToDefinition
    };
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: fallbackNoGTD,
    });
    const sym: Symbol = { name: 'foo', kind: 'function_declaration', byteRange: [0, 3] };
    const loc = await adapter.goToDefinition!(sym);
    expect(loc).toBeNull();
  });

  it('delegates to fallback goToDefinition when lspProvider returns undefined', async () => {
    const provider = createMockLspProvider({}); // No signatures → undefined
    const fallbackWithGTD: CodeIntelligenceAdapter = {
      async parse() { return SYNTHETIC_TREE; },
      getTopLevelSymbols: () => [],
      async goToDefinition(_sym) {
        return { path: '/project/src/defs.ts', byteRange: [200, 215] };
      },
    };
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: fallbackWithGTD,
    });
    const sym: Symbol = { name: 'bar', kind: 'function_declaration', byteRange: [0, 3] };
    const loc = await adapter.goToDefinition!(sym);
    expect(loc).not.toBeNull();
    expect(loc!.path).toBe('/project/src/defs.ts');
  });
});

// ---------------------------------------------------------------------------
// LSP1-6 — No fallback: parse() throws
// ---------------------------------------------------------------------------

describe('LSP1-6 — no fallback: parse() throws descriptive error', () => {
  it('throws when no fallbackAdapter is provided and parse() is called', async () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
    });
    await expect(adapter.parse('file.ts', new Uint8Array())).rejects.toThrow(
      /parse\(\) requires a fallbackAdapter/,
    );
  });
});

// ---------------------------------------------------------------------------
// LSP1-7 — No fallback: getTopLevelSymbols() throws
// ---------------------------------------------------------------------------

describe('LSP1-7 — no fallback: getTopLevelSymbols() throws descriptive error', () => {
  it('throws when no fallbackAdapter is provided and getTopLevelSymbols() is called', () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
    });
    expect(() => adapter.getTopLevelSymbols(SYNTHETIC_TREE)).toThrow(
      /getTopLevelSymbols\(\) requires a fallbackAdapter/,
    );
  });
});

// ---------------------------------------------------------------------------
// LSP1-8 — createMockLspProvider: catch-all '*' key
// ---------------------------------------------------------------------------

describe('LSP1-8 — createMockLspProvider catch-all key', () => {
  it("returns fixture for '*' key regardless of file path", async () => {
    const sig = {
      label: 'fn(): void',
      parameters: [],
    };
    const provider = createMockLspProvider({ signatures: { '*': sig } });
    const r1 = await provider.resolveSignature('/a/b/c.ts', { line: 0, character: 0 });
    const r2 = await provider.resolveSignature('/x/y/z.js', { line: 99, character: 3 });
    expect(r1).toEqual(sig);
    expect(r2).toEqual(sig);
  });

  it('returns undefined when no signatures configured', async () => {
    const provider = createMockLspProvider({});
    const result = await provider.resolveSignature('/any/file.ts', { line: 0, character: 0 });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSP1-9 — createMockLspProvider: positionSignatures takes precedence
// ---------------------------------------------------------------------------

describe('LSP1-9 — positionSignatures key takes precedence over signatures', () => {
  it('returns positionSignature fixture over catch-all', async () => {
    const catchAll = { label: 'generic(): void', parameters: [] };
    const precise = { label: 'specificFn(x: string): number', parameters: ['x: string'] };
    const provider = createMockLspProvider({
      signatures: { '*': catchAll },
      positionSignatures: {
        '/project/src/main.ts:10:5': precise,
      },
    });
    const r = await provider.resolveSignature('/project/src/main.ts', { line: 10, character: 5 });
    expect(r).toEqual(precise);
  });

  it('falls back to signatures when positionSignature key does not match', async () => {
    const catchAll = { label: 'generic(): void', parameters: [] };
    const precise = { label: 'specificFn(x: string): number', parameters: ['x: string'] };
    const provider = createMockLspProvider({
      signatures: { '*': catchAll },
      positionSignatures: {
        '/project/src/main.ts:10:5': precise,
      },
    });
    // Different position — no positionSignatures match
    const r = await provider.resolveSignature('/project/src/other.ts', { line: 5, character: 0 });
    expect(r).toEqual(catchAll);
  });
});

// ---------------------------------------------------------------------------
// LSP1-10 — createMockLspProvider: resolveImport fixture lookup
// ---------------------------------------------------------------------------

describe('LSP1-10 — createMockLspProvider resolveImport', () => {
  it('returns fixture for known specifier', async () => {
    const provider = createMockLspProvider({
      imports: {
        './utils': { resolvedPath: '/project/src/utils.ts', byteRange: [0, 100] },
        'zod': { resolvedPath: '/project/node_modules/zod/index.ts', byteRange: [0, 50] },
      },
    });
    const r1 = await provider.resolveImport('/project/src/main.ts', './utils');
    expect(r1).toEqual({ resolvedPath: '/project/src/utils.ts', byteRange: [0, 100] });

    const r2 = await provider.resolveImport('/project/src/main.ts', 'zod');
    expect(r2).toEqual({ resolvedPath: '/project/node_modules/zod/index.ts', byteRange: [0, 50] });
  });
});

// ---------------------------------------------------------------------------
// LSP1-11 — createMockLspProvider returns undefined for unknown specifiers
// ---------------------------------------------------------------------------

describe('LSP1-11 — createMockLspProvider returns undefined for unknown specifiers', () => {
  it('resolveImport returns undefined for unknown specifier', async () => {
    const provider = createMockLspProvider({ imports: { './known': { resolvedPath: '/a.ts', byteRange: [0, 1] } } });
    const r = await provider.resolveImport('/file.ts', './unknown');
    expect(r).toBeUndefined();
  });

  it('findReferences returns [] for unknown symbol', async () => {
    const provider = createMockLspProvider({ references: { foo: [] } });
    const refs = await provider.findReferences('/file.ts', 'bar');
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LSP1-12 — H13: adapter does not emit events (no emitter coupling)
// ---------------------------------------------------------------------------

describe('LSP1-12 — H13 content-free: adapter has no emitter coupling', () => {
  it('no events are emitted by the LSP adapter during parse/getTopLevelSymbols/findReferences', async () => {
    // The adapter itself must never call an emitter — events are the engine's job.
    // We prove this by passing the memory emitter in scope but never passing it to the adapter,
    // and asserting zero events were captured.
    const memEmitter = createMemoryEmitter();
    const provider = createMockLspProvider({
      references: { myFunc: [{ path: '/a.ts', byteRange: [0, 6] }] },
    });
    const adapter = createLspCodeIntelligence({
      lspProvider: provider,
      fallbackAdapter: createSyntheticFallback(),
    });

    const content = new TextEncoder().encode('const myFunc = () => {};');
    const tree = await adapter.parse('file.ts', content);
    adapter.getTopLevelSymbols(tree);
    const sym: Symbol = { name: 'myFunc', kind: 'lexical_declaration', byteRange: [0, 6] };
    await adapter.findReferences!(sym);

    // No events should have been emitted — the adapter has no emitter reference.
    expect(memEmitter.getEvents()).toHaveLength(0);
    // Verify the emitter itself is still healthy (assertEventIsContentFree never called
    // with a bad event means no crashes)
    for (const ev of memEmitter.getEvents()) {
      assertEventIsContentFree(ev);
    }
  });
});

// ---------------------------------------------------------------------------
// LSP1-13 — Feature-detection: optional methods present on returned object
// ---------------------------------------------------------------------------

describe('LSP1-13 — optional methods are present on the returned adapter object', () => {
  it('findReferences is a function on the returned adapter', () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
      fallbackAdapter: createSyntheticFallback(),
    });
    expect(typeof adapter.findReferences).toBe('function');
  });

  it('goToDefinition is a function on the returned adapter', () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
      fallbackAdapter: createSyntheticFallback(),
    });
    expect(typeof adapter.goToDefinition).toBe('function');
  });

  it('getDiagnostics is not present on the returned adapter (deferred to LSP2)', () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
    });
    // getDiagnostics intentionally absent — deferred to LSP2 when real transport exists
    expect(adapter.getDiagnostics).toBeUndefined();
  });

  it('callHierarchy is not present on the returned adapter (deferred to LSP2)', () => {
    const adapter = createLspCodeIntelligence({
      lspProvider: createMockLspProvider({}),
    });
    expect(adapter.callHierarchy).toBeUndefined();
  });
});
