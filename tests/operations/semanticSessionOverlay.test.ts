import { describe, expect, it } from 'vitest';

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
  createInMemorySemanticSessionOverlayStore,
  refreshSemanticOverlay,
  semanticSearch,
  type SemanticSearchDeps,
} from '../../src/hoplon/operations/semanticSearch.js';

describe('semanticSearch live-session overlay', () => {
  it('returns session-overlay matches through the existing semanticSearch fusion path', async () => {
    const deps = makeDeps();

    const refresh = await refreshSemanticOverlay(deps, {
      correlationId: 'corr-overlay-refresh',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      sessionId: 'session-a',
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      touchedFiles: ['src/new.ts'],
      documents: [
        {
          id: 'overlay-doc',
          text: 'brand new live overlay symbol',
          metadata: { path: 'src/new.ts' },
        },
      ],
    });

    expect(refresh.status).toBe('AVAILABLE');
    expect(refresh.published).toBe(true);
    expect(refresh.documentCount).toBe(1);

    const result = await semanticSearch(deps, {
      correlationId: 'corr-overlay-search',
      projectId: 'project-a',
      sessionId: 'session-a',
      currentContext: {
        worktreeId: 'worktree-a',
        headOid: 'head-a',
        ignoreRulesHash: 'ignore-a',
      },
      overlayScope: 'session_overlay_only',
      query: 'live overlay symbol',
      topK: 5,
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.freshness).toBe('live_session');
    expect(result.matches.map((match) => match.id)).toEqual(['overlay-doc']);
    expect(result.matches[0]).toMatchObject({
      source: 'session_overlay',
      rankSource: 'overlay_lexical',
      freshness: 'live_session',
    });

    const otherWorktree = await semanticSearch(deps, {
      correlationId: 'corr-overlay-other-worktree',
      projectId: 'project-a',
      sessionId: 'session-a',
      currentContext: {
        worktreeId: 'worktree-b',
        headOid: 'head-b',
        ignoreRulesHash: 'ignore-a',
      },
      overlayScope: 'session_overlay_only',
      query: 'live overlay symbol',
      topK: 5,
    });

    expect(otherWorktree.status).toBe('UNAVAILABLE');
    expect(otherWorktree.matches).toEqual([]);
    expect(otherWorktree.degradationReasons).toEqual(['overlay_never_created']);
  });

  it('reports overlay_never_created distinctly for session_overlay_only lookup misses', async () => {
    const result = await semanticSearch(makeDeps(), {
      correlationId: 'corr-overlay-miss',
      projectId: 'project-a',
      sessionId: 'missing-session',
      overlayScope: 'session_overlay_only',
      query: 'anything',
      topK: 3,
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.matches).toEqual([]);
    expect(result.degradationReasons).toEqual(['overlay_never_created']);
  });

  it('reaps inactive overlays lazily and reports overlay_reaped_inactive_ttl', async () => {
    let now = 0;
    const deps = makeDeps({
      sessionOverlayStore: createInMemorySemanticSessionOverlayStore({
        now: () => now,
        ttlMs: 10,
      }),
    });
    await refreshSemanticOverlay(deps, {
      correlationId: 'corr-overlay-ttl-refresh',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      sessionId: 'session-a',
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      touchedFiles: ['src/ttl.ts'],
      documents: [
        {
          id: 'ttl-doc',
          text: 'ttl live document',
          metadata: { path: 'src/ttl.ts' },
        },
      ],
    });
    now = 11;

    const result = await semanticSearch(deps, {
      correlationId: 'corr-overlay-ttl-search',
      projectId: 'project-a',
      sessionId: 'session-a',
      currentContext: {
        worktreeId: 'worktree-a',
        headOid: 'head-a',
        ignoreRulesHash: 'ignore-a',
      },
      overlayScope: 'session_overlay_only',
      query: 'ttl live document',
      topK: 5,
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.matches).toEqual([]);
    expect(result.degradationReasons).toEqual(['overlay_reaped_inactive_ttl']);
  });

  it('reports process-local overlay store absence before provider misses', async () => {
    const { sessionOverlayStore: _store, ...deps } = makeDeps();

    const result = await semanticSearch(deps, {
      correlationId: 'corr-overlay-no-store',
      projectId: 'project-a',
      sessionId: 'session-a',
      overlayScope: 'session_overlay_only',
      query: 'anything',
      topK: 3,
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.matches).toEqual([]);
    expect(result.degradationReasons).toEqual([
      'overlay_unavailable_process_local_store',
    ]);
  });
});

function makeDeps(
  overrides: Partial<SemanticSearchDeps> = {},
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
    engineId: 'semantic-overlay-test',
    embeddingProvided: true,
    vectorStoreProvided: false,
    lexicalIndexProvided: false,
    vectorIndexProvided: false,
    sessionOverlayStore: createInMemorySemanticSessionOverlayStore(),
    ...overrides,
  };
}
