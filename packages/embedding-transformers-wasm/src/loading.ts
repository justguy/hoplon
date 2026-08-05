import type { AdapterState } from './state.js';
import { TimeoutError, withTimeout } from './timeout.js';
import type {
  TransformersFeaturePipeline,
  TransformersModule,
  TransformersWasmEmbeddingOptions,
} from './types.js';
import { throwIfAborted } from './validation.js';

export interface LoadResult {
  readonly status: 'loaded' | 'unavailable';
  readonly timedOut?: boolean;
  readonly reason?: string;
  readonly coldStartMs?: number;
}

export async function loadPipelineWithTimeout(
  state: AdapterState,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<LoadResult> {
  if (state.modelLoadStatus === 'loaded') return { status: 'loaded' };

  try {
    const startedAt = state.now();
    const pipeline = await withTimeout(
      ensurePipeline(state, signal),
      timeoutMs,
      'model_load_timeout',
    );
    state.coldStartMs = Math.max(0, state.now() - startedAt);
    state.modelLoadStatus = 'loaded';
    state.pipelinePromise = Promise.resolve(pipeline);
    return { status: 'loaded', coldStartMs: state.coldStartMs };
  } catch (error) {
    state.modelLoadStatus = 'unavailable';
    state.pipelinePromise = null;
    return {
      status: 'unavailable',
      timedOut: error instanceof TimeoutError,
      reason:
        error instanceof TimeoutError ? 'model_load_timeout' : 'model_load_failed',
    };
  }
}

async function ensurePipeline(
  state: AdapterState,
  signal: AbortSignal | undefined,
): Promise<TransformersFeaturePipeline> {
  if (state.pipelinePromise !== null) return state.pipelinePromise;
  state.pipelinePromise = (async () => {
    throwIfAborted(signal);
    const transformers = await state.loadTransformers();
    configureTransformers(transformers, state.options);
    throwIfAborted(signal);
    return transformers.pipeline('feature-extraction', state.modelId, {
      local_files_only: true,
      device: 'wasm',
    });
  })();
  return state.pipelinePromise;
}

function configureTransformers(
  transformers: TransformersModule,
  options: TransformersWasmEmbeddingOptions,
): void {
  transformers.env.allowRemoteModels = false;
  if (options.localModelPath !== undefined) {
    transformers.env.localModelPath = options.localModelPath;
  } else {
    delete transformers.env.localModelPath;
  }
  transformers.env.backends ??= {};
  transformers.env.backends.onnx ??= {};
  transformers.env.backends.onnx.wasm ??= {};
  if (options.wasmPaths !== undefined) {
    transformers.env.backends.onnx.wasm.wasmPaths = options.wasmPaths;
  } else {
    delete transformers.env.backends.onnx.wasm.wasmPaths;
  }
}
