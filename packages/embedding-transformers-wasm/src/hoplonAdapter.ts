import {
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  type EmbedPurpose,
  type TransformersWasmEmbeddingAdapter,
} from './types.js';

export interface HoplonEmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}

export interface TransformersWasmHoplonEmbeddingOptions {
  readonly correlationId?: string;
  readonly purpose?: EmbedPurpose;
  readonly timeoutMs?: number;
}

const DEFAULT_CORRELATION_ID = 'transformers-wasm-hoplon-embedding';

export function createTransformersWasmHoplonEmbedding(
  adapter: TransformersWasmEmbeddingAdapter,
  options: TransformersWasmHoplonEmbeddingOptions = {},
): HoplonEmbeddingAdapter {
  return {
    async embed(text: string): Promise<number[]> {
      const result = await adapter.embed({
        contractVersion: EMBEDDING_ADAPTER_CONTRACT_VERSION,
        correlationId: options.correlationId ?? DEFAULT_CORRELATION_ID,
        inputs: [{ inputId: 'input-0', text }],
        ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const item = result.results.find((entry) => entry.inputId === 'input-0');
      if (item?.status !== 'embedded' || item.vector === undefined) {
        return [];
      }
      return [...item.vector];
    },
  };
}
