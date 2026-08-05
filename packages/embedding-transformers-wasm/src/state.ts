import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CORPUS_SCHEMA_VERSION,
  DEFAULT_DIMENSIONS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MODEL_ID,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSFORMERS_PACKAGE_VERSION,
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  type EmbeddingAdapterDescription,
  type ModelLoadStatus,
  type TransformersFeaturePipeline,
  type TransformersModule,
  type TransformersModuleLoader,
  type TransformersWasmEmbeddingOptions,
} from './types.js';

export interface AdapterState {
  readonly modelId: string;
  readonly transformersPackageVersion: string;
  readonly onnxRuntimeWebPackageVersion: string;
  readonly dimensions: number;
  readonly pooling: 'mean' | 'cls';
  readonly normalize: boolean;
  readonly timeoutMs: number;
  readonly batchSize: number;
  readonly maxConcurrency: number;
  readonly corpusSchemaVersion: string;
  readonly now: () => number;
  readonly loadTransformers: TransformersModuleLoader;
  readonly options: TransformersWasmEmbeddingOptions;
  pipelinePromise: Promise<TransformersFeaturePipeline> | null;
  modelLoadStatus: ModelLoadStatus;
  coldStartMs: number | undefined;
}

export function createAdapterState(
  options: TransformersWasmEmbeddingOptions,
): AdapterState {
  return {
    modelId: options.modelId ?? DEFAULT_MODEL_ID,
    transformersPackageVersion:
      options.transformersPackageVersion ?? DEFAULT_TRANSFORMERS_PACKAGE_VERSION,
    onnxRuntimeWebPackageVersion:
      options.onnxRuntimeWebPackageVersion ?? DEFAULT_TRANSFORMERS_PACKAGE_VERSION,
    dimensions: options.dimensions ?? DEFAULT_DIMENSIONS,
    pooling: options.pooling ?? 'mean',
    normalize: options.normalize ?? true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    maxConcurrency: options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    corpusSchemaVersion:
      options.corpusSchemaVersion ?? DEFAULT_CORPUS_SCHEMA_VERSION,
    now: options.now ?? Date.now,
    loadTransformers: options.loadTransformers ?? loadDefaultTransformers,
    options,
    pipelinePromise: null,
    modelLoadStatus: 'not_loaded',
    coldStartMs: undefined,
  };
}

export function baseDescription(
  state: AdapterState,
  artifactStatus: EmbeddingAdapterDescription['artifactStatus'],
  modelLoadStatus: ModelLoadStatus,
  degradationReasons: string[],
): Omit<EmbeddingAdapterDescription, 'embeddingProfileHash'> {
  return {
    contractVersion: EMBEDDING_ADAPTER_CONTRACT_VERSION,
    runtimeProfile: 'portable_wasm',
    backendProfile: 'onnxruntime-web-wasm',
    embeddingPackage: '@phalanx/hoplon-embedding-transformers-wasm',
    embeddingPackageVersion: state.transformersPackageVersion,
    embeddingModelId: state.modelId,
    onnxRuntimeWebPackageVersion: state.onnxRuntimeWebPackageVersion,
    onnxBackend: 'wasm',
    pooling: state.pooling,
    normalize: state.normalize,
    dimensions: state.dimensions,
    artifactStatus,
    modelLoadStatus,
    corpusSchemaVersion: state.corpusSchemaVersion,
    degradationReasons,
    ...(state.options.modelArtifactHash !== undefined
      ? { modelArtifactHash: state.options.modelArtifactHash }
      : {}),
    ...(state.options.tokenizerArtifactHash !== undefined
      ? { tokenizerArtifactHash: state.options.tokenizerArtifactHash }
      : {}),
    ...(state.options.onnxWasmArtifactHash !== undefined
      ? { onnxWasmArtifactHash: state.options.onnxWasmArtifactHash }
      : {}),
    ...(state.coldStartMs !== undefined ? { coldStartMs: state.coldStartMs } : {}),
  };
}

async function loadDefaultTransformers(): Promise<TransformersModule> {
  return import('@huggingface/transformers');
}
