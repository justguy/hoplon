import type { AdapterState } from './state.js';
import { TimeoutError, withTimeout } from './timeout.js';

export type OneEmbeddingResult =
  | { readonly status: 'embedded'; readonly vector: number[] }
  | { readonly status: 'timeout' | 'deferred'; readonly reason: string };

export async function embedOneWithTimeout(
  state: AdapterState,
  text: string,
  timeoutMs: number,
): Promise<OneEmbeddingResult> {
  try {
    const pipeline = await state.pipelinePromise;
    if (pipeline === null) {
      return { status: 'deferred', reason: 'model_not_loaded' };
    }
    const output = await withTimeout(
      pipeline(text, { pooling: state.pooling, normalize: state.normalize }),
      timeoutMs,
      'embedding_timeout',
    );
    const vector = normalizeVector(extractVector(output));
    if (vector.length !== state.dimensions) {
      return { status: 'deferred', reason: 'embedding_dimensions_mismatch' };
    }
    return { status: 'embedded', vector };
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { status: 'timeout', reason: 'embedding_timeout' };
    }
    return { status: 'deferred', reason: 'embedding_failed' };
  }
}

function extractVector(output: unknown): number[] {
  if (Array.isArray(output)) return flattenNumericArray(output);
  if (isTensorLike(output)) {
    return Array.from(output.data).map(Number);
  }
  if (isTensorContainer(output) && isTensorLike(output.tensor)) {
    return Array.from(output.tensor.data).map(Number);
  }
  return [];
}

function flattenNumericArray(value: unknown[]): number[] {
  const flattened: number[] = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      flattened.push(...flattenNumericArray(entry));
    } else if (typeof entry === 'number') {
      flattened.push(entry);
    }
  }
  return flattened;
}

function normalizeVector(vector: number[]): number[] {
  if (vector.length === 0) return [];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function isTensorLike(value: unknown): value is { data: Iterable<number> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.iterator in Object((value as { data?: unknown }).data)
  );
}

function isTensorContainer(
  value: unknown,
): value is { tensor: { data: Iterable<number> } } {
  return typeof value === 'object' && value !== null && 'tensor' in value;
}
