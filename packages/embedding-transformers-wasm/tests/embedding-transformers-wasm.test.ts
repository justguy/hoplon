import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  computeEmbeddingProfileHash,
  createTransformersWasmEmbedding,
  createTransformersWasmHoplonEmbedding,
  type ArtifactVerifier,
  type TransformersModule,
} from '../src/index.js';

function createFakeTransformers(
  vector: readonly number[] = [1, 2, 3, 4],
): { module: TransformersModule; pipelineCalls: string[] } {
  const pipelineCalls: string[] = [];
  const module: TransformersModule = {
    env: {},
    async pipeline(_task, model, options) {
      pipelineCalls.push(
        `${model}:${String(options.local_files_only)}:${options.device}`,
      );
      return async (_input, _options) => ({
        data: Float32Array.from(vector),
      });
    },
  };
  return { module, pipelineCalls };
}

describe('Transformers WASM embedding adapter', () => {
  it('describes the portable WASM profile without loading the model', async () => {
    const { module, pipelineCalls } = createFakeTransformers();
    const verifier: ArtifactVerifier = {
      async verify(input) {
        return { status: 'verified', sha256: input.expectedSha256 };
      },
    };
    const adapter = createTransformersWasmEmbedding({
      dimensions: 4,
      localModelPath: '/models/minilm',
      wasmPaths: '/models/wasm',
      modelArtifactPath: '/models/minilm/model.onnx',
      tokenizerArtifactPath: '/models/minilm/tokenizer.json',
      onnxWasmArtifactPath: '/models/wasm/ort-wasm.wasm',
      modelArtifactHash: 'sha256:model',
      tokenizerArtifactHash: 'sha256:tokenizer',
      onnxWasmArtifactHash: 'sha256:wasm',
      artifactVerifier: verifier,
      loadTransformers: async () => module,
    });

    const description = await adapter.describe({
      correlationId: 'corr-describe',
      verifyArtifacts: true,
    });

    expect(pipelineCalls).toEqual([]);
    expect(description).toMatchObject({
      contractVersion: 2,
      runtimeProfile: 'portable_wasm',
      backendProfile: 'onnxruntime-web-wasm',
      embeddingPackage: '@phalanx/hoplon-embedding-transformers-wasm',
      embeddingPackageVersion: '3.8.1',
      embeddingModelId: 'Xenova/all-MiniLM-L6-v2',
      modelArtifactHash: 'sha256:model',
      tokenizerArtifactHash: 'sha256:tokenizer',
      onnxRuntimeWebPackageVersion: '3.8.1',
      onnxWasmArtifactHash: 'sha256:wasm',
      onnxBackend: 'wasm',
      pooling: 'mean',
      normalize: true,
      dimensions: 4,
      artifactStatus: 'verified',
      modelLoadStatus: 'not_loaded',
      corpusSchemaVersion: 'semantic-corpus-v1',
      degradationReasons: [],
    });
    expect(description.embeddingProfileHash).toBe(
      computeEmbeddingProfileHash({
        ...description,
        embeddingProfileHash: undefined,
      }),
    );
  });

  it('disables remote fetches and configures local model/WASM paths before pipeline load', async () => {
    const { module, pipelineCalls } = createFakeTransformers([1, 0, 0, 0]);
    const adapter = createTransformersWasmEmbedding({
      dimensions: 4,
      localModelPath: '/local/model',
      wasmPaths: { 'ort-wasm.wasm': '/local/wasm/ort-wasm.wasm' },
      loadTransformers: async () => module,
      now: vi
        .fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(175),
    });

    const result = await adapter.embed({
      contractVersion: EMBEDDING_ADAPTER_CONTRACT_VERSION,
      correlationId: 'corr-embed',
      inputs: [{ inputId: 'doc-1', text: 'semantic search' }],
      purpose: 'index',
    });

    expect(module.env.allowRemoteModels).toBe(false);
    expect(module.env.localModelPath).toBe('/local/model');
    expect(module.env.backends?.onnx?.wasm?.wasmPaths).toEqual({
      'ort-wasm.wasm': '/local/wasm/ort-wasm.wasm',
    });
    expect(pipelineCalls).toEqual(['Xenova/all-MiniLM-L6-v2:true:wasm']);
    expect(result).toMatchObject({
      contractVersion: 2,
      status: 'AVAILABLE',
      coldStartMs: 75,
      batchSizeUsed: 16,
      maxConcurrencyUsed: 1,
      backpressureCount: 0,
      timeoutCount: 0,
      documentsDeferred: 0,
      persistentCacheWrites: 0,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      inputId: 'doc-1',
      status: 'embedded',
    });
    expect(result.results[0]?.vector).toEqual([1, 0, 0, 0]);
  });

  it('degrades without loading Transformers when local assets are missing', async () => {
    const loadTransformers = vi.fn<[], Promise<TransformersModule>>();
    const adapter = createTransformersWasmEmbedding({
      dimensions: 4,
      loadTransformers,
    });

    const description = await adapter.describe({
      correlationId: 'corr-missing',
      verifyArtifacts: true,
    });
    const result = await adapter.embed({
      contractVersion: 2,
      correlationId: 'corr-missing-embed',
      inputs: [
        { inputId: 'doc-1', text: 'semantic search' },
        { inputId: 'doc-2', text: 'vector index' },
      ],
    });

    expect(loadTransformers).not.toHaveBeenCalled();
    expect(description.artifactStatus).toBe('missing');
    expect(description.degradationReasons).toEqual(['local_model_assets_missing']);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.degradationReason).toBe('local_model_assets_missing');
    expect(result.documentsDeferred).toBe(2);
    expect(result.results.map((item) => item.status)).toEqual(['deferred', 'deferred']);
  });

  it('bridges the batch adapter to Hoplon core EmbeddingAdapter shape', async () => {
    const { module } = createFakeTransformers([0.5, 0.5, 0.5, 0.5]);
    const batchAdapter = createTransformersWasmEmbedding({
      dimensions: 4,
      localModelPath: '/local/model',
      wasmPaths: '/local/wasm',
      loadTransformers: async () => module,
    });
    const hoplonAdapter = createTransformersWasmHoplonEmbedding(batchAdapter, {
      correlationId: 'corr-hoplon-bridge',
      purpose: 'index',
    });

    await expect(hoplonAdapter.embed('semantic runtime bridge')).resolves.toEqual([
      0.5, 0.5, 0.5, 0.5,
    ]);
  });

  it('reports per-input skipped/degraded results without persistent cache writes', async () => {
    const { module } = createFakeTransformers([1, 1, 1, 1]);
    const adapter = createTransformersWasmEmbedding({
      dimensions: 4,
      localModelPath: '/local/model',
      wasmPaths: '/local/wasm',
      loadTransformers: async () => module,
    });

    const result = await adapter.embed({
      contractVersion: 2,
      correlationId: 'corr-partial',
      inputs: [
        { inputId: 'empty', text: '   ' },
        { inputId: 'query', text: 'find search code' },
      ],
      purpose: 'query',
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.documentsDeferred).toBe(1);
    expect(result.persistentCacheWrites).toBe(0);
    expect(result.results).toMatchObject([
      {
        inputId: 'empty',
        status: 'skipped',
        degradationReason: 'empty_input_skipped',
      },
      { inputId: 'query', status: 'embedded' },
    ]);
  });

  it('times out model loading with classified per-input timeout results', async () => {
    const adapter = createTransformersWasmEmbedding({
      dimensions: 4,
      localModelPath: '/local/model',
      wasmPaths: '/local/wasm',
      timeoutMs: 1,
      loadTransformers: async () =>
        new Promise<TransformersModule>(() => {
          // Intentionally unresolved.
        }),
    });

    const result = await adapter.embed({
      contractVersion: 2,
      correlationId: 'corr-timeout',
      inputs: [{ inputId: 'doc-1', text: 'semantic search' }],
      timeoutMs: 1,
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.degradationReason).toBe('model_load_timeout');
    expect(result.timeoutCount).toBe(1);
    expect(result.documentsDeferred).toBe(1);
    expect(result.results).toEqual([
      {
        inputId: 'doc-1',
        status: 'timeout',
        degradationReason: 'model_load_timeout',
      },
    ]);
  });
});
