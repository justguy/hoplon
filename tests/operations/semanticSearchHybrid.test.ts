import { describe, expect, it } from 'vitest';

import type { LexicalIndexAdapter } from '../../src/hoplon/adapters/lexicalIndex.js';
import type { VectorIndexAdapter } from '../../src/hoplon/adapters/vectorIndex.js';
import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createNoopLexicalIndex } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore } from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';
import {
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';

function makeDeps(overrides: Partial<SemanticSearchDeps>): SemanticSearchDeps {
  return {
    embedding: createHashingTextEmbedding({ dimensions: 8 }),
    vectorStore: createNoopVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: createNoopSemanticIndexStore(),
    lexicalIndex: createNoopLexicalIndex(),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter: createMemoryEmitter(),
    engineId: 'test-semantic-hybrid',
    embeddingProvided: true,
    vectorStoreProvided: false,
    ...overrides,
  };
}

function emptyLexicalResult() {
  return { status: 'AVAILABLE' as const, resultCount: 0, matches: [], degradationReasons: [] };
}

describe('semanticSearch — hybrid advisory ranking', () => {
  it('orders hybrid matches by semantic score before source tie-breakers', async () => {
    const lexicalIndex: LexicalIndexAdapter = {
      async upsert() {
        return emptyLexicalResult();
      },
      async search(_projectId, _query, topK) {
        return {
          status: 'AVAILABLE',
          resultCount: 2,
          matches: [
            { id: 'lexical-only', score: 0.99, metadata: { projectId: 'proj-a' } },
            { id: 'shared', score: 0.01, metadata: { projectId: 'proj-a' } },
          ].slice(0, topK),
          degradationReasons: [],
        };
      },
      async delete() {
        return emptyLexicalResult();
      },
    };
    const vectorIndex: VectorIndexAdapter = {
      async upsert() {
        return emptyLexicalResult();
      },
      async search(_projectId, _query, topK) {
        return {
          status: 'AVAILABLE',
          resultCount: 2,
          matches: [
            { id: 'shared', score: 0.01, metadata: { projectId: 'proj-a' } },
            { id: 'vector-only', score: 0.99, metadata: { projectId: 'proj-a' } },
          ].slice(0, topK),
          degradationReasons: [],
        };
      },
      async delete() {
        return emptyLexicalResult();
      },
    };
    const deps = makeDeps({
      lexicalIndex,
      lexicalIndexProvided: true,
      vectorIndex,
      vectorIndexProvided: true,
    });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-rrf',
      projectId: 'proj-a',
      query: 'shared ranking query',
      topK: 3,
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.degradationReasons).toEqual([]);
    expect(result.matches.map((m) => m.id)).toEqual([
      'lexical-only',
      'vector-only',
      'shared',
    ]);
    expect(result.matches[0]?.score).toBeCloseTo(0.99, 8);
    expect(result.matches[1]?.score).toBeCloseTo(0.99, 8);
    expect(result.matches[0]?.rankSource).toBe('baseline_lexical');
    expect(result.matches.every((m) => m.source === 'baseline')).toBe(true);
  });

  it('reports filtered unauthorized rows without leaking them into results', async () => {
    const rogueStore = {
      async upsert() {},
      async search(_query: number[], topK: number) {
        return [
          { id: 'same-project', score: 0.9, metadata: { projectId: 'proj-a' } },
          { id: 'other-project', score: 0.95, metadata: { projectId: 'proj-b' } },
        ].slice(0, topK);
      },
      async delete() {},
    };
    const deps = makeDeps({
      vectorStore: rogueStore,
      vectorStoreProvided: true,
    });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-rogue-hybrid',
      projectId: 'proj-a',
      query: 'anything',
      topK: 5,
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.matches.map((m) => m.id)).toEqual(['same-project']);
    expect(result.degradationReasons).toContain('unauthorized_rows_filtered');
  });

  it('honours allowDegraded=false by withholding lexical-only degraded matches', async () => {
    const lexicalIndex: LexicalIndexAdapter = {
      async upsert() {
        return emptyLexicalResult();
      },
      async search() {
        return {
          status: 'AVAILABLE',
          resultCount: 1,
          matches: [{ id: 'lexical-hit', score: 1, metadata: { projectId: 'proj-a' } }],
          degradationReasons: [],
        };
      },
      async delete() {
        return emptyLexicalResult();
      },
    };
    const deps = makeDeps({
      lexicalIndex,
      lexicalIndexProvided: true,
    });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-no-degraded',
      projectId: 'proj-a',
      query: 'lexical query',
      topK: 1,
      allowDegraded: false,
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerAvailable).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.degradationReasons).toEqual(['lexical_only_profile']);
  });
});
