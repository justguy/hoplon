import type { AdapterState } from './state.js';
import {
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  type EmbedProviderStatus,
  type TransformersWasmEmbedRequest,
  type TransformersWasmEmbedResult,
  type TransformersWasmEmbedResultItem,
} from './types.js';

export function unavailableResult(
  state: AdapterState,
  req: TransformersWasmEmbedRequest,
  reason: string,
  timeoutCount = 0,
  coldStartMs?: number,
): TransformersWasmEmbedResult {
  const results = req.inputs.map((input): TransformersWasmEmbedResultItem => ({
    inputId: input.inputId,
    status: timeoutCount > 0 ? 'timeout' : 'deferred',
    degradationReason: reason,
  }));
  const result: TransformersWasmEmbedResult = {
    contractVersion: EMBEDDING_ADAPTER_CONTRACT_VERSION,
    status: 'UNAVAILABLE',
    results,
    batchSizeUsed: state.batchSize,
    maxConcurrencyUsed: state.maxConcurrency,
    backpressureCount: 0,
    timeoutCount,
    documentsDeferred: req.inputs.length,
    persistentCacheWrites: 0,
    degradationReason: reason,
  };
  if (coldStartMs !== undefined) return { ...result, coldStartMs };
  return result;
}

export function resultStatus(
  results: readonly TransformersWasmEmbedResultItem[],
): EmbedProviderStatus {
  if (results.every((result) => result.status === 'embedded')) return 'AVAILABLE';
  if (results.some((result) => result.status === 'embedded')) return 'DEGRADED';
  return 'UNAVAILABLE';
}
