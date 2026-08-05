/**
 * Compile-time interface assertions for CodeIntelligenceAdapter.
 *
 * There is no runtime Zod schema for CodeIntelligenceAdapter since it is an
 * interface (not a DTO). This test proves that the interface can be satisfied
 * by a concrete implementation with the correct method signatures, and that
 * the placeholder types are exported correctly.
 *
 * The test also proves that the optional Layer 2 methods (findReferences,
 * findDependencies, etc.) are truly optional — an adapter implementing only
 * parse + getTopLevelSymbols satisfies the interface.
 */

import { describe, it, expect } from 'vitest';
import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
  Symbol,
} from '../../src/hoplon/adapters/codeIntelligence.js';

// ---------------------------------------------------------------------------
// Minimal Phase 1 implementation satisfying the mandatory pair
// ---------------------------------------------------------------------------

const minimalAdapter: CodeIntelligenceAdapter = {
  async parse(_file: string, _content: Uint8Array): Promise<SyntaxTree> {
    return { rootNode: { kind: 'program', children: [] } };
  },
  getTopLevelSymbols(_tree: SyntaxTree): Symbol[] {
    return [];
  },
  // findReferences, findDependencies, getDiagnostics, goToDefinition, and
  // callHierarchy are optional
};

// ---------------------------------------------------------------------------
// Full LSP-style implementation with all optional methods
// ---------------------------------------------------------------------------

const fullAdapter: CodeIntelligenceAdapter = {
  async parse(_file: string, _content: Uint8Array): Promise<SyntaxTree> {
    return { rootNode: { kind: 'source_file', children: [] } };
  },
  getTopLevelSymbols(_tree: SyntaxTree): Symbol[] {
    return [{ name: 'MyClass', kind: 'class_declaration', byteRange: [0, 100] }];
  },
  async findReferences(_symbol: Symbol) {
    return [];
  },
  async findDependencies(_file: string) {
    return [];
  },
  async getDiagnostics(_file: string) {
    return [];
  },
  async goToDefinition(_symbol: Symbol) {
    return null;
  },
  async callHierarchy(_symbol: Symbol) {
    return {
      symbol: { name: 'foo', kind: 'function_declaration', byteRange: [0, 50] },
      callers: [],
      callees: [],
    };
  },
};

describe('CodeIntelligenceAdapter — interface compliance', () => {
  it('minimal adapter (mandatory methods only) compiles and runs', async () => {
    const tree = await minimalAdapter.parse('src/test.ts', new Uint8Array());
    expect(tree.rootNode.kind).toBe('program');
    const symbols = minimalAdapter.getTopLevelSymbols(tree);
    expect(Array.isArray(symbols)).toBe(true);
  });

  it('full adapter (all optional methods) compiles and runs', async () => {
    const tree = await fullAdapter.parse('src/test.ts', new Uint8Array());
    expect(tree.rootNode.kind).toBe('source_file');
    const symbols = fullAdapter.getTopLevelSymbols(tree);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('MyClass');
    await expect(fullAdapter.findDependencies?.('src/test.ts')).resolves.toEqual(
      [],
    );
  });

  it('optional methods are actually optional (no call throws on minimal adapter)', async () => {
    // Optional Layer 2 and diagnostics methods are absent on the minimal adapter.
    expect(minimalAdapter.findReferences).toBeUndefined();
    expect(minimalAdapter.findDependencies).toBeUndefined();
    expect(minimalAdapter.getDiagnostics).toBeUndefined();
    expect(minimalAdapter.goToDefinition).toBeUndefined();
    expect(minimalAdapter.callHierarchy).toBeUndefined();
  });

  it('SyntaxTree rootNode shape is correct placeholder', () => {
    const tree: SyntaxTree = { rootNode: { kind: 'program', children: [] } };
    expect(tree.rootNode.kind).toBe('program');
    expect(Array.isArray(tree.rootNode.children)).toBe(true);
  });

  it('Symbol shape is correct placeholder', () => {
    const sym: Symbol = { name: 'foo', kind: 'function_declaration', byteRange: [0, 100] };
    expect(sym.name).toBe('foo');
    expect(sym.byteRange).toHaveLength(2);
  });
});
