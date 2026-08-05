import type {
  NativeLexicalIndexAdapter,
  NativeSemanticIndexResult,
  NativeSemanticMatch,
  NativeVectorIndexAdapter,
} from './types.js';

export function result(
  status: NativeSemanticIndexResult['status'],
  resultCount: number,
  matches: NativeSemanticMatch[],
): NativeSemanticIndexResult {
  return { status, resultCount, matches, degradationReasons: [] };
}

export function unavailable(reason: string): NativeSemanticIndexResult {
  return {
    status: 'UNAVAILABLE',
    resultCount: 0,
    matches: [],
    degradationReasons: [reason],
  };
}

export function createUnavailableLexicalIndex(
  reason: string,
): NativeLexicalIndexAdapter {
  return {
    upsert: async () => unavailable(reason),
    search: async () => unavailable(reason),
    delete: async () => unavailable(reason),
  };
}

export function createUnavailableVectorIndex(
  reason: string,
): NativeVectorIndexAdapter {
  return {
    upsert: async () => unavailable(reason),
    search: async () => unavailable(reason),
    delete: async () => unavailable(reason),
  };
}
