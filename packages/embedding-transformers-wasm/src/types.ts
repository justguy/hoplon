export const EMBEDDING_ADAPTER_CONTRACT_VERSION = 2 as const;
export const DEFAULT_TRANSFORMERS_PACKAGE_VERSION = '3.8.1';
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DIMENSIONS = 384;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 16;
export const DEFAULT_MAX_CONCURRENCY = 1;
export const DEFAULT_CORPUS_SCHEMA_VERSION = 'semantic-corpus-v1';

export type EmbeddingAdapterContractVersion =
  typeof EMBEDDING_ADAPTER_CONTRACT_VERSION;
export type TransformersWasmRuntimeProfile = 'portable_wasm';
export type TransformersWasmBackendProfile = 'onnxruntime-web-wasm';
export type TransformersWasmPooling = 'mean' | 'cls';
export type ArtifactStatus =
  | 'verified'
  | 'missing'
  | 'unverified'
  | 'not_loaded';
export type ModelLoadStatus =
  | 'not_loaded'
  | 'loaded'
  | 'degraded'
  | 'unavailable';
export type EmbedInputStatus = 'embedded' | 'deferred' | 'timeout' | 'skipped';
export type EmbedProviderStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
export type EmbedPurpose = 'index' | 'query' | 'dry_run';

export interface TransformersEnvironment {
  allowRemoteModels?: boolean;
  localModelPath?: string;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: string | Record<string, string>;
      };
    };
  };
}

export interface TransformersModule {
  readonly env: TransformersEnvironment;
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { local_files_only: true; device: 'wasm' },
  ): Promise<TransformersFeaturePipeline>;
}

export type TransformersFeaturePipeline = (
  input: string,
  options: { pooling: TransformersWasmPooling; normalize: boolean },
) => Promise<unknown>;

export type TransformersModuleLoader = () => Promise<TransformersModule>;

export type ArtifactKind = 'model' | 'tokenizer' | 'onnx_wasm';

export interface ArtifactVerificationInput {
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly expectedSha256: string;
}

export interface ArtifactVerificationResult {
  readonly status: Exclude<ArtifactStatus, 'not_loaded'>;
  readonly sha256?: string;
  readonly degradationReason?: string;
}

export interface ArtifactVerifier {
  verify(input: ArtifactVerificationInput): Promise<ArtifactVerificationResult>;
}

export interface TransformersWasmEmbeddingOptions {
  readonly modelId?: string;
  readonly localModelPath?: string;
  readonly wasmPaths?: string | Record<string, string>;
  readonly modelArtifactPath?: string;
  readonly tokenizerArtifactPath?: string;
  readonly onnxWasmArtifactPath?: string;
  readonly modelArtifactHash?: string;
  readonly tokenizerArtifactHash?: string;
  readonly onnxWasmArtifactHash?: string;
  readonly onnxRuntimeWebPackageVersion?: string;
  readonly transformersPackageVersion?: string;
  readonly dimensions?: number;
  readonly pooling?: TransformersWasmPooling;
  readonly normalize?: boolean;
  readonly timeoutMs?: number;
  readonly batchSize?: number;
  readonly maxConcurrency?: number;
  readonly corpusSchemaVersion?: string;
  readonly loadTransformers?: TransformersModuleLoader;
  readonly artifactVerifier?: ArtifactVerifier;
  readonly now?: () => number;
}

export interface EmbeddingAdapterDescribeRequest {
  readonly correlationId: string;
  readonly verifyArtifacts?: boolean;
}

export interface EmbeddingAdapterDescription {
  readonly contractVersion: EmbeddingAdapterContractVersion;
  readonly runtimeProfile: TransformersWasmRuntimeProfile;
  readonly backendProfile: TransformersWasmBackendProfile;
  readonly embeddingPackage: '@phalanx/hoplon-embedding-transformers-wasm';
  readonly embeddingPackageVersion: string;
  readonly embeddingModelId: string;
  readonly modelArtifactHash?: string;
  readonly tokenizerArtifactHash?: string;
  readonly onnxRuntimeWebPackageVersion?: string;
  readonly onnxWasmArtifactHash?: string;
  readonly onnxBackend: 'wasm';
  readonly pooling: TransformersWasmPooling;
  readonly normalize: boolean;
  readonly dimensions: number;
  readonly artifactStatus: ArtifactStatus;
  readonly modelLoadStatus: ModelLoadStatus;
  readonly coldStartMs?: number;
  readonly embeddingProfileHash: string;
  readonly corpusSchemaVersion: string;
  readonly degradationReasons: string[];
}

export interface EmbedInput {
  readonly inputId: string;
  readonly text: string;
}

export interface TransformersWasmEmbedRequest {
  readonly contractVersion: EmbeddingAdapterContractVersion;
  readonly correlationId: string;
  readonly inputs: readonly EmbedInput[];
  readonly purpose?: EmbedPurpose;
  readonly timeoutMs?: number;
}

export interface TransformersWasmEmbedResultItem {
  readonly inputId: string;
  readonly status: EmbedInputStatus;
  readonly vector?: number[];
  readonly degradationReason?: string;
}

export interface TransformersWasmEmbedResult {
  readonly contractVersion: EmbeddingAdapterContractVersion;
  readonly status: EmbedProviderStatus;
  readonly results: TransformersWasmEmbedResultItem[];
  readonly coldStartMs?: number;
  readonly batchSizeUsed: number;
  readonly maxConcurrencyUsed: number;
  readonly backpressureCount: number;
  readonly timeoutCount: number;
  readonly documentsDeferred: number;
  readonly persistentCacheWrites: 0;
  readonly degradationReason?: string;
}

export interface TransformersWasmEmbeddingAdapter {
  describe(
    req: EmbeddingAdapterDescribeRequest,
    signal?: AbortSignal,
  ): Promise<EmbeddingAdapterDescription>;
  embed(
    req: TransformersWasmEmbedRequest,
    signal?: AbortSignal,
  ): Promise<TransformersWasmEmbedResult>;
}
