import { describe, expect, it } from 'vitest';

import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { LexicalIndexAdapter } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import type {
  SemanticIndexDocument,
  SemanticIndexStoreAdapter,
} from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';
import {
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';

describe('semanticSearch branch source scope (sem-search-019)', () => {
  it('collapses duplicate source chunks and aggregates branch aliases', async () => {
    const commit = 'a'.repeat(40);
    const deps = makeDeps([
      sourceDoc('main-copy', commit, 'main', 'same-content'),
      sourceDoc('feature-copy', commit, 'feature', 'same-content'),
    ], [
      { id: 'main-copy', score: 0.8, metadata: { projectId: 'proj-a' } },
      { id: 'feature-copy', score: 0.7, metadata: { projectId: 'proj-a' } },
    ]);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-branch-dedupe',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.branchAliases?.map((a) => a.branchName).sort()).toEqual([
      'feature',
      'main',
    ]);
  });

  it('returns path variants for different content and filters branch lists', async () => {
    const deps = makeDeps([
      sourceDoc('main-variant', 'a'.repeat(40), 'main', 'main-content'),
      sourceDoc('feature-variant', 'b'.repeat(40), 'feature', 'feature-content'),
    ], [
      { id: 'main-variant', score: 0.9, metadata: { projectId: 'proj-a' } },
      { id: 'feature-variant', score: 0.85, metadata: { projectId: 'proj-a' } },
    ]);

    const all = await semanticSearch(deps, {
      correlationId: 'corr-branch-variants',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
    });
    const featureOnly = await semanticSearch(deps, {
      correlationId: 'corr-branch-filter',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
      branchScope: { mode: 'branches', refs: ['feature'] },
    });

    expect(all.matches.map((m) => m.id)).toEqual(['main-variant', 'feature-variant']);
    expect(featureOnly.matches.map((m) => m.id)).toEqual(['feature-variant']);
  });

  it('excludes stale aliases when stalePolicy is exclude', async () => {
    const deps = makeDeps([
      sourceDoc('stale-doc', 'a'.repeat(40), 'main', 'old-content', 'stale'),
      sourceDoc('fresh-doc', 'b'.repeat(40), 'main', 'new-content'),
    ], [
      { id: 'stale-doc', score: 0.95, metadata: { projectId: 'proj-a' } },
      { id: 'fresh-doc', score: 0.9, metadata: { projectId: 'proj-a' } },
    ]);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-stale-exclude',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
      branchScope: { mode: 'all_indexed' },
      stalePolicy: 'exclude',
    });

    expect(result.matches.map((m) => m.id)).toEqual(['fresh-doc']);
    expect(result.degradationReasons).not.toContain('stale_index');
  });

  it('returns deterministic suggestions for unknown branch refs', async () => {
    const deps = makeDeps([
      sourceDoc('feature-doc', 'a'.repeat(40), 'feature/login', 'feature-content'),
    ], [
      { id: 'feature-doc', score: 0.8, metadata: { projectId: 'proj-a' } },
    ]);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-branch-suggest',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
      branchScope: { mode: 'branches', refs: ['feature/logn'] },
    });

    expect(result.matches).toEqual([]);
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      kind: 'branch',
      value: 'feature/login',
      provenance: 'deterministic',
    }));
  });

  it('returns deterministic suggestions for unmatched branch patterns', async () => {
    const deps = makeDeps([
      sourceDoc('feature-doc', 'a'.repeat(40), 'feature/login', 'feature-content'),
    ], [
      { id: 'feature-doc', score: 0.8, metadata: { projectId: 'proj-a' } },
    ]);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-pattern-suggest',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
      branchScope: { mode: 'patterns', patterns: ['release/*'] },
    });

    expect(result.matches).toEqual([]);
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      kind: 'pattern',
      value: 'release/*',
    }));
  });

  it('returns stale guidance when stale aliases are included', async () => {
    const deps = makeDeps([
      sourceDoc('stale-doc', 'a'.repeat(40), 'main', 'old-content', 'stale'),
    ], [
      { id: 'stale-doc', score: 0.9, metadata: { projectId: 'proj-a' } },
    ]);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-stale-suggest',
      projectId: 'proj-a',
      query: 'shared',
      topK: 5,
      branchScope: { mode: 'all_indexed' },
    });

    expect(result.degradationReasons).toContain('stale_index');
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      kind: 'stale_index',
      provenance: 'deterministic',
    }));
  });
});

function makeDeps(
  sourceDocs: SemanticIndexDocument[],
  matches: Awaited<ReturnType<LexicalIndexAdapter['search']>>['matches'],
): SemanticSearchDeps {
  return {
    embedding: createHashingTextEmbedding({ dimensions: 8 }),
    vectorStore: createNoopVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore: sourceStore(sourceDocs),
    lexicalIndex: lexicalMatches(matches),
    vectorIndex: createNoopVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter: createMemoryEmitter(),
    engineId: 'test-semantic-branch-scope',
    embeddingProvided: true,
    vectorStoreProvided: false,
    semanticIndexStoreProvided: true,
    lexicalIndexProvided: true,
  };
}

function lexicalMatches(
  matches: Awaited<ReturnType<LexicalIndexAdapter['search']>>['matches'],
): LexicalIndexAdapter {
  const result = { status: 'AVAILABLE' as const, resultCount: 0, matches: [], degradationReasons: [] };
  return {
    async upsert() { return result; },
    async search(_projectId, _query, topK) {
      return { ...result, resultCount: matches.length, matches: matches.slice(0, topK) };
    },
    async delete() { return result; },
  };
}

function sourceStore(documents: SemanticIndexDocument[]): SemanticIndexStoreAdapter {
  return {
    async read() {
      return { status: 'AVAILABLE', documents, freshness: 'indexed', degradationReasons: [] };
    },
    async write() {
      return { status: 'AVAILABLE', writtenCount: 0, freshness: 'indexed', degradationReasons: [] };
    },
    async delete() {
      return { status: 'AVAILABLE', writtenCount: 0, freshness: 'indexed', degradationReasons: [] };
    },
  };
}

function sourceDoc(
  id: string,
  commitOid: string,
  branchName: string,
  contentHash: string,
  staleState: 'fresh' | 'stale' = 'fresh',
): SemanticIndexDocument {
  const sourceSnapshotId = `source:proj-a:${commitOid}:sem-v1:profile`;
  return {
    id,
    text: 'shared source text',
    metadata: { projectId: 'proj-a', path: 'src/a.ts' },
    contentHash,
    sourceSnapshot: {
      sourceSnapshotId,
      projectId: 'proj-a',
      commitOid,
      corpusSchemaVersion: 'sem-v1',
      embeddingProfileHash: 'profile',
    },
    branchAliases: [{
      projectId: 'proj-a',
      sourceSnapshotId,
      branchName,
      branchKind: 'local_branch',
      commitOid,
      observedAtIso: '1970-01-01T00:00:00.000Z',
      isDefault: branchName === 'main',
      isCurrent: branchName === 'main',
      staleState,
    }],
    chunkIdentity: {
      projectId: 'proj-a',
      sourceSnapshotId,
      chunkId: id,
      canonicalPath: 'src/a.ts',
      contentHash,
      chunkHash: contentHash,
      chunkIndex: 0,
      sourceProvenance: { commitOid, branchNames: [branchName] },
      embeddingCacheKey: `emb:${contentHash}`,
    },
  };
}
