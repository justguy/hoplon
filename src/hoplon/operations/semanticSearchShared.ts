import type { HoplonEmitter } from '../adapters/emitter.js';
import type { EmbeddingAdapter } from '../adapters/embedding.js';
import type { VectorStoreAdapter } from '../adapters/vectorStore.js';
import type { EmbeddingCacheAdapter } from '../adapters/embeddingCache.js';
import type { LexicalIndexAdapter } from '../adapters/lexicalIndex.js';
import type { SemanticDocumentBuilderAdapter } from '../adapters/semanticDocumentBuilder.js';
import type { SemanticIndexStoreAdapter } from '../adapters/semanticIndexStore.js';
import type { SemanticStorageProfileAdapter } from '../adapters/semanticStorageProfile.js';
import type { VectorIndexAdapter } from '../adapters/vectorIndex.js';
import type { SemanticSessionOverlayStore } from './semanticSessionOverlay.js';
import {
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../contracts/errors.js';
import type { SemanticDegradationReason } from '../contracts/semanticSearch.js';

export interface SemanticSearchDeps {
  embedding: EmbeddingAdapter;
  vectorStore: VectorStoreAdapter;
  embeddingCache: EmbeddingCacheAdapter;
  semanticIndexStore: SemanticIndexStoreAdapter;
  lexicalIndex: LexicalIndexAdapter;
  vectorIndex: VectorIndexAdapter;
  semanticDocumentBuilder: SemanticDocumentBuilderAdapter;
  semanticStorageProfile: SemanticStorageProfileAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  embeddingProvided: boolean;
  vectorStoreProvided: boolean;
  embeddingCacheProvided?: boolean;
  semanticIndexStoreProvided?: boolean;
  lexicalIndexProvided?: boolean;
  vectorIndexProvided?: boolean;
  sessionOverlayStore?: SemanticSessionOverlayStore;
  semanticDisabledReason?: SemanticDegradationReason;
}

export function providersAvailable(deps: SemanticSearchDeps): boolean {
  return deps.embeddingProvided && deps.vectorStoreProvided;
}

export function correlationFallback(req: unknown): string {
  const value = (req as { correlationId?: unknown })?.correlationId;
  return typeof value === 'string' && value.length > 0 ? value : 'validator';
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}

export function classifySemanticSearchError(
  err: unknown,
  adapterFallbackKind: string,
): {
  errorCategory?: 'engine' | 'adapter' | 'semantic' | 'validation';
  errorKind?: string;
} {
  if (err instanceof ValidationError) {
    return { errorCategory: 'validation', errorKind: err.kind };
  }
  if (err instanceof AdapterError) {
    return { errorCategory: 'adapter', errorKind: err.kind };
  }
  if (err instanceof EngineError) {
    return { errorCategory: 'engine', errorKind: err.kind };
  }
  if (err instanceof SemanticError) {
    return { errorCategory: 'semantic', errorKind: err.kind };
  }
  return { errorCategory: 'adapter', errorKind: adapterFallbackKind };
}

const SEMANTIC_VECTOR_ID_PREFIX = 'hoplon-semantic:';

export function toSemanticVectorRecordId(
  projectId: string,
  documentId: string,
): string {
  return `${SEMANTIC_VECTOR_ID_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(documentId)}`;
}

export function fromSemanticVectorRecordId(
  expectedProjectId: string,
  storedId: string,
): string {
  if (!storedId.startsWith(SEMANTIC_VECTOR_ID_PREFIX)) return storedId;

  const payload = storedId.slice(SEMANTIC_VECTOR_ID_PREFIX.length);
  const separator = payload.indexOf(':');
  if (separator === -1) return storedId;

  try {
    const projectId = decodeURIComponent(payload.slice(0, separator));
    const documentId = decodeURIComponent(payload.slice(separator + 1));
    return projectId === expectedProjectId ? documentId : storedId;
  } catch {
    return storedId;
  }
}
