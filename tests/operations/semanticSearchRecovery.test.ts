import { describe, expect, it } from 'vitest';

import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbedding } from '../../src/hoplon/adapters/embedding.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createNoopLexicalIndex } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore } from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';
import { createInMemoryVectorStore } from '../../src/hoplon/adapters/vectorStore/inMemory.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import {
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';

function liveDeps(): SemanticSearchDeps & {
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  return {
    embedding: createHashingTextEmbedding({ dimensions: 32 }),
    vectorStore: createInMemoryVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: createNoopSemanticIndexStore(),
    lexicalIndex: createNoopLexicalIndex(),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter,
    engineId: 'semantic-recovery-test',
    embeddingProvided: true,
    vectorStoreProvided: true,
  };
}

function unavailableDeps(): SemanticSearchDeps {
  return {
    embedding: createNoopEmbedding(),
    vectorStore: createNoopVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: createNoopSemanticIndexStore(),
    lexicalIndex: createNoopLexicalIndex(),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter: createMemoryEmitter(),
    engineId: 'semantic-recovery-test',
    embeddingProvided: false,
    vectorStoreProvided: false,
  };
}

describe('semanticSearch advisory recovery', () => {
  it('does not silently fall back when live_session has no session overlay', async () => {
    const deps = liveDeps();
    const result = await semanticSearch(deps, {
      correlationId: 'corr-live-missing',
      projectId: 'proj-a',
      query: 'overlay-only query',
      topK: 3,
      freshness: 'live_session',
    });

    expect(result.advisory).toBe(true);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerStatus).toBe('AVAILABLE');
    expect(result.providerAvailable).toBe(true);
    expect(result.freshness).toBe('unavailable');
    expect(result.degradationReasons).toEqual(['overlay_never_created']);
    expect(result.matches).toEqual([]);
    expect(result.suggestions?.map((s) => s.kind)).toEqual([
      'live_session_overlay_missing',
      'indexed_search',
    ]);
    expect(
      deps.emitter
        .getEvents()
        .filter((event) => event.op === 'semanticSearch')
        .map((event) => event.phase),
    ).toEqual(['start', 'end']);
  });

  it('returns degraded live-session recovery only when explicitly allowed', async () => {
    const result = await semanticSearch(liveDeps(), {
      correlationId: 'corr-live-degraded',
      projectId: 'proj-a',
      query: 'overlay-only query',
      topK: 3,
      freshness: 'live_session',
      sessionId: 'sess-1',
      allowDegraded: true,
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.providerStatus).toBe('AVAILABLE');
    expect(result.degradationReasons).toEqual([
      'overlay_unavailable_process_local_store',
    ]);
    expect(result.suggestions?.[0]?.message).toContain('refresh_semantic_overlay');
    expect(result.suggestions?.[0]?.message).toContain('sessionId');
  });

  it('treats session_overlay_only as live-session recovery without indexed fallback', async () => {
    const result = await semanticSearch(liveDeps(), {
      correlationId: 'corr-overlay-scope-only',
      projectId: 'proj-a',
      query: 'overlay-only query',
      topK: 3,
      overlayScope: 'session_overlay_only',
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerStatus).toBe('AVAILABLE');
    expect(result.providerAvailable).toBe(true);
    expect(result.freshness).toBe('unavailable');
    expect(result.degradationReasons).toEqual(['overlay_never_created']);
    expect(result.matches).toEqual([]);
    expect(result.suggestions?.map((s) => s.kind)).toEqual([
      'live_session_overlay_missing',
      'indexed_search',
    ]);
  });

  it('makes indexed provider and corpus recovery actionable without indexing', async () => {
    const result = await semanticSearch(unavailableDeps(), {
      correlationId: 'corr-indexed-missing',
      projectId: 'registered-project',
      query: 'indexed query',
      topK: 5,
      freshness: 'indexed',
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerAvailable).toBe(false);
    expect(result.freshness).toBe('unavailable');
    expect(result.degradationReasons).toEqual([
      'provider_not_bound',
      'no_indexed_corpus',
    ]);
    expect(result.suggestions?.map((s) => s.kind)).toEqual([
      'provider_binding',
      'no_indexed_corpus',
      'corpus_indexing',
    ]);
  });
});
