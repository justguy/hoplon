import { describe, expect, it } from 'vitest';

import type { EmbeddingCacheAdapter } from '../../src/hoplon/adapters/embeddingCache.js';
import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createNoopLexicalIndex } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore } from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createInMemoryVectorStore } from '../../src/hoplon/adapters/vectorStore/inMemory.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import {
  indexSemanticCorpus,
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';

describe('semanticSearch sem-search-005 freshness and cache semantics', () => {
  it('uses project-scoped persistent cache writes only for verified profiles', async () => {
    const puts: string[] = [];
    const deps = makeDeps({
      embeddingCache: createRecordingCache(puts),
      embeddingCacheProvided: true,
    });

    const result = await indexSemanticCorpus(deps, {
      correlationId: 'corr-cache-write',
      projectId: 'project-a',
      cache: { persistence: 'write_through' },
      documents: [
        {
          id: 'doc-1',
          text: 'cache freshness vector',
          documentTextHash: 'sha256:text',
          embeddingProfileHash: 'sha256:profile',
          embeddingProfileVerified: true,
        },
      ],
    });

    expect(result.cacheMissCount).toBe(1);
    expect(result.cacheWriteCount).toBe(1);
    expect(puts).toEqual(['project:project-a|profile:sha256:profile|text:sha256:text']);
  });

  it('does not persist dry-run cache misses or unverified embedding profiles', async () => {
    const puts: string[] = [];
    const deps = makeDeps({
      embeddingCache: createRecordingCache(puts),
      embeddingCacheProvided: true,
    });

    const result = await indexSemanticCorpus(deps, {
      correlationId: 'corr-cache-dry',
      projectId: 'project-a',
      dryRun: true,
      cache: { persistence: 'write_through' },
      documents: [
        {
          id: 'doc-1',
          text: 'cache freshness vector',
          documentTextHash: 'sha256:text',
          embeddingProfileHash: 'sha256:profile',
          embeddingProfileVerified: false,
        },
      ],
    });

    expect(result.cacheWriteCount).toBe(0);
    expect(result.degradationReasons).toContain('embedding_profile_unverified');
    expect(puts).toEqual([]);
  });

  it('returns context mismatch before stale results when stale is not allowed', async () => {
    const result = await semanticSearch(makeDeps(), {
      correlationId: 'corr-context-mismatch',
      projectId: 'project-a',
      query: 'anything',
      topK: 5,
      indexedContext: {
        worktreeId: 'worktree-a',
        headOid: 'old',
        ignoreRulesHash: 'ignore-a',
      },
      currentContext: {
        worktreeId: 'worktree-b',
        headOid: 'old',
        ignoreRulesHash: 'ignore-a',
      },
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.freshness).toBe('stale');
    expect(result.degradationReasons).toEqual(['index_context_mismatch']);
    expect(result.matches).toEqual([]);
  });

  it('marks dirty-only ignore-rule changes as stale reconciliation work', async () => {
    const result = await indexSemanticCorpus(makeDeps(), {
      correlationId: 'corr-ignore-change',
      projectId: 'project-a',
      scope: 'dirty_files_only',
      ignoreRulesChanged: true,
      documents: [{ id: 'doc-1', text: 'anything' }],
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.freshness).toBe('stale');
    expect(result.indexedCount).toBe(0);
    expect(result.degradationReasons).toEqual([
      'ignore_rules_changed_full_reconcile_required',
    ]);
  });
});

function makeDeps(overrides: Partial<SemanticSearchDeps> = {}): SemanticSearchDeps {
  return {
    embedding: createHashingTextEmbedding({ dimensions: 8 }),
    vectorStore: createInMemoryVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: createNoopSemanticIndexStore(),
    lexicalIndex: createNoopLexicalIndex(),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter: createMemoryEmitter(),
    engineId: 'semantic-freshness-test',
    embeddingProvided: true,
    vectorStoreProvided: true,
    ...overrides,
  };
}

function createRecordingCache(puts: string[]): EmbeddingCacheAdapter {
  return {
    async get() {
      return { status: 'AVAILABLE', record: null, degradationReasons: [] };
    },
    async put(record) {
      puts.push(record.key);
      return { status: 'AVAILABLE', degradationReasons: [] };
    },
    async delete() {
      return { status: 'AVAILABLE', degradationReasons: [] };
    },
  };
}
