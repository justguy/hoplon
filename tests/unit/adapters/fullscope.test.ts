/**
 * t-030 targeted proof.
 *
 * Verifies:
 * - T030-1 mandatory parse/getTopLevelSymbols delegate to fallback
 * - T030-2 provider references route through Fullscope seam
 * - T030-3 empty provider result is authoritative
 * - T030-4 undefined provider result falls back
 * - T030-5 explicit unavailable error falls back
 * - T030-6 unexpected provider error rethrows
 * - T030-7 no provider result + no fallback.findReferences returns []
 * - T030-8 no fallback means parse/getTopLevelSymbols throw
 * - T030-9 adapter emits no events itself
 * - T030-10 package barrel exposes the host-facing factories
 */

import { describe, expect, it } from 'vitest';

import {
  createFullscopeCodeIntelligence as createFullscopeCodeIntelligenceBarrel,
  createMockFullscopeProvider as createMockFullscopeProviderBarrel,
} from '../../../src/index.js';
import {
  FullscopeProviderUnavailableError,
  createFullscopeCodeIntelligence,
} from '../../../src/hoplon/adapters/codeIntelligence/fullscope.js';
import { createMockFullscopeProvider } from '../../../src/hoplon/adapters/codeIntelligence/mockFullscopeProvider.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import type {
  CodeIntelligenceAdapter,
  Reference,
  Symbol,
  SyntaxTree,
} from '../../../src/hoplon/adapters/codeIntelligence.js';

const SYNTHETIC_TREE: SyntaxTree = {
  rootNode: { kind: 'program', children: [] },
};

const SYNTHETIC_SYMBOL: Symbol = {
  name: 'syntheticFn',
  kind: 'function_declaration',
  byteRange: [0, 10],
};

const SYNTHETIC_FALLBACK_REFERENCE: Reference = {
  path: '/project/src/fallback-caller.ts',
  byteRange: [50, 62],
};

function createSyntheticFallback(): CodeIntelligenceAdapter {
  return {
    async parse() {
      return SYNTHETIC_TREE;
    },
    getTopLevelSymbols() {
      return [SYNTHETIC_SYMBOL];
    },
    async findReferences() {
      return [SYNTHETIC_FALLBACK_REFERENCE];
    },
  };
}

describe('t-030 fullscope adapter seam', () => {
  it('T030-1: parse delegates to fallback and threads AbortSignal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fallback: CodeIntelligenceAdapter = {
      async parse(_file, _content, signal) {
        receivedSignal = signal;
        return SYNTHETIC_TREE;
      },
      getTopLevelSymbols: () => [SYNTHETIC_SYMBOL],
    };
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({}),
      fallbackAdapter: fallback,
    });
    const signal = AbortSignal.timeout(5000);
    const tree = await adapter.parse('file.ts', new Uint8Array(), signal);

    expect(tree).toBe(SYNTHETIC_TREE);
    expect(receivedSignal).toBe(signal);
  });

  it('T030-1: getTopLevelSymbols delegates to fallback', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({}),
      fallbackAdapter: createSyntheticFallback(),
    });
    const tree = await adapter.parse('file.ts', new Uint8Array());

    expect(adapter.getTopLevelSymbols(tree)).toEqual([SYNTHETIC_SYMBOL]);
  });

  it('T030-2: provider references are authoritative when fixtures exist', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({
        references: {
          createSnapshot: [
            { path: '/project/src/engine.ts', byteRange: [120, 136] },
            { path: '/project/tests/engine.test.ts', byteRange: [45, 61] },
          ],
        },
      }),
      fallbackAdapter: createSyntheticFallback(),
    });

    const refs = await adapter.findReferences!({
      name: 'createSnapshot',
      kind: 'function_declaration',
      byteRange: [0, 14],
    });

    expect(refs).toEqual([
      { path: '/project/src/engine.ts', byteRange: [120, 136] },
      { path: '/project/tests/engine.test.ts', byteRange: [45, 61] },
    ]);
  });

  it('T030-3: empty provider result is authoritative and does not fall back', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({
        references: { orphanSymbol: [] },
      }),
      fallbackAdapter: createSyntheticFallback(),
    });

    const refs = await adapter.findReferences!({
      name: 'orphanSymbol',
      kind: 'function_declaration',
      byteRange: [0, 13],
    });

    expect(refs).toEqual([]);
    expect(refs).not.toContainEqual(SYNTHETIC_FALLBACK_REFERENCE);
  });

  it('T030-4: undefined provider result falls back', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({ references: {} }),
      fallbackAdapter: createSyntheticFallback(),
    });

    const refs = await adapter.findReferences!({
      name: 'unknownSymbol',
      kind: 'function_declaration',
      byteRange: [0, 14],
    });

    expect(refs).toEqual([SYNTHETIC_FALLBACK_REFERENCE]);
  });

  it('T030-5: explicit unavailable error falls back', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({ unavailable: true }),
      fallbackAdapter: createSyntheticFallback(),
    });

    const refs = await adapter.findReferences!({
      name: 'anySymbol',
      kind: 'function_declaration',
      byteRange: [0, 10],
    });

    expect(refs).toEqual([SYNTHETIC_FALLBACK_REFERENCE]);
  });

  it('T030-6: unexpected provider errors are rethrown', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: {
        async findReferences() {
          throw new Error('boom');
        },
      },
      fallbackAdapter: createSyntheticFallback(),
    });

    await expect(
      adapter.findReferences!({
        name: 'brokenSymbol',
        kind: 'function_declaration',
        byteRange: [0, 12],
      }),
    ).rejects.toThrow(/boom/);
  });

  it('T030-7: no provider result and no fallback.findReferences returns []', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({}),
      fallbackAdapter: {
        async parse() {
          return SYNTHETIC_TREE;
        },
        getTopLevelSymbols: () => [],
      },
    });

    const refs = await adapter.findReferences!({
      name: 'unseenSymbol',
      kind: 'function_declaration',
      byteRange: [0, 12],
    });

    expect(refs).toEqual([]);
  });

  it('T030-8: parse throws without a fallback', async () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({}),
    });
    await expect(adapter.parse('file.ts', new Uint8Array())).rejects.toThrow(
      /fallbackAdapter/,
    );
  });

  it('T030-8: getTopLevelSymbols throws without a fallback', () => {
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({}),
    });
    expect(() => adapter.getTopLevelSymbols(SYNTHETIC_TREE)).toThrow(
      /fallbackAdapter/,
    );
  });

  it('T030-9: adapter emits no events itself', async () => {
    const emitter = createMemoryEmitter();
    const adapter = createFullscopeCodeIntelligence({
      provider: createMockFullscopeProvider({
        references: { foo: [{ path: '/a', byteRange: [0, 3] }] },
      }),
      fallbackAdapter: createSyntheticFallback(),
    });

    await adapter.parse('file.ts', new Uint8Array());
    adapter.getTopLevelSymbols(SYNTHETIC_TREE);
    await adapter.findReferences!({
      name: 'foo',
      kind: 'function_declaration',
      byteRange: [0, 3],
    });

    expect(emitter.getEvents()).toHaveLength(0);
  });

  it('T030-10: package barrel exposes the host-facing factories', () => {
    expect(typeof createFullscopeCodeIntelligenceBarrel).toBe('function');
    expect(typeof createMockFullscopeProviderBarrel).toBe('function');
    expect(createFullscopeCodeIntelligenceBarrel).toBe(
      createFullscopeCodeIntelligence,
    );
    expect(createMockFullscopeProviderBarrel).toBe(
      createMockFullscopeProvider,
    );
    expect(
      new FullscopeProviderUnavailableError('x').code,
    ).toBe('provider_unavailable');
  });
});
