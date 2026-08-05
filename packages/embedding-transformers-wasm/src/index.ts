import { describeArtifactState, hasLocalRuntimeAssets } from './artifacts.js';
import { embedOneWithTimeout } from './embedOne.js';
import { loadPipelineWithTimeout } from './loading.js';
import { computeEmbeddingProfileHash } from './profile.js';
import { unavailableResult, resultStatus } from './result.js';
import { baseDescription, createAdapterState } from './state.js';
import {
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  type EmbeddingAdapterDescription,
  type TransformersWasmEmbedResult,
  type TransformersWasmEmbedResultItem,
  type TransformersWasmEmbeddingAdapter,
  type TransformersWasmEmbeddingOptions,
} from './types.js';
import {
  throwIfAborted,
  validateCorrelationId,
  validateEmbedRequest,
} from './validation.js';

export type {
  ArtifactKind,
  ArtifactStatus,
  ArtifactVerificationInput,
  ArtifactVerificationResult,
  ArtifactVerifier,
  EmbeddingAdapterDescription,
  EmbeddingAdapterDescribeRequest,
  EmbeddingAdapterContractVersion,
  EmbedInput,
  EmbedInputStatus,
  EmbedProviderStatus,
  EmbedPurpose,
  ModelLoadStatus,
  TransformersEnvironment,
  TransformersFeaturePipeline,
  TransformersModule,
  TransformersModuleLoader,
  TransformersWasmBackendProfile,
  TransformersWasmEmbedRequest,
  TransformersWasmEmbedResult,
  TransformersWasmEmbedResultItem,
  TransformersWasmEmbeddingAdapter,
  TransformersWasmEmbeddingOptions,
  TransformersWasmPooling,
  TransformersWasmRuntimeProfile,
} from './types.js';
export { computeEmbeddingProfileHash } from './profile.js';
export {
  createTransformersWasmHoplonEmbedding,
  type HoplonEmbeddingAdapter,
  type TransformersWasmHoplonEmbeddingOptions,
} from './hoplonAdapter.js';
export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CORPUS_SCHEMA_VERSION,
  DEFAULT_DIMENSIONS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MODEL_ID,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSFORMERS_PACKAGE_VERSION,
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
} from './types.js';

export function createTransformersWasmEmbedding(
  options: TransformersWasmEmbeddingOptions = {},
): TransformersWasmEmbeddingAdapter {
  const state = createAdapterState(options);

  return {
    async describe(req, signal): Promise<EmbeddingAdapterDescription> {
      validateCorrelationId(req.correlationId, 'describe');
      throwIfAborted(signal);
      const artifactState = await describeArtifactState(
        options,
        req.verifyArtifacts === true,
      );
      const description = baseDescription(
        state,
        artifactState.status,
        state.modelLoadStatus,
        artifactState.degradationReasons,
      );
      return {
        ...description,
        embeddingProfileHash: computeEmbeddingProfileHash(description),
      };
    },

    async embed(req, signal): Promise<TransformersWasmEmbedResult> {
      validateEmbedRequest(req);
      throwIfAborted(signal);

      if (!hasLocalRuntimeAssets(options)) {
        return unavailableResult(state, req, 'local_model_assets_missing');
      }

      const timeoutMs = req.timeoutMs ?? state.timeoutMs;
      const loaded = await loadPipelineWithTimeout(state, timeoutMs, signal);
      if (loaded.status !== 'loaded') {
        return unavailableResult(
          state,
          req,
          loaded.reason ?? 'model_unavailable',
          loaded.timedOut ? req.inputs.length : 0,
          loaded.coldStartMs,
        );
      }

      const results: TransformersWasmEmbedResultItem[] = [];
      let timeoutCount = 0;
      let documentsDeferred = 0;

      for (const input of req.inputs) {
        throwIfAborted(signal);
        if (input.text.trim().length === 0) {
          documentsDeferred += 1;
          results.push({
            inputId: input.inputId,
            status: 'skipped',
            degradationReason: 'empty_input_skipped',
          });
          continue;
        }

        const embedded = await embedOneWithTimeout(state, input.text, timeoutMs);
        if (embedded.status === 'embedded') {
          results.push({
            inputId: input.inputId,
            status: 'embedded',
            vector: embedded.vector,
          });
          continue;
        }

        documentsDeferred += 1;
        if (embedded.status === 'timeout') timeoutCount += 1;
        results.push({
          inputId: input.inputId,
          status: embedded.status,
          degradationReason: embedded.reason,
        });
      }

      const result: TransformersWasmEmbedResult = {
        contractVersion: EMBEDDING_ADAPTER_CONTRACT_VERSION,
        status: resultStatus(results),
        results,
        batchSizeUsed: state.batchSize,
        maxConcurrencyUsed: state.maxConcurrency,
        backpressureCount: 0,
        timeoutCount,
        documentsDeferred,
        persistentCacheWrites: 0,
        ...(documentsDeferred > 0
          ? { degradationReason: 'partial_embedding_degraded' }
          : {}),
      };
      if (loaded.coldStartMs !== undefined) {
        return { ...result, coldStartMs: loaded.coldStartMs };
      }
      return result;
    },
  };
}
