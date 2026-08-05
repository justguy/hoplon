import { describe, expect, it } from 'vitest';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import { createNoopAnalyzer } from '../../src/hoplon/adapters/staticAnalysis/noop.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { LockProvider } from '../../src/hoplon/adapters/lock.js';
import type { SecretScannerAdapter } from '../../src/hoplon/adapters/secretScanner.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { health, type HealthDeps } from '../../src/hoplon/operations/health.js';
import { createInMemorySemanticSessionOverlayStore } from '../../src/hoplon/operations/semanticSearch.js';

describe('health adapter probes (F3 — real probing)', () => {
  it('reports ok for healthy versioning + codeIntelligence adapters', async () => {
    const result = await health(makeDeps());
    expect(result.adapters.versioning).toBe('ok');
    expect(result.adapters.codeIntelligence).toBe('ok');
  });

  it('reports non-ok for a versioning adapter whose probe throws', async () => {
    const result = await health(
      makeDeps({
        versioning: {
          async resolveCurrentBranch() {
            throw new Error('versioning backend unreachable');
          },
        } as unknown as VersioningAdapter,
      }),
    );
    expect(result.adapters.versioning).not.toBe('ok');
  });

  it('reports non-ok for a codeIntelligence adapter whose probe throws', async () => {
    const result = await health(
      makeDeps({
        codeIntelligence: {
          async parse() {
            throw new Error('parser/grammars not loaded');
          },
          getTopLevelSymbols() {
            return [];
          },
        } as unknown as CodeIntelligenceAdapter,
      }),
    );
    expect(result.adapters.codeIntelligence).not.toBe('ok');
  });
});

describe('health semantic block', () => {
  it('reports noop semantic providers as seam-only and unavailable', async () => {
    const result = await health(makeDeps());

    expect(result.semantic.status).toBe('UNAVAILABLE');
    expect(result.semantic.capabilityClass).toBe('seam_only');
    expect(result.semantic.runtimeProfile).toBe('noop');
    expect(result.semantic.adapters.embedding).toBe('noop');
    expect(result.semantic.degradationReasons).toEqual([
      'semantic_storage_profile_unavailable',
      'embedding_provider_not_bound',
      'vector_provider_not_bound',
    ]);
  });

  it('reports advisory-ready only for live providers with available storage profile', async () => {
    const result = await health(makeDeps({
      embeddingProvided: true,
      vectorStoreProvided: true,
      embeddingCacheProvided: true,
      semanticIndexStoreProvided: true,
      semanticStorageProfileProvided: true,
      semanticStorageProfile: {
        async describe() {
          return {
            kind: 'wasm_sqlite_fts_vector',
            status: 'AVAILABLE',
            durableLexical: true,
            durableVector: true,
            nativeRuntime: false,
            degradationReasons: [],
          };
        },
      },
    }));

    expect(result.semantic.status).toBe('AVAILABLE');
    expect(result.semantic.capabilityClass).toBe('advisory_ready');
    expect(result.semantic.runtimeProfile).toBe('portable_wasm');
    expect(result.semantic.persistenceMode).toBe('host_snapshot_storage');
    expect(result.semantic.cache.reachable).toBe(true);
    expect(result.semantic.index.reachable).toBe(true);
    expect(JSON.stringify(result.semantic)).not.toContain('src/');
  });

  it('reports hash-only mode as disabled', async () => {
    const result = await health(makeDeps({
      manifestStorageMode: 'hash_only',
      embeddingProvided: true,
      vectorStoreProvided: true,
    }));

    expect(result.semantic.status).toBe('UNAVAILABLE');
    expect(result.semantic.capabilityClass).toBe('disabled');
    expect(result.semantic.runtimeProfile).toBe('hash_only_disabled');
    expect(result.semantic.persistenceMode).toBe('hash_only_disabled');
    expect(result.semantic.degradationReasons).toContain('hash_only_manifest_storage');
  });
});

function makeDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    fs: createMemFsAdapter(),
    versioning: {
      // Healthy adapter: an uninitialized repo resolves to null without throwing
      // (mirrors the real isomorphic-git adapter's resolveCurrentBranch contract).
      async resolveCurrentBranch() {
        return null;
      },
    } as unknown as VersioningAdapter,
    snapshotStore: {
      async listPending() {
        return [];
      },
      async gc() {
        return { deletedCount: 0 };
      },
    } as unknown as SnapshotStore,
    lockProvider: {
      async acquire() {
        return () => {};
      },
    } as LockProvider,
    emitter: createMemoryEmitter(),
    codeIntelligence: {
      async parse() {
        return { rootNode: { kind: 'program', children: [] } };
      },
      getTopLevelSymbols() {
        return [];
      },
    } as CodeIntelligenceAdapter,
    secretScanner: {
      async scan() {
        return [];
      },
    } as SecretScannerAdapter,
    staticAnalysis: createNoopAnalyzer(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    embeddingProvided: false,
    vectorStoreProvided: false,
    embeddingCacheProvided: false,
    semanticIndexStoreProvided: false,
    lexicalIndexProvided: false,
    vectorIndexProvided: false,
    semanticStorageProfileProvided: false,
    sessionOverlayStore: createInMemorySemanticSessionOverlayStore(),
    engineId: 'health-test',
    startedAt: Date.now() - 1,
    gitRepoDir: '.hoplon/repo',
    ...overrides,
  };
}
