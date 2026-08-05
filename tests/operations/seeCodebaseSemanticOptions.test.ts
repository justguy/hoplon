import { describe, expect, it, vi } from 'vitest';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { ReadSemanticSearchPayloadSchema } from '../../src/hoplon/contracts/seeCodebaseIntelligence.js';
import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';

type SemanticSearchFn = NonNullable<SeeCodebaseDeps['semanticSearch']>;

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-semantic-options',
    runId: 'run-semantic-options',
    correlationId: 'corr-semantic-options',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SeeCodebaseDeps> = {}): SeeCodebaseDeps {
  return {
    fs: createMemFsAdapter(),
    emitter: createMemoryEmitter(),
    engineId: 'test-engine',
    root: '/',
    config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 1000 },
    packContext: async (req) => ({
      metadata: {
        strategyVersion: 1,
        grammarVersion: 'test',
        packerVersion: 1,
        generatedAt: '2026-04-27T00:00:00.000Z',
        correlationId: req.correlationId,
      },
      slices: [{ path: 'src/svc.ts', byteRange: [0, 20], nodeKinds: ['function_declaration'] }],
      failures: [],
    }),
    extractStructuralTemplate: async () => ({
      files: [],
      queryId: 'structural-template',
      snapshotRef: null,
    }),
    searchSymbols: async () => ({
      matches: [{
        path: 'src/svc.ts',
        name: 'createFoo',
        kind: 'function',
        byteRange: [10, 19],
        nodeKind: 'identifier',
      }],
      failures: [],
      filesScanned: 1,
      truncated: false,
    }),
    describeProject: async () => ({
      files: { total: 0, byLanguage: [] },
      symbols: { exports: 0, imports: 0, types: 0, functions: 0, classes: 0 },
      filesScanned: 0,
      truncated: false,
      failures: [],
    }),
    ...overrides,
  };
}

function requireSemanticSidecar(env: Awaited<ReturnType<typeof seeCodebase>>) {
  if (!env.ok) throw new Error('expected ok envelope');
  const sidecar = env.intelligence?.find((entry) => entry.sidecarKind === 'read_semantic_search');
  expect(sidecar).toBeDefined();
  return sidecar;
}

describe('seeCodebase semantic advisory options', () => {
  it('passes nested semantic options and preserves rank provenance', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockImplementation(
      async (req) => ({
        correlationId: req.correlationId,
        projectId: req.projectId,
        advisory: true as const,
        status: 'DEGRADED' as const,
        providerStatus: 'DEGRADED' as const,
        providerAvailable: true,
        resultCount: 1,
        freshness: 'stale' as const,
        degradationReasons: ['index_stale'] as const,
        topK: req.topK,
        matches: [{
          id: 'src/semantic.ts#createFooSemantic',
          score: 0.0325,
          source: 'baseline' as const,
          rankSource: 'baseline_vector' as const,
          freshness: 'stale' as const,
          metadata: {
            projectId: req.projectId,
            path: 'src/semantic.ts',
            symbol: 'createFooSemantic',
          },
        }],
      }),
    );
    const env = await seeCodebase(makeDeps({ semanticSearch }), makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
      advisoryIntelligence: {
        semanticSearch: {
          enabled: true,
          topK: 3,
          sessionId: 'session-a',
          freshness: 'indexed',
          allowDegraded: true,
          allowStale: true,
          resultFields: 'path_and_symbol',
        },
      },
    }));

    expect(env.ok).toBe(true);
    const semantic = requireSemanticSidecar(env);
    const payload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('degraded');
    expect(semantic?.evidence.status).toBe('DEGRADED');
    expect(payload.queries[0]).toMatchObject({
      resultStatus: 'DEGRADED',
      providerStatus: 'DEGRADED',
      freshness: 'stale',
      degradationReasons: ['index_stale'],
    });
    expect(payload.queries[0]?.rankedMatches[0]).toMatchObject({
      id: 'src/semantic.ts#createFooSemantic',
      source: 'baseline',
      rankSource: 'baseline_vector',
      freshness: 'stale',
    });
    expect(semantic?.authority.canChangeDeterministicVerdict).toBe(false);
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'createFoo',
        topK: 3,
        sessionId: 'session-a',
        freshness: 'indexed',
        allowDegraded: true,
        allowStale: true,
        resultFields: 'path_and_symbol',
      }),
      undefined,
    );
  });

  it('keeps inspect_logs_or_env semantic search disabled unless explicitly enabled', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockRejectedValue(
      new Error('semantic search should not run for logs by default'),
    );
    const fs = createMemFsAdapter();
    await fs.write('logs/app.log', new Uint8Array([111, 107]));
    const env = await seeCodebase(makeDeps({ fs, semanticSearch }), makeReq({
      intent: 'inspect_logs_or_env',
      mode: 'raw',
      targets: [{ kind: 'file', path: 'logs/app.log' }],
      advisoryIntelligence: { semanticTopK: 2 },
    }));

    expect(env.ok).toBe(true);
    const semantic = requireSemanticSidecar(env);
    const payload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('degraded');
    expect(semantic?.provider.reason).toBe('semantic_search_disabled_for_intent');
    expect(semantic?.evidence.status).toBe('NO_VERDICT');
    expect(payload.semanticTwins).toEqual([]);
    expect(semanticSearch).not.toHaveBeenCalled();
  });
});
