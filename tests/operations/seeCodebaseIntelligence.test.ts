/**
 * tests/operations/seeCodebaseIntelligence.test.ts — AIC-2 read intelligence.
 */

import { describe, expect, it, vi } from 'vitest';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import {
  ReadSemanticSearchPayloadSchema,
  ReadStructuralCompressionPayloadSchema,
} from '../../src/hoplon/contracts/seeCodebaseIntelligence.js';
import { SeeCodebaseEnvelopeSchema } from '../../src/hoplon/contracts/seeCodebase.js';
import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';

type SemanticSearchFn = NonNullable<SeeCodebaseDeps['semanticSearch']>;

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-aic-2',
    runId: 'run-aic-2',
    correlationId: 'corr-aic-2',
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
      slices: [{
        path: 'src/svc.ts',
        byteRange: [0, 20],
        nodeKinds: ['function_declaration'],
        content: 'secret body should stay out of sidecar',
      }],
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

function requireSidecar(
  env: Awaited<ReturnType<typeof seeCodebase>>,
  sidecarKind: string,
) {
  if (!env.ok) throw new Error('expected ok envelope');
  const sidecar = env.intelligence?.find((entry) => entry.sidecarKind === sidecarKind);
  expect(sidecar).toBeDefined();
  return sidecar;
}

describe('seeCodebase advisory intelligence', () => {
  it('adds structural compression and available semantic ranked matches', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockImplementation(
      async (req) => ({
        correlationId: req.correlationId,
        projectId: req.projectId,
        advisory: true as const,
        status: 'AVAILABLE' as const,
        providerStatus: 'AVAILABLE' as const,
        providerAvailable: true,
        resultCount: 2,
        freshness: 'indexed' as const,
        degradationReasons: [],
        topK: req.topK,
        matches: [
          {
            id: 'src/twin.ts#createFooTwin',
            score: 0.91,
            metadata: {
              projectId: req.projectId,
              path: 'src/twin.ts',
              symbol: 'createFooTwin',
            },
          },
          {
            id: 'src/near.ts#createFooNear',
            score: 0.73,
            metadata: {
              projectId: req.projectId,
              path: 'src/near.ts',
              symbol: 'createFooNear',
            },
          },
        ],
      }),
    );
    const env = await seeCodebase(makeDeps({ semanticSearch }), makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
      advisoryIntelligence: { semanticTopK: 2 },
    }));

    expect(env.ok).toBe(true);
    expect(() => SeeCodebaseEnvelopeSchema.parse(env)).not.toThrow();
    const structural = requireSidecar(env, 'read_structural_compression');
    const structuralPayload = ReadStructuralCompressionPayloadSchema.parse(
      structural?.payload,
    );
    expect(structural?.provider.status).toBe('available');
    expect(structural?.evidence.status).toBe('AVAILABLE');
    expect(structuralPayload.rawContentIncluded).toBe(false);
    expect(structuralPayload.entries[0]?.astNodeIdentities[0]).toMatchObject({
      path: 'src/svc.ts',
      name: 'createFoo',
      byteRange: [10, 19],
    });
    expect(JSON.stringify(structuralPayload)).not.toContain('secret body');

    const semantic = requireSidecar(env, 'read_semantic_search');
    const semanticPayload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('available');
    expect(semantic?.evidence.status).toBe('AVAILABLE');
    expect(semanticPayload.topK).toBe(2);
    expect(semanticPayload.queries[0]?.rankedMatches.map((m) => m.rank)).toEqual([1, 2]);
    expect(semanticPayload.semanticTwins[0]?.sourceAstNode.name).toBe('createFoo');
    expect(semanticPayload.semanticTwins[0]?.advisoryOnly).toBe(true);
    expect(semantic?.authority.canChangeDeterministicVerdict).toBe(false);
    expect(semantic?.strictAgentAccess.exposesVectorTool).toBe(false);
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'createFoo', topK: 2 }),
      undefined,
    );
  });

  it('reports semantic provider unavailable on the default path', async () => {
    const env = await seeCodebase(makeDeps(), makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
    }));

    expect(env.ok).toBe(true);
    const semantic = requireSidecar(env, 'read_semantic_search');
    const payload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('unavailable');
    expect(semantic?.provider.reason).toBe('semantic_search_provider_not_bound');
    expect(semantic?.evidence.status).toBe('UNAVAILABLE');
    expect(payload.topK).toBeNull();
    expect(payload.semanticTwins).toEqual([]);
  });

  it('degrades without issuing semantic search when topK is not requested', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockRejectedValue(
      new Error('semantic search should not run'),
    );
    const env = await seeCodebase(makeDeps({ semanticSearch }), makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
    }));

    expect(env.ok).toBe(true);
    const semantic = requireSidecar(env, 'read_semantic_search');
    const payload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('degraded');
    expect(semantic?.provider.reason).toBe('semantic_top_k_not_requested');
    expect(semantic?.evidence.status).toBe('NO_VERDICT');
    expect(payload.queries[0]?.resultStatus).toBe('NOT_REQUESTED');
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('marks successful semantic search with no matches as EMPTY evidence', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockImplementation(
      async (req) => ({
        correlationId: req.correlationId,
        projectId: req.projectId,
        advisory: true as const,
        status: 'EMPTY' as const,
        providerStatus: 'EMPTY' as const,
        providerAvailable: true,
        resultCount: 0,
        freshness: 'indexed' as const,
        degradationReasons: [],
        topK: req.topK,
        matches: [],
      }),
    );
    const env = await seeCodebase(makeDeps({ semanticSearch }), makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
      advisoryIntelligence: { semanticTopK: 2 },
    }));

    expect(env.ok).toBe(true);
    const semantic = requireSidecar(env, 'read_semantic_search');
    const payload = ReadSemanticSearchPayloadSchema.parse(semantic?.payload);
    expect(semantic?.provider.status).toBe('available');
    expect(semantic?.evidence.status).toBe('EMPTY');
    expect(payload.semanticTwins).toEqual([]);
  });

  it('keeps strict structural fallback blocked without intelligence sidecars', async () => {
    const semanticSearch = vi.fn<SemanticSearchFn>().mockRejectedValue(
      new Error('semantic search should not run'),
    );
    const env = await seeCodebase(makeDeps({ semanticSearch }), makeReq({
      intent: 'understand_code_shape',
      mode: 'structural',
      strict: true,
      targets: [{ kind: 'file', path: 'README.md' }],
    }));

    expect(env.ok).toBe(false);
    expect(() => SeeCodebaseEnvelopeSchema.parse(env)).not.toThrow();
    if (env.ok) throw new Error('expected error envelope');
    expect(env.error.kind).toBe('STRICT_BLOCKED_FALLBACK');
    expect('intelligence' in env).toBe(false);
    expect(semanticSearch).not.toHaveBeenCalled();
  });
});
