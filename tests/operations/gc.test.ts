import { describe, expect, it } from 'vitest';

import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import { gc } from '../../src/hoplon/operations/gc.js';
import {
  createInMemorySemanticSessionOverlayStore,
  refreshSemanticOverlay,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';
import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createNoopLexicalIndex } from '../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../src/hoplon/adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore } from '../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorIndex } from '../../src/hoplon/adapters/vectorIndex.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';

describe('gc semantic maintenance', () => {
  it('reaps expired semantic overlays and returns counts only', async () => {
    let now = 0;
    const sessionOverlayStore = createInMemorySemanticSessionOverlayStore({
      now: () => now,
      ttlMs: 10,
    });
    await refreshSemanticOverlay(makeSemanticDeps(sessionOverlayStore), {
      correlationId: 'corr-gc-overlay-refresh',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      sessionId: 'session-a',
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      touchedFiles: ['src/new.ts'],
      documents: [
        {
          id: 'overlay-doc',
          text: 'expired overlay document',
          metadata: { path: 'src/new.ts' },
        },
      ],
    });
    now = 11;

    const result = await gc(
      { snapshotStore: makeSnapshotStore(), sessionOverlayStore },
      { semanticOverlays: true },
    );

    expect(result).toEqual({
      deletedCount: 0,
      semanticOverlaysReaped: 1,
    });
    expect(Object.keys(result)).toEqual(['deletedCount', 'semanticOverlaysReaped']);
  });

  it('keeps semantic cache and tombstone maintenance count-only when no provider is bound', async () => {
    const result = await gc(
      { snapshotStore: makeSnapshotStore() },
      { semanticCache: true, semanticTombstones: true },
    );

    expect(result).toEqual({
      deletedCount: 0,
      semanticCacheEntriesDeleted: 0,
      semanticTombstonesDeleted: 0,
      degradationReasons: [
        'semantic_cache_maintenance_provider_not_bound',
        'semantic_tombstone_maintenance_provider_not_bound',
      ],
    });
  });
});

function makeSnapshotStore(): SnapshotStore {
  return {
    async listPending() {
      return [];
    },
    async gc() {
      return { deletedCount: 0 };
    },
  } as SnapshotStore;
}

function makeSemanticDeps(
  sessionOverlayStore: SemanticSearchDeps['sessionOverlayStore'],
): SemanticSearchDeps {
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
    engineId: 'semantic-gc-test',
    embeddingProvided: true,
    vectorStoreProvided: false,
    sessionOverlayStore,
  };
}
