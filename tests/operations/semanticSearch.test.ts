/**
 * tests/operations/semanticSearch.test.ts — t-034 targeted proof.
 *
 * Proves the first real Layer 1 retrieval path over the shipped embedding +
 * vectorStore adapter slots end-to-end. The tests are deliberately kept
 * provider-agnostic: they use the zero-dep `createHashingTextEmbedding` and
 * `createInMemoryVectorStore` reference adapters so the path runs with no
 * external service and stays deterministic.
 *
 * Invariants under test:
 *   - Round trip: index then search returns ranked matches for a project.
 *   - `advisory: true` is pinned by the schema — the operation re-validates its
 *     own output before returning, so a downstream tweak cannot flip it.
 *   - `topK` bound is honoured on the result.
 *   - Project scoping is enforced on the client side regardless of whether the
 *     backing store honours the `filter` argument.
 *   - When either adapter slot is noop, both operations report UNAVAILABLE and
 *     never throw / never fabricate matches.
 *   - Events carry the op / phase / correlationId but never document bodies or
 *     query text (H13 discipline).
 */

import { describe, expect, it } from 'vitest';

import {
  indexSemanticCorpus,
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';
import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createInMemoryVectorStore } from '../../src/hoplon/adapters/vectorStore/inMemory.js';
import { createNoopEmbedding } from '../../src/hoplon/adapters/embedding.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createNoopLexicalIndex } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import {
  createNoopSemanticIndexStore,
  type SemanticIndexDocument,
  type SemanticIndexStoreAdapter,
} from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { SemanticSearchRequestValidationError } from '../../src/hoplon/contracts/semanticSearchRecovery.js';

function makeLiveDeps(): { deps: SemanticSearchDeps; emitter: ReturnType<typeof createMemoryEmitter> } {
  const emitter = createMemoryEmitter();
  const deps: SemanticSearchDeps = {
    embedding: createHashingTextEmbedding({ dimensions: 64 }),
    vectorStore: createInMemoryVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: createNoopSemanticIndexStore(),
    lexicalIndex: createNoopLexicalIndex(),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter,
    engineId: 'test-semantic-search',
    embeddingProvided: true,
    vectorStoreProvided: true,
  };
  return { deps, emitter };
}

function makeDeps(overrides: Partial<SemanticSearchDeps>): {
  deps: SemanticSearchDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const base = makeLiveDeps();
  return {
    deps: { ...base.deps, ...overrides },
    emitter: overrides.emitter as ReturnType<typeof createMemoryEmitter> ?? base.emitter,
  };
}

describe('semanticSearch — live reference adapters (hashing + in-memory)', () => {
  it('returns UNAVAILABLE for semantic indexing and search when hash-only mode disables retrieval', async () => {
    const { deps } = makeDeps({
      semanticDisabledReason: 'hash_only_manifest_storage',
    });

    const indexResult = await indexSemanticCorpus(deps, {
      correlationId: 'corr-hash-only-index',
      projectId: 'proj-hash-only',
      documents: [{ id: 'doc-a', text: 'hash only content' }],
    });
    const searchResult = await semanticSearch(deps, {
      correlationId: 'corr-hash-only-search',
      projectId: 'proj-hash-only',
      query: 'hash only content',
      topK: 3,
    });

    expect(indexResult.status).toBe('UNAVAILABLE');
    expect(indexResult.indexedCount).toBe(0);
    expect(indexResult.degradationReasons).toEqual(['hash_only_manifest_storage']);
    expect(searchResult).toMatchObject({
      advisory: true,
      status: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      matches: [],
      degradationReasons: ['hash_only_manifest_storage'],
    });
  });

  it('indexes a project corpus and retrieves project-scoped top-K matches', async () => {
    const { deps } = makeLiveDeps();

    const indexResult = await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-1',
      projectId: 'proj-a',
      documents: [
        { id: 'auth', text: 'user login session authentication password token' },
        { id: 'billing', text: 'invoice billing subscription payment charge' },
        { id: 'search', text: 'semantic search embedding vector retrieval' },
      ],
    });
    expect(indexResult.status).toBe('AVAILABLE');
    expect(indexResult.providerStatus).toBe('AVAILABLE');
    expect(indexResult.providerAvailable).toBe(true);
    expect(indexResult.resultCount).toBe(3);
    expect(indexResult.freshness).toBe('indexed');
    expect(indexResult.degradationReasons).toEqual([]);
    expect(indexResult.indexedCount).toBe(3);
    expect(indexResult.requestedCount).toBe(3);

    const searchResult = await semanticSearch(deps, {
      correlationId: 'corr-search-1',
      projectId: 'proj-a',
      query: 'semantic search vector embedding',
      topK: 2,
    });

    expect(searchResult.advisory).toBe(true);
    expect(searchResult.status).toBe('AVAILABLE');
    expect(searchResult.providerStatus).toBe('AVAILABLE');
    expect(searchResult.providerAvailable).toBe(true);
    expect(searchResult.resultCount).toBe(searchResult.matches.length);
    expect(searchResult.freshness).toBe('indexed');
    expect(searchResult.degradationReasons).toEqual([]);
    expect(searchResult.topK).toBe(2);
    expect(searchResult.matches.length).toBeLessThanOrEqual(2);
    expect(searchResult.matches.length).toBeGreaterThan(0);
    expect(searchResult.matches[0]?.id).toBe('search');
    for (const match of searchResult.matches) {
      expect(match.score).toBeGreaterThanOrEqual(0);
      expect(match.score).toBeLessThanOrEqual(1);
      expect(match.metadata.projectId).toBe('proj-a');
    }
  });

  it('honours the topK bound even when more matches are available', async () => {
    const { deps } = makeLiveDeps();
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-2',
      projectId: 'proj-a',
      documents: Array.from({ length: 6 }, (_, i) => ({
        id: `doc-${i}`,
        text: `token alpha beta gamma delta epsilon zeta ${i}`,
      })),
    });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-search-2',
      projectId: 'proj-a',
      query: 'alpha beta gamma',
      topK: 3,
    });

    expect(result.topK).toBe(3);
    expect(result.matches.length).toBeLessThanOrEqual(3);
  });

  it('enforces project scoping — never returns cross-project matches', async () => {
    const { deps } = makeLiveDeps();
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-a',
      projectId: 'proj-a',
      documents: [{ id: 'a-doc', text: 'shared token payload signature' }],
    });
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-b',
      projectId: 'proj-b',
      documents: [{ id: 'b-doc', text: 'shared token payload signature' }],
    });

    const resultA = await semanticSearch(deps, {
      correlationId: 'corr-search-a',
      projectId: 'proj-a',
      query: 'shared token payload',
      topK: 10,
    });
    expect(resultA.matches.every((m) => m.metadata.projectId === 'proj-a')).toBe(true);
    expect(resultA.matches.map((m) => m.id)).toContain('a-doc');
    expect(resultA.matches.map((m) => m.id)).not.toContain('b-doc');

    const resultB = await semanticSearch(deps, {
      correlationId: 'corr-search-b',
      projectId: 'proj-b',
      query: 'shared token payload',
      topK: 10,
    });
    expect(resultB.matches.every((m) => m.metadata.projectId === 'proj-b')).toBe(true);
    expect(resultB.matches.map((m) => m.id)).toContain('b-doc');
    expect(resultB.matches.map((m) => m.id)).not.toContain('a-doc');
  });

  it('does not let the same document id collide across projects', async () => {
    const { deps } = makeLiveDeps();
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-same-id-a',
      projectId: 'proj-a',
      documents: [{ id: 'shared-doc', text: 'alpha authentication login token' }],
    });
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-same-id-b',
      projectId: 'proj-b',
      documents: [{ id: 'shared-doc', text: 'billing invoice payment charge' }],
    });

    const resultA = await semanticSearch(deps, {
      correlationId: 'corr-same-search-a',
      projectId: 'proj-a',
      query: 'authentication login',
      topK: 5,
    });
    const resultB = await semanticSearch(deps, {
      correlationId: 'corr-same-search-b',
      projectId: 'proj-b',
      query: 'invoice payment',
      topK: 5,
    });

    expect(resultA.matches.map((m) => m.id)).toContain('shared-doc');
    expect(resultB.matches.map((m) => m.id)).toContain('shared-doc');
    expect(resultA.matches.every((m) => m.metadata.projectId === 'proj-a')).toBe(true);
    expect(resultB.matches.every((m) => m.metadata.projectId === 'proj-b')).toBe(true);
  });

  it('client-side re-filters by projectId even when the store ignores the filter', async () => {
    // Rogue store that returns every record regardless of the filter argument.
    const rogueStore = {
      async upsert() {},
      async search(_q: number[], topK: number) {
        return [
          { id: 'same-project', score: 0.9, metadata: { projectId: 'proj-a' } },
          { id: 'other-project', score: 0.95, metadata: { projectId: 'proj-b' } },
        ].slice(0, topK);
      },
      async delete() {},
    };
    const { deps } = makeDeps({ vectorStore: rogueStore });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-rogue',
      projectId: 'proj-a',
      query: 'anything',
      topK: 5,
    });

    expect(result.matches.every((m) => m.metadata.projectId === 'proj-a')).toBe(true);
    expect(result.matches.map((m) => m.id)).toContain('same-project');
    expect(result.matches.map((m) => m.id)).not.toContain('other-project');
  });

  it('re-indexing the same document id replaces the prior vector (upsert semantics)', async () => {
    const { deps } = makeLiveDeps();
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-v1',
      projectId: 'proj-a',
      documents: [{ id: 'item', text: 'alpha beta' }],
    });
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-v2',
      projectId: 'proj-a',
      documents: [{ id: 'item', text: 'gamma delta' }],
    });

    const result = await semanticSearch(deps, {
      correlationId: 'corr-search-upsert',
      projectId: 'proj-a',
      query: 'gamma delta',
      topK: 1,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.id).toBe('item');
  });
});

describe('indexSemanticCorpus — source commit contracts', () => {
  it('passes commit-scoped source rows to the semantic index store', async () => {
    const captured: SemanticIndexDocument[] = [];
    const semanticIndexStore: SemanticIndexStoreAdapter = {
      async read() {
        return {
          status: 'AVAILABLE',
          documents: [],
          freshness: 'indexed',
          degradationReasons: [],
        };
      },
      async write(_projectId, documents) {
        captured.push(...documents);
        return {
          status: 'AVAILABLE',
          writtenCount: documents.length,
          freshness: 'indexed',
          degradationReasons: [],
        };
      },
      async delete() {
        return {
          status: 'EMPTY',
          writtenCount: 0,
          freshness: 'indexed',
          degradationReasons: [],
        };
      },
    };
    const { deps } = makeDeps({
      embedding: createNoopEmbedding(),
      vectorStore: createNoopVectorStore(),
      semanticIndexStore,
      embeddingProvided: false,
      vectorStoreProvided: false,
      semanticIndexStoreProvided: true,
    });
    const commitOid = 'c'.repeat(40);

    const result = await indexSemanticCorpus(deps, {
      correlationId: 'corr-source-contract',
      projectId: 'proj-source',
      documents: [
        {
          id: 'src/main.ts#0',
          text: 'source scoped chunk',
          documentTextHash: 'content-hash',
          sourceSnapshot: {
            sourceSnapshotId: 'source-snapshot-1',
            projectId: 'proj-source',
            commitOid,
            corpusSchemaVersion: 'semantic-corpus-v2',
            embeddingProfileHash: 'embedding-profile-hash',
          },
          branchAliases: [
            {
              projectId: 'proj-source',
              sourceSnapshotId: 'source-snapshot-1',
              branchName: 'main',
              branchKind: 'local_branch',
              commitOid,
              observedAtIso: '2026-05-08T00:00:00.000Z',
              isDefault: true,
              isCurrent: true,
              staleState: 'fresh',
            },
            {
              projectId: 'proj-source',
              sourceSnapshotId: 'source-snapshot-1',
              branchName: 'hoplon-origin/main',
              branchKind: 'remote_tracking_branch',
              commitOid,
              observedAtIso: '2026-05-08T00:00:00.000Z',
              isDefault: false,
              isCurrent: false,
              staleState: 'fresh',
              remote: 'hoplon-origin',
            },
          ],
          chunkIdentity: {
            projectId: 'proj-source',
            sourceSnapshotId: 'source-snapshot-1',
            chunkId: 'src/main.ts#0',
            canonicalPath: 'src/main.ts',
            contentHash: 'content-hash',
            chunkHash: 'chunk-hash',
            chunkIndex: 0,
            lineRange: { startLine: 1, endLine: 4 },
            sourceProvenance: { commitOid, branchNames: ['main'] },
            embeddingCacheKey: 'emb:profile:content-hash:chunk-hash',
          },
        },
      ],
    });

    expect(result.status).toBe('AVAILABLE');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sourceSnapshot?.commitOid).toBe(commitOid);
    expect(captured[0]?.branchAliases?.map((alias) => alias.branchName)).toEqual([
      'main',
      'hoplon-origin/main',
    ]);
    expect(captured[0]?.chunkIdentity).toMatchObject({
      canonicalPath: 'src/main.ts',
      contentHash: 'content-hash',
      embeddingCacheKey: 'emb:profile:content-hash:chunk-hash',
    });
  });
});

describe('semanticSearch — noop fallback (UNAVAILABLE)', () => {
  it('index returns UNAVAILABLE / providerAvailable=false when embedding is noop', async () => {
    const emitter = createMemoryEmitter();
    const deps: SemanticSearchDeps = {
      embedding: createNoopEmbedding(),
      vectorStore: createInMemoryVectorStore(),
      embeddingCache: createNoopEmbeddingCache(),
      semanticIndexStore: createNoopSemanticIndexStore(),
      lexicalIndex: createNoopLexicalIndex(),
      vectorIndex: createNoopVectorIndex(),
      semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
      semanticStorageProfile: createNoopSemanticStorageProfile(),
      emitter,
      engineId: 'test-unavailable-embedding',
      embeddingProvided: false,
      vectorStoreProvided: true,
    };

    const result = await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-na',
      projectId: 'proj-a',
      documents: [{ id: 'd1', text: 'anything' }],
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerStatus).toBe('UNAVAILABLE');
    expect(result.providerAvailable).toBe(false);
    expect(result.resultCount).toBe(0);
    expect(result.freshness).toBe('unavailable');
    expect(result.degradationReasons).toEqual(['provider_not_bound']);
    expect(result.indexedCount).toBe(0);
    expect(result.requestedCount).toBe(1);
  });

  it('search returns UNAVAILABLE / empty matches when vectorStore is noop', async () => {
    const emitter = createMemoryEmitter();
    const deps: SemanticSearchDeps = {
      embedding: createHashingTextEmbedding(),
      vectorStore: createNoopVectorStore(),
      embeddingCache: createNoopEmbeddingCache(),
      semanticIndexStore: createNoopSemanticIndexStore(),
      lexicalIndex: createNoopLexicalIndex(),
      vectorIndex: createNoopVectorIndex(),
      semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
      semanticStorageProfile: createNoopSemanticStorageProfile(),
      emitter,
      engineId: 'test-unavailable-store',
      embeddingProvided: true,
      vectorStoreProvided: false,
    };

    const result = await semanticSearch(deps, {
      correlationId: 'corr-search-na',
      projectId: 'proj-a',
      query: 'does not matter',
      topK: 5,
    });

    expect(result.advisory).toBe(true);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.providerStatus).toBe('UNAVAILABLE');
    expect(result.providerAvailable).toBe(false);
    expect(result.resultCount).toBe(0);
    expect(result.freshness).toBe('unavailable');
    expect(result.degradationReasons).toEqual([
      'provider_not_bound',
      'no_indexed_corpus',
    ]);
    expect(result.matches).toEqual([]);
    expect(result.topK).toBe(5);
  });

  it('search returns UNAVAILABLE when BOTH slots are noop — does not throw', async () => {
    const emitter = createMemoryEmitter();
    const deps: SemanticSearchDeps = {
      embedding: createNoopEmbedding(),
      vectorStore: createNoopVectorStore(),
      embeddingCache: createNoopEmbeddingCache(),
      semanticIndexStore: createNoopSemanticIndexStore(),
      lexicalIndex: createNoopLexicalIndex(),
      vectorIndex: createNoopVectorIndex(),
      semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
      semanticStorageProfile: createNoopSemanticStorageProfile(),
      emitter,
      engineId: 'test-unavailable-both',
      embeddingProvided: false,
      vectorStoreProvided: false,
    };

    await expect(
      semanticSearch(deps, {
        correlationId: 'corr-both-noop',
        projectId: 'proj-a',
        query: 'q',
        topK: 3,
      }),
    ).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      advisory: true,
      matches: [],
    });
  });
});

describe('semanticSearch — empty result envelope', () => {
  it('returns EMPTY when real providers run but no project documents match', async () => {
    const { deps } = makeLiveDeps();

    const result = await semanticSearch(deps, {
      correlationId: 'corr-empty',
      projectId: 'proj-empty',
      query: 'no indexed project documents',
      topK: 3,
    });

    expect(result.status).toBe('EMPTY');
    expect(result.providerStatus).toBe('EMPTY');
    expect(result.providerAvailable).toBe(true);
    expect(result.resultCount).toBe(0);
    expect(result.freshness).toBe('indexed');
    expect(result.degradationReasons).toEqual([]);
    expect(result.matches).toEqual([]);
  });
});

describe('semanticSearch — emitter discipline', () => {
  it('emits start + end for a successful index/search pair and preserves correlationId', async () => {
    const { deps, emitter } = makeLiveDeps();
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-idx-evt',
      projectId: 'proj-a',
      documents: [{ id: 'x', text: 'foo bar baz' }],
    });
    await semanticSearch(deps, {
      correlationId: 'corr-search-evt',
      projectId: 'proj-a',
      query: 'foo bar',
      topK: 1,
    });

    const events = emitter.getEvents();
    const idxEvents = events.filter((e) => e.op === 'indexSemanticCorpus');
    const searchEvents = events.filter((e) => e.op === 'semanticSearch');
    expect(idxEvents.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(searchEvents.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(idxEvents.every((e) => e.correlationId === 'corr-idx-evt')).toBe(true);
    expect(searchEvents.every((e) => e.correlationId === 'corr-search-evt')).toBe(true);
  });

  it('never leaks query text, document ids, or body content into events (H13)', async () => {
    const { deps, emitter } = makeLiveDeps();
    const secretDocId = 'secret-document-id-xyz';
    const secretQuery = 'top-secret-query-phrase';
    await indexSemanticCorpus(deps, {
      correlationId: 'corr-h13-idx',
      projectId: 'proj-a',
      documents: [{ id: secretDocId, text: 'payload with distinct tokens' }],
    });
    await semanticSearch(deps, {
      correlationId: 'corr-h13-search',
      projectId: 'proj-a',
      query: secretQuery,
      topK: 1,
    });

    const serialized = JSON.stringify(emitter.getEvents());
    expect(serialized).not.toContain(secretDocId);
    expect(serialized).not.toContain(secretQuery);
    expect(serialized).not.toContain('payload with distinct tokens');
  });
});

describe('semanticSearch — request validation', () => {
  it('rejects an empty query string', async () => {
    const { deps } = makeLiveDeps();
    await expect(
      semanticSearch(deps, {
        correlationId: 'corr-bad-query',
        projectId: 'proj-a',
        query: '',
        topK: 3,
      }),
    ).rejects.toThrow();
  });

  it('rejects non-positive topK', async () => {
    const { deps } = makeLiveDeps();
    await expect(
      semanticSearch(deps, {
        correlationId: 'corr-bad-topk',
        projectId: 'proj-a',
        query: 'anything',
        topK: 0,
      }),
    ).rejects.toThrow();
  });

  it('returns typed recovery for an unknown extra field with deterministic didYouMean', async () => {
    const { deps } = makeLiveDeps();
    const p = semanticSearch(deps, {
      correlationId: 'corr-bad-extra',
      projectId: 'proj-a',
      query: 'anything',
      topK: 3,
      resultFeilds: 'snippet',
    } as unknown as Parameters<typeof semanticSearch>[1]);
    await expect(p).rejects.toBeInstanceOf(SemanticSearchRequestValidationError);
    try {
      await p;
    } catch (err) {
      const validation = err as SemanticSearchRequestValidationError;
      expect(validation.recovery.advisory).toBe(true);
      expect(validation.recovery.diagnostics).toContainEqual(
        expect.objectContaining({
          fieldPath: 'resultFeilds',
          didYouMean: 'resultFields',
        }),
      );
      expect(validation.recovery.minimalValidRequest).toMatchObject({
        query: 'semantic search query',
        topK: 5,
      });
    }
  });

  it('returns allowed values for invalid enum fields', async () => {
    const { deps } = makeLiveDeps();
    const p = semanticSearch(deps, {
      correlationId: 'corr-bad-enum',
      projectId: 'proj-a',
      query: 'anything',
      topK: 3,
      resultFields: 'body',
    } as unknown as Parameters<typeof semanticSearch>[1]);
    await expect(p).rejects.toBeInstanceOf(SemanticSearchRequestValidationError);
    try {
      await p;
    } catch (err) {
      const validation = err as SemanticSearchRequestValidationError;
      expect(validation.recovery.diagnostics).toContainEqual(
        expect.objectContaining({
          fieldPath: 'resultFields',
          allowedValues: ['path_only', 'path_and_symbol', 'snippet'],
        }),
      );
    }
  });

  it('returns branchScope recovery when branch list mode omits refs', async () => {
    const { deps } = makeLiveDeps();
    const p = semanticSearch(deps, {
      correlationId: 'corr-bad-branch-scope',
      projectId: 'proj-a',
      query: 'anything',
      topK: 3,
      branchScope: { mode: 'branches' },
    });
    await expect(p).rejects.toBeInstanceOf(SemanticSearchRequestValidationError);
    try {
      await p;
    } catch (err) {
      const validation = err as SemanticSearchRequestValidationError;
      expect(validation.recovery.diagnostics).toContainEqual(
        expect.objectContaining({
          fieldPath: 'branchScope.refs',
          expectedShape: 'non-empty string array when mode is branches',
        }),
      );
    }
  });

  it('rejects an empty documents array on index', async () => {
    const { deps } = makeLiveDeps();
    await expect(
      indexSemanticCorpus(deps, {
        correlationId: 'corr-bad-empty',
        projectId: 'proj-a',
        documents: [],
      }),
    ).rejects.toThrow();
  });
});
