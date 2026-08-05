/**
 * tests/unit/adapters/ml-adapters.test.ts
 *
 * ML1 targeted proof tests — Phase 2 Wave 5.
 *
 * Verifies:
 *   1. createNoopEmbedding() satisfies EmbeddingAdapter contract (returns [])
 *   2. createNoopVectorStore() satisfies VectorStoreAdapter contract
 *      (upsert: void, search: [], delete: void)
 *   3. createNoopAnomalyDetector() satisfies AnomalyDetectorAdapter contract
 *      (score: { score: 0, isAnomalous: false, signals: [] })
 *   4. Factory accepts undefined for each ML slot and substitutes no-op defaults
 *   5. Factory accepts explicit no-op implementations for each ML slot
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createNoopEmbedding } from '../../../src/hoplon/adapters/embedding.js';
import { createNoopVectorStore } from '../../../src/hoplon/adapters/vectorStore.js';
import { createNoopAnomalyDetector } from '../../../src/hoplon/adapters/anomalyDetector.js';
import { createNoopEmbeddingCache } from '../../../src/hoplon/adapters/embeddingCache.js';
import { createHashingTextEmbedding } from '../../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopLexicalIndex } from '../../../src/hoplon/adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../../../src/hoplon/adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore } from '../../../src/hoplon/adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile } from '../../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopVectorIndex } from '../../../src/hoplon/adapters/vectorIndex.js';
import { createInMemoryVectorStore } from '../../../src/hoplon/adapters/vectorStore/inMemory.js';
import { createHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import type { HoplonAdapters } from '../../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Helper: minimal valid adapters (7 mandatory, no optional ML slots)
// ---------------------------------------------------------------------------

async function makeBaseAdapters(): Promise<HoplonAdapters> {
  const fs = createMemFsAdapter();
  return {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: await createIsolatedTestStore(),
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    codeIntelligence: sharedCI,
    secretScanner: createBuiltinRegexScanner(),
  };
}

const BASE_CONFIG = { engineId: 'test-ml1', fsRoot: '/' };

// ---------------------------------------------------------------------------
// ML1-1: createNoopEmbedding satisfies EmbeddingAdapter contract
// ---------------------------------------------------------------------------

describe('ML1-1 — createNoopEmbedding', () => {
  it('returns an empty array for any text input', async () => {
    const adapter = createNoopEmbedding();
    const result = await adapter.embed('hello world');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns an empty array for an empty string', async () => {
    const adapter = createNoopEmbedding();
    const result = await adapter.embed('');
    expect(result).toEqual([]);
  });

  it('returns an empty array for a multiline code string', async () => {
    const adapter = createNoopEmbedding();
    const code = `function foo() {\n  return 42;\n}`;
    const result = await adapter.embed(code);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ML1-2: createNoopVectorStore satisfies VectorStoreAdapter contract
// ---------------------------------------------------------------------------

describe('ML1-2 — createNoopVectorStore', () => {
  it('upsert resolves without throwing', async () => {
    const store = createNoopVectorStore();
    await expect(
      store.upsert({ id: 'test-id', vector: [0.1, 0.2, 0.3], metadata: { file: 'foo.ts' } }),
    ).resolves.toBeUndefined();
  });

  it('search returns an empty array for any query', async () => {
    const store = createNoopVectorStore();
    const results = await store.search([0.1, 0.2, 0.3], 10);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it('search returns empty array even after upsert (no-op store)', async () => {
    const store = createNoopVectorStore();
    await store.upsert({ id: 'a', vector: [1, 0, 0], metadata: {} });
    const results = await store.search([1, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it('delete resolves without throwing (id exists or not)', async () => {
    const store = createNoopVectorStore();
    await expect(store.delete('nonexistent-id')).resolves.toBeUndefined();
  });

  it('delete + search sequence: no error, still returns []', async () => {
    const store = createNoopVectorStore();
    await store.upsert({ id: 'b', vector: [0, 1, 0], metadata: {} });
    await store.delete('b');
    const results = await store.search([0, 1, 0], 1);
    expect(results).toEqual([]);
  });
});

describe('sem-search-001 — split semantic no-op adapters', () => {
  it('reports UNAVAILABLE for split cache, store, lexical, vector, builder, and profile seams', async () => {
    await expect(createNoopEmbeddingCache().get('k')).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      record: null,
      degradationReasons: ['embedding_cache_provider_not_bound'],
    });
    await expect(createNoopSemanticIndexStore().read('proj')).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      documents: [],
      freshness: 'unavailable',
    });
    await expect(createNoopLexicalIndex().search('proj', 'query', 3)).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
    });
    await expect(createNoopVectorIndex().search('proj', [1, 0], 3)).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
    });
    await expect(
      createNoopSemanticDocumentBuilder().build({ projectId: 'proj', files: [] }),
    ).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      documents: [],
      resultCount: 0,
    });
    await expect(createNoopSemanticStorageProfile().describe()).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      durableLexical: false,
      durableVector: false,
      nativeRuntime: false,
    });
  });
});

// ---------------------------------------------------------------------------
// ML1-3: createNoopAnomalyDetector satisfies AnomalyDetectorAdapter contract
// ---------------------------------------------------------------------------

describe('ML1-3 — createNoopAnomalyDetector', () => {
  it('returns score=0, isAnomalous=false, signals=[], advisory=true for minimal input', async () => {
    const detector = createNoopAnomalyDetector();
    const result = await detector.score({
      projectId: 'proj-1',
      historicalRecords: [],
    });
    expect(result.score).toBe(0);
    expect(result.isAnomalous).toBe(false);
    expect(result.advisory).toBe(true);
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.signals).toHaveLength(0);
  });

  it('returns zero score even when proposed metrics are provided', async () => {
    const detector = createNoopAnomalyDetector();
    const result = await detector.score({
      projectId: 'proj-2',
      historicalRecords: [],
      proposedMetrics: {
        projectId: 'proj-2',
        astNodeCount: 9000,
        fileLineCount: 500,
        manifestScopeRatio: 0.8,
      },
    });
    expect(result.score).toBe(0);
    expect(result.isAnomalous).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.signals).toEqual([]);
  });

  it('returns consistent zero score across multiple calls (stateless noop)', async () => {
    const detector = createNoopAnomalyDetector();
    const r1 = await detector.score({ projectId: 'p', historicalRecords: [] });
    const r2 = await detector.score({ projectId: 'p', historicalRecords: [] });
    expect(r1).toEqual(r2);
    expect(r1.score).toBe(0);
    expect(r1.advisory).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ML1-4: Factory accepts undefined for each ML slot — defaults substituted
// ---------------------------------------------------------------------------

describe('ML1-4 — factory accepts undefined ML slots and substitutes no-op defaults', () => {
  it('succeeds when embedding is undefined', async () => {
    const adapters = await makeBaseAdapters();
    expect(adapters.embedding).toBeUndefined();
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });

  it('succeeds when vectorStore is undefined', async () => {
    const adapters = await makeBaseAdapters();
    expect(adapters.vectorStore).toBeUndefined();
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });

  it('succeeds when anomalyDetector is undefined', async () => {
    const adapters = await makeBaseAdapters();
    expect(adapters.anomalyDetector).toBeUndefined();
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });

  it('succeeds when all three ML slots are undefined simultaneously', async () => {
    const adapters = await makeBaseAdapters();
    // All three absent — verify the engine starts cleanly
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    expect(engine).toBeDefined();
    expect(typeof engine.health).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ML1-5: Factory accepts explicit no-op adapters for each ML slot
// ---------------------------------------------------------------------------

describe('ML1-5 — factory accepts explicit no-op ML adapters', () => {
  it('succeeds when all three ML adapters are explicitly provided as no-ops', async () => {
    const adapters = await makeBaseAdapters();
    const withML: HoplonAdapters = {
      ...adapters,
      embedding: createNoopEmbedding(),
      vectorStore: createNoopVectorStore(),
      anomalyDetector: createNoopAnomalyDetector(),
    };
    const engine = await createHoplonEngine(withML, BASE_CONFIG);
    expect(engine).toBeDefined();
  });

  it('engine created with explicit no-op ML adapters passes health check', async () => {
    const adapters = await makeBaseAdapters();
    const withML: HoplonAdapters = {
      ...adapters,
      embedding: createNoopEmbedding(),
      vectorStore: createNoopVectorStore(),
      anomalyDetector: createNoopAnomalyDetector(),
    };
    const engine = await createHoplonEngine(withML, BASE_CONFIG);
    const health = await engine.health();
    // EngineHealth has no top-level status; all 8 adapter probes must be 'ok'
    expect(health.adapters.fs).toBe('ok');
    expect(health.adapters.snapshotStore).toBe('ok');
    expect(health.engineId).toBe('test-ml1');
  });

  it('explicit built-in noop providers stay UNAVAILABLE and seam-only on the engine surface', async () => {
    const adapters = await makeBaseAdapters();
    const engine = await createHoplonEngine(
      {
        ...adapters,
        embedding: createNoopEmbedding(),
        vectorStore: createNoopVectorStore(),
        anomalyDetector: createNoopAnomalyDetector(),
      },
      BASE_CONFIG,
    );

    await expect(
      engine.semanticSearch({
        correlationId: 'corr-explicit-noops',
        projectId: 'proj-a',
        query: 'alpha beta',
        topK: 3,
      }),
    ).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      providerStatus: 'UNAVAILABLE',
      providerAvailable: false,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: ['provider_not_bound', 'no_indexed_corpus'],
      advisory: true,
      matches: [],
    });

    const report = await engine.describeCapabilities({
      correlationId: 'corr-cap-explicit-noops',
    });
    const byId = new Map(report.capabilities.map((entry) => [entry.descriptor.capabilityId, entry]));

    expect(byId.get('embedding')?.descriptor.runtimeState).toBe('seam_only');
    expect(byId.get('embedding')?.descriptor.defaultBinding).toBe('noop');
    expect(byId.get('vectorStore')?.descriptor.runtimeState).toBe('seam_only');
    expect(byId.get('vectorStore')?.descriptor.defaultBinding).toBe('noop');
    expect(byId.get('semanticSearch')?.descriptor.runtimeState).toBe('seam_only');
    expect(byId.get('semanticSearch')?.descriptor.defaultBinding).toBe('noop');
  });

  it('host-wired legacy providers keep semantic search available but degraded', async () => {
    const adapters = await makeBaseAdapters();
    const engine = await createHoplonEngine(
      {
        ...adapters,
        embedding: createHashingTextEmbedding({ dimensions: 64 }),
        vectorStore: createInMemoryVectorStore(),
      },
      BASE_CONFIG,
    );

    const indexed = await engine.indexSemanticCorpus({
      correlationId: 'corr-live-index',
      projectId: 'proj-a',
      documents: [{ id: 'doc-1', text: 'semantic search vector retrieval' }],
    });
    expect(indexed.status).toBe('AVAILABLE');
    expect(indexed.providerStatus).toBe('AVAILABLE');
    expect(indexed.providerAvailable).toBe(true);
    expect(indexed.resultCount).toBe(1);
    expect(indexed.freshness).toBe('indexed');

    const result = await engine.semanticSearch({
      correlationId: 'corr-live-search',
      projectId: 'proj-a',
      query: 'semantic vector search',
      topK: 1,
    });
    expect(result.status).toBe('AVAILABLE');
    expect(result.providerStatus).toBe('AVAILABLE');
    expect(result.providerAvailable).toBe(true);
    expect(result.resultCount).toBe(1);
    expect(result.freshness).toBe('indexed');
    expect(result.matches[0]?.id).toBe('doc-1');

    const report = await engine.describeCapabilities({
      correlationId: 'corr-cap-live-providers',
    });
    const byId = new Map(report.capabilities.map((entry) => [entry.descriptor.capabilityId, entry]));

    expect(byId.get('embedding')?.descriptor.runtimeState).toBe('shipped');
    expect(byId.get('embedding')?.descriptor.defaultBinding).toBe('noop');
    expect(byId.get('vectorStore')?.descriptor.runtimeState).toBe('shipped');
    expect(byId.get('vectorStore')?.descriptor.defaultBinding).toBe('noop');
    expect(byId.get('semanticSearch')?.descriptor.runtimeState).toBe('degraded');
    expect(byId.get('semanticSearch')?.descriptor.defaultBinding).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// t-034: hashing text embedding — deterministic reference adapter
// ---------------------------------------------------------------------------

describe('t-034 — createHashingTextEmbedding', () => {
  it('returns a fixed-dimension vector matching the requested size', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 32 });
    const vec = await embed.embed('alpha beta gamma');
    expect(vec).toHaveLength(32);
  });

  it('is deterministic — the same input produces the same vector', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 64 });
    const a = await embed.embed('hello world');
    const b = await embed.embed('hello world');
    expect(a).toEqual(b);
  });

  it('produces L2-normalised (unit-length) vectors for non-empty inputs', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 64 });
    const vec = await embed.embed('token token2 token3');
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('produces a zero vector for strings with no tokens', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 32 });
    const vec = await embed.embed('!!! --- ???');
    expect(vec.every((x) => x === 0)).toBe(true);
  });

  it('does not collapse ordinary tokenized input to the zero vector', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 64 });
    const vec = await embed.embed('alpha authentication login token');
    expect(vec.some((x) => x !== 0)).toBe(true);
  });

  it('rejects non-positive or non-integer dimensions at construction', () => {
    expect(() => createHashingTextEmbedding({ dimensions: 0 })).toThrow();
    expect(() => createHashingTextEmbedding({ dimensions: -8 })).toThrow();
    expect(() => createHashingTextEmbedding({ dimensions: 3.5 })).toThrow();
  });

  it('shares token overlap → non-zero dot product between related strings', async () => {
    const embed = createHashingTextEmbedding({ dimensions: 64 });
    const a = await embed.embed('semantic search vector retrieval');
    const b = await embed.embed('semantic search embedding');
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    expect(dot).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// t-034: in-memory vector store — deterministic reference adapter
// ---------------------------------------------------------------------------

describe('t-034 — createInMemoryVectorStore', () => {
  it('upsert + search returns the inserted record ranked by cosine similarity', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'a', vector: [1, 0, 0], metadata: {} });
    await store.upsert({ id: 'b', vector: [0, 1, 0], metadata: {} });
    await store.upsert({ id: 'c', vector: [0, 0, 1], metadata: {} });

    const results = await store.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('a');
    expect(results[0]?.score).toBeGreaterThan(results[1]!.score);
  });

  it('honours topK: returns at most K results', async () => {
    const store = createInMemoryVectorStore();
    for (let i = 0; i < 10; i++) {
      await store.upsert({ id: `v${i}`, vector: [i + 1, 1, 0], metadata: {} });
    }
    const results = await store.search([1, 1, 0], 3);
    expect(results).toHaveLength(3);
  });

  it('applies the metadata-equality filter', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'a', vector: [1, 0, 0], metadata: { projectId: 'x' } });
    await store.upsert({ id: 'b', vector: [1, 0, 0], metadata: { projectId: 'y' } });

    const results = await store.search([1, 0, 0], 10, { projectId: 'x' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('a');
  });

  it('delete removes a record from subsequent searches', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'gone', vector: [1, 0, 0], metadata: {} });
    await store.delete('gone');
    const results = await store.search([1, 0, 0], 5);
    expect(results).toHaveLength(0);
  });

  it('breaks score ties deterministically on id (ascending)', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'zeta', vector: [1, 0, 0], metadata: {} });
    await store.upsert({ id: 'alpha', vector: [1, 0, 0], metadata: {} });
    await store.upsert({ id: 'mu', vector: [1, 0, 0], metadata: {} });

    const results = await store.search([1, 0, 0], 3);
    expect(results.map((r) => r.id)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('upsert replaces prior vector/metadata for the same id', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'x', vector: [1, 0], metadata: { v: 1 } });
    await store.upsert({ id: 'x', vector: [0, 1], metadata: { v: 2 } });

    const results = await store.search([0, 1], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.metadata.v).toBe(2);
  });

  it('returns empty results for empty query or empty store', async () => {
    const emptyStore = createInMemoryVectorStore();
    expect(await emptyStore.search([1, 0], 3)).toEqual([]);

    const store = createInMemoryVectorStore();
    await store.upsert({ id: 'a', vector: [1, 0], metadata: {} });
    expect(await store.search([], 3)).toEqual([]);
  });

  it('clones records on upsert — caller mutation does not bleed into state', async () => {
    const store = createInMemoryVectorStore();
    const metadata: Record<string, string | number | boolean> = { projectId: 'p' };
    const vector = [1, 0, 0];
    await store.upsert({ id: 'a', vector, metadata });

    metadata.projectId = 'tampered';
    vector[0] = 99;

    const results = await store.search([1, 0, 0], 1);
    expect(results[0]?.metadata.projectId).toBe('p');
  });
});
