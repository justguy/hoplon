/**
 * Contract tests for EngineHealth schema.
 *
 * A3.1 update: adapters keys expanded from 4 to 8
 * (was: fs, gitAdapter, snapshotStore, lockProvider)
 * (now: fs, versioning, snapshotStore, lockProvider, emitter, codeIntelligence, secretScanner, staticAnalysis)
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EngineHealthSchema } from '../../src/hoplon/contracts/health.js';

const VALID_HEALTH = {
  engineId: 'local-0',
  adapters: {
    fs: 'ok',
    versioning: 'ok',
    snapshotStore: 'ok',
    lockProvider: 'ok',
    emitter: 'ok',
    codeIntelligence: 'ok',
    secretScanner: 'ok',
    staticAnalysis: 'ok',
  },
  semantic: {
    status: 'UNAVAILABLE',
    capabilityClass: 'seam_only',
    runtimeProfile: 'noop',
    persistenceMode: 'process_local_overlay',
    adapters: {
      embedding: 'noop',
      vectorStore: 'noop',
      embeddingCache: 'noop',
      semanticIndexStore: 'noop',
      lexicalIndex: 'noop',
      vectorIndex: 'noop',
      semanticStorageProfile: 'noop',
    },
    embedding: {
      modelStatus: 'missing',
      artifactStatus: 'missing',
    },
    runtimeArtifacts: {
      nativeExtensionStatus: 'unavailable',
    },
    cache: { reachable: false },
    index: { reachable: false },
    overlays: {
      activeOverlayCount: 0,
      reapedOverlayCount: 0,
      documentCount: 0,
      vectorCount: 0,
      maskCount: 0,
    },
    tombstones: { reachable: false },
    degradationReasons: [
      'semantic_storage_profile_unavailable',
      'embedding_provider_not_bound',
      'vector_provider_not_bound',
    ],
  },
  uptimeMs: 12345,
};

describe('EngineHealth', () => {
  it('accepts valid health with all 8 adapters ok', () => {
    expect(EngineHealthSchema.safeParse(VALID_HEALTH).success).toBe(true);
  });

  it('accepts degraded and failed adapter statuses', () => {
    const result = EngineHealthSchema.safeParse({
      ...VALID_HEALTH,
      adapters: {
        ...VALID_HEALTH.adapters,
        versioning: 'degraded',
        snapshotStore: 'failed',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid adapter status', () => {
    expect(
      EngineHealthSchema.safeParse({
        ...VALID_HEALTH,
        adapters: { ...VALID_HEALTH.adapters, fs: 'unknown' },
      }).success,
    ).toBe(false);
  });

  it('rejects negative uptimeMs', () => {
    expect(
      EngineHealthSchema.safeParse({ ...VALID_HEALTH, uptimeMs: -1 }).success,
    ).toBe(false);
  });

  it('rejects missing engineId', () => {
    const { engineId: _e, ...without } = VALID_HEALTH;
    expect(EngineHealthSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing adapter key (emitter)', () => {
    const { emitter: _e, ...adaptersWithout } = VALID_HEALTH.adapters;
    expect(
      EngineHealthSchema.safeParse({
        ...VALID_HEALTH,
        adapters: adaptersWithout,
      }).success,
    ).toBe(false);
  });

  it('rejects missing adapter key (versioning)', () => {
    const { versioning: _v, ...adaptersWithout } = VALID_HEALTH.adapters;
    expect(
      EngineHealthSchema.safeParse({
        ...VALID_HEALTH,
        adapters: adaptersWithout,
      }).success,
    ).toBe(false);
  });

  it('rejects missing adapter key (codeIntelligence)', () => {
    const { codeIntelligence: _c, ...adaptersWithout } = VALID_HEALTH.adapters;
    expect(
      EngineHealthSchema.safeParse({
        ...VALID_HEALTH,
        adapters: adaptersWithout,
      }).success,
    ).toBe(false);
  });

  it('accepts semantic health with artifact hashes and overlay counts', () => {
    const result = EngineHealthSchema.safeParse({
      ...VALID_HEALTH,
      semantic: {
        ...VALID_HEALTH.semantic,
        status: 'DEGRADED',
        capabilityClass: 'degraded',
        runtimeProfile: 'portable_wasm',
        persistenceMode: 'host_snapshot_storage',
        embedding: {
          modelStatus: 'available',
          artifactStatus: 'available',
          modelHash: 'model-sha',
          artifactHash: 'artifact-sha',
        },
        runtimeArtifacts: {
          onnxHash: 'onnx-sha',
          wasmHash: 'wasm-sha',
          nativeExtensionStatus: 'loaded',
          nativeExtensionHash: 'native-sha',
        },
        cache: { reachable: true, entryCount: 3 },
        index: {
          reachable: true,
          documentCount: 7,
          lastIndexedAt: '2026-05-08T00:00:00.000Z',
        },
        overlays: {
          activeOverlayCount: 1,
          reapedOverlayCount: 2,
          documentCount: 3,
          vectorCount: 1,
          maskCount: 4,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(EngineHealthSchema, 'EngineHealth');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(50);
  });
});
