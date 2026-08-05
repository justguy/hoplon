/**
 * tests/operations/findReferencingSymbols.test.ts — t-118 advisory lookup proof.
 */

import { describe, expect, it } from 'vitest';

import {
  findReferencingSymbols,
  type FindReferencingSymbolsDeps,
} from '../../src/hoplon/operations/findReferencingSymbols.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type {
  CodeIntelligenceAdapter,
  Reference,
  Symbol as CiSymbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';

type FileMap = Record<string, Uint8Array>;
type SymbolMap = Record<string, CiSymbol[]>;

function makeFs(files: FileMap): HoplonFsAdapter {
  return {
    async read(path) { return files[path] ?? new Uint8Array(); },
    async write() {},
    async list() { return []; },
    async stat(path) {
      const content = files[path];
      return content
        ? { exists: true, isFile: true, size: content.byteLength }
        : { exists: false, isFile: false, size: 0 };
    },
    async mkdir() {},
    async remove() {},
  };
}

function makeCi(opts: {
  symbols: SymbolMap;
  references?: Reference[];
  omitFindReferences?: boolean;
  throwFindReferences?: boolean;
}): CodeIntelligenceAdapter {
  const base: CodeIntelligenceAdapter = {
    async parse(file): Promise<SyntaxTree> {
      return {
        rootNode: { kind: 'program', children: [] },
        symbols: opts.symbols[file] ?? [],
      } as SyntaxTree & { symbols: CiSymbol[] };
    },
    getTopLevelSymbols(tree) {
      return (tree as SyntaxTree & { symbols?: CiSymbol[] }).symbols ?? [];
    },
  };
  if (opts.omitFindReferences) return base;
  return {
    ...base,
    async findReferences() {
      if (opts.throwFindReferences) throw new Error('provider failed');
      return opts.references ?? [];
    },
  };
}

function deps(ci: CodeIntelligenceAdapter, files: FileMap): FindReferencingSymbolsDeps {
  return {
    fs: makeFs(files),
    codeIntelligence: ci,
    emitter: createMemoryEmitter(),
    engineId: 'engine-ref-test',
    root: '/',
    config: { maxFileBytes: 1024, parseTimeoutMs: 5000 },
  };
}

const request = {
  projectId: 'proj-ref',
  correlationId: 'corr-ref-1',
  target: {
    type: 'symbol_identity' as const,
    symbol: {
      name: 'alpha',
      kind: 'function',
      byteRange: [0, 5] as [number, number],
      path: 'src/a.ts',
    },
  },
};

describe('findReferencingSymbols', () => {
  it('returns reference files, locations, and containing symbols when provider is available', async () => {
    const files = {
      'src/use.ts': new TextEncoder().encode('function useAlpha() { alpha(); }'),
      'src/other.ts': new TextEncoder().encode('alpha();'),
    };
    const ci = makeCi({
      symbols: {
        'src/use.ts': [{ name: 'useAlpha', kind: 'function', byteRange: [0, 40] }],
        'src/other.ts': [{ name: 'tiny', kind: 'function', byteRange: [0, 3] }],
      },
      references: [
        { path: 'src/use.ts', byteRange: [22, 27] },
        { path: 'src/other.ts', byteRange: [4, 9] },
      ],
    });

    const result = await findReferencingSymbols(deps(ci, files), request);

    expect(result.advisory).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.providerStatus).toBe('available');
    expect(result.referenceCount).toBe(2);
    expect(result.files).toEqual(['src/other.ts', 'src/use.ts']);
    expect(result.references[0]?.containingSymbol?.name).toBe('useAlpha');
    expect(result.references[1]?.symbolResolution).toBe('no_enclosing_symbol');
  });

  it('returns UNAVAILABLE without fabricating references when findReferences is missing', async () => {
    const ci = makeCi({ symbols: {}, omitFindReferences: true });
    const result = await findReferencingSymbols(deps(ci, {}), request);

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerStatus).toBe('unavailable');
    expect(result.references).toEqual([]);
    expect(result.targetResolution.status).toBe('resolved');
  });

  it('resolves symbol_query targets and reports ambiguous or unresolved targets', async () => {
    const files = { 'src/a.ts': new TextEncoder().encode('export {}') };
    const ci = makeCi({
      symbols: {
        'src/a.ts': [
          { name: 'alpha', kind: 'function', byteRange: [0, 5] },
          { name: 'alpha', kind: 'function', byteRange: [10, 15] },
        ],
      },
      references: [],
    });
    const ambiguous = await findReferencingSymbols(deps(ci, files), {
      projectId: 'proj-ref',
      correlationId: 'corr-ref-2',
      target: { type: 'symbol_query', path: 'src/a.ts', name: 'alpha' },
    });
    expect(ambiguous.status).toBe('AMBIGUOUS_TARGET');
    expect(ambiguous.targetResolution.candidates).toHaveLength(2);

    const unresolved = await findReferencingSymbols(deps(ci, files), {
      projectId: 'proj-ref',
      correlationId: 'corr-ref-3',
      target: { type: 'symbol_query', path: 'src/a.ts', name: 'missing' },
    });
    expect(unresolved.status).toBe('UNRESOLVED_TARGET');
    expect(unresolved.targetResolution.reason).toBe('no_matching_symbol');
  });

  it('returns PROVIDER_ERROR on findReferences failure without throwing', async () => {
    const ci = makeCi({ symbols: {}, throwFindReferences: true });
    const result = await findReferencingSymbols(deps(ci, {}), request);

    expect(result.status).toBe('PROVIDER_ERROR');
    expect(result.providerStatus).toBe('error');
    expect(result.providerError?.kind).toBe('find_references_failed');
    expect(result.references).toEqual([]);
  });
});
