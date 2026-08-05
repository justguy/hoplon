import { describe, expect, it } from 'vitest';

import {
  ScipIndexNotFoundError,
  ScipIndexStaleError,
  createScipCodeIntelligence,
  createScipProvider,
  type ScipReadFile,
  type ScipSnapshot,
} from '../src/index.js';
import type {
  CodeIntelligenceAdapterLike,
  HoplonSyntaxTree,
  HoplonSymbol,
} from '../src/hoplonSeam.js';

const VALID_SNAPSHOT: ScipSnapshot = {
  snapshotSchemaVersion: 1,
  metadata: {
    schemaVersion: 1,
    providerVersion: 'scip-test-provider',
    workspaceRevision: 'rev-1',
    generatedAt: '2026-04-18T00:00:00Z',
  },
  documents: [
    {
      path: '/proj/src/createSession.ts',
      dependencies: ['/proj/src/contracts.ts', '/proj/src/utils.ts'],
      occurrences: [
        { symbol: 'createSession', role: 'definition', byteRange: [0, 13] },
      ],
    },
    {
      path: '/proj/src/api.ts',
      dependencies: ['/proj/src/createSession.ts'],
      occurrences: [
        { symbol: 'createSession', role: 'reference', byteRange: [24, 37] },
      ],
    },
    {
      path: '/proj/tests/createSession.test.ts',
      dependencies: ['/proj/src/createSession.ts'],
      occurrences: [
        { symbol: 'createSession', role: 'reference', byteRange: [18, 31] },
      ],
    },
  ],
};

function readSnapshot(
  snapshot: ScipSnapshot,
): ScipReadFile {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  return async () => bytes;
}

function createSyntheticFallback(): CodeIntelligenceAdapterLike {
  const tree: HoplonSyntaxTree = {
    rootNode: { kind: 'program', children: [] },
  };
  const symbol: HoplonSymbol = {
    name: 'syntheticFn',
    kind: 'function_declaration',
    byteRange: [0, 10],
  };
  return {
    async parse() {
      return tree;
    },
    getTopLevelSymbols() {
      return [symbol];
    },
  };
}

describe('@phalanx/hoplon-code-intelligence-scip', () => {
  it('returns ready state plus references/dependencies from an offline snapshot', async () => {
    const provider = createScipProvider({
      indexPath: '/tmp/index.scip.json',
      workspaceRevision: 'rev-1',
      readFile: readSnapshot(VALID_SNAPSHOT),
    });

    await expect(provider.getIndexState()).resolves.toMatchObject({
      status: 'ready',
      metadata: { workspaceRevision: 'rev-1' },
    });
    await expect(
      provider.findReferences('/proj/src/createSession.ts', 'createSession'),
    ).resolves.toEqual([
      { path: '/proj/src/api.ts', byteRange: [24, 37] },
      { path: '/proj/tests/createSession.test.ts', byteRange: [18, 31] },
    ]);
    await expect(
      provider.findDependencies('/proj/src/createSession.ts'),
    ).resolves.toEqual([
      '/proj/src/contracts.ts',
      '/proj/src/utils.ts',
    ]);
  });

  it('surfaces missing index files explicitly', async () => {
    const provider = createScipProvider({
      indexPath: '/tmp/missing.scip.json',
      readFile: async () => {
        const error = new Error('missing') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      },
    });

    await expect(provider.getIndexState()).rejects.toBeInstanceOf(
      ScipIndexNotFoundError,
    );
  });

  it('surfaces stale workspace revisions explicitly', async () => {
    const provider = createScipProvider({
      indexPath: '/tmp/stale.scip.json',
      workspaceRevision: 'rev-2',
      readFile: readSnapshot(VALID_SNAPSHOT),
    });

    await expect(provider.getIndexState()).resolves.toMatchObject({
      status: 'stale',
      expectedWorkspaceRevision: 'rev-2',
    });
    await expect(
      provider.findReferences('/proj/src/createSession.ts', 'createSession'),
    ).rejects.toBeInstanceOf(ScipIndexStaleError);
  });

  it('delegates parse/getTopLevelSymbols to fallback and answers Layer 2 queries', async () => {
    const adapter = createScipCodeIntelligence({
      provider: createScipProvider({
        indexPath: '/tmp/index.scip.json',
        workspaceRevision: 'rev-1',
        readFile: readSnapshot(VALID_SNAPSHOT),
      }),
      fallbackAdapter: createSyntheticFallback(),
    });

    const tree = await adapter.parse('/proj/src/createSession.ts', new Uint8Array());
    expect(adapter.getTopLevelSymbols(tree)[0]?.name).toBe('syntheticFn');
    await expect(
      adapter.findReferences?.({
        name: 'createSession',
        kind: 'function_declaration',
        byteRange: [0, 13],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      adapter.findDependencies?.('/proj/src/createSession.ts'),
    ).resolves.toEqual([
      '/proj/src/contracts.ts',
      '/proj/src/utils.ts',
    ]);
  });
});
