import {
  SemanticOverlayClearRequestSchema,
  SemanticOverlayClearResultSchema,
  SemanticOverlayRefreshRequestSchema,
  SemanticOverlayRefreshResultSchema,
  type SemanticDegradationReason,
  type SemanticOverlayClearRequest,
  type SemanticOverlayClearResult,
  type SemanticOverlayRefreshRequest,
  type SemanticOverlayRefreshResult,
  type SemanticSearchStatus,
} from '../contracts/semanticSearch.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId } from '../util/validators.js';
import {
  abortError,
  correlationFallback,
  type SemanticSearchDeps,
} from './semanticSearchShared.js';
import { uniqueReasons } from './semanticSearchPolicy.js';
import type {
  SemanticOverlayDocument,
  SemanticSessionOverlay,
} from './semanticSessionOverlayStore.js';
export {
  createInMemorySemanticSessionOverlayStore,
} from './semanticSessionOverlayStore.js';
export type {
  SemanticOverlayDocument,
  SemanticSessionOverlay,
  SemanticSessionOverlayStore,
  SemanticSessionOverlayStoreOptions,
} from './semanticSessionOverlayStore.js';
export {
  lexicalOverlayMatches,
  vectorOverlayMatches,
} from './semanticSessionOverlayScoring.js';

export async function refreshSemanticOverlay(
  deps: SemanticSearchDeps,
  req: SemanticOverlayRefreshRequest,
  signal?: AbortSignal,
): Promise<SemanticOverlayRefreshResult> {
  const parsed = SemanticOverlayRefreshRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: correlationFallback(req),
        cause: parsed.error,
      },
      `refreshSemanticOverlay: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  if (signal?.aborted || request.aborted === true) {
    return overlayRefreshResult(request, {
      status: 'UNAVAILABLE',
      generation: currentGeneration(deps, request),
      published: false,
      retainedPreviousOverlay: true,
      documents: [],
      reasons: ['overlay_refresh_aborted'],
    });
  }
  const store = deps.sessionOverlayStore;
  if (store === undefined) {
    return overlayRefreshResult(request, {
      status: 'UNAVAILABLE',
      generation: 0,
      published: false,
      retainedPreviousOverlay: false,
      documents: [],
      reasons: ['overlay_unavailable_process_local_store'],
    });
  }

  const generation = store.reserve(
    request.projectId,
    request.sessionId,
    request.worktreeId,
  );
  let documents: SemanticOverlayDocument[] = [];
  let refreshFailed = false;
  try {
    documents = await buildOverlayDocuments(deps, request, signal);
  } catch {
    if (signal?.aborted) {
      return overlayRefreshResult(request, {
        status: 'UNAVAILABLE',
        generation,
        published: false,
        retainedPreviousOverlay: true,
        documents: [],
        reasons: ['overlay_refresh_aborted'],
      });
    }
    refreshFailed = true;
  }
  const requestReasons = request.degradationReasons ?? [];
  const vectorCount = documents.filter((doc) => doc.vector !== undefined).length;
  const hasDocuments = documents.length > 0;
  const status =
    refreshFailed ? 'UNAVAILABLE' :
    request.status ??
    (hasDocuments ? (vectorCount === documents.length ? 'AVAILABLE' : 'DEGRADED') : 'EMPTY');
  const reasons = uniqueReasons([
    ...requestReasons,
    refreshFailed ? 'overlay_refresh_failed' : null,
    hasDocuments && vectorCount < documents.length ? 'lexical_only_profile' : null,
  ]);
  const overlay: SemanticSessionOverlay = {
    projectId: request.projectId,
    sessionId: request.sessionId,
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {}),
    generation,
    status,
    degradationReasons: reasons,
    documents,
    maskedPaths: [...new Set(request.touchedFiles)].sort(),
  };
  const published = store.publish(overlay);
  return overlayRefreshResult(request, {
    status: published ? status : 'DEGRADED',
    generation,
    published,
    retainedPreviousOverlay: !published,
    documents,
    reasons: published ? reasons : uniqueReasons([...reasons, 'overlay_refresh_stale_generation']),
  });
}

export function clearSemanticOverlay(
  deps: SemanticSearchDeps,
  req: SemanticOverlayClearRequest,
): SemanticOverlayClearResult {
  const parsed = SemanticOverlayClearRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: correlationFallback(req),
        cause: parsed.error,
      },
      `clearSemanticOverlay: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  const cleared =
    deps.sessionOverlayStore?.clear(
      request.projectId,
      request.sessionId,
      request.worktreeId,
    ) ?? false;
  const validated = SemanticOverlayClearResultSchema.parse({ ...request, cleared });
  return validated;
}

function currentGeneration(
  deps: SemanticSearchDeps,
  request: SemanticOverlayRefreshRequest,
): number {
  return deps.sessionOverlayStore?.get(
    request.projectId,
    request.sessionId,
    request.worktreeId,
  )?.generation ?? 0;
}

async function buildOverlayDocuments(
  deps: SemanticSearchDeps,
  request: SemanticOverlayRefreshRequest,
  signal?: AbortSignal,
): Promise<SemanticOverlayDocument[]> {
  const documents: SemanticOverlayDocument[] = [];
  for (const doc of request.documents ?? []) {
    if (signal?.aborted) throw abortError(signal);
    const overlayDoc: SemanticOverlayDocument = {
      ...doc,
      metadata: { ...(doc.metadata ?? {}), projectId: request.projectId },
    };
    if (deps.embeddingProvided === true) {
      const vector = await deps.embedding.embed(doc.text);
      if (Array.isArray(vector) && vector.length > 0) {
        documents.push({ ...overlayDoc, vector });
        continue;
      }
    }
    documents.push(overlayDoc);
  }
  return documents;
}

function overlayRefreshResult(
  request: SemanticOverlayRefreshRequest,
  args: {
    readonly status: SemanticSearchStatus;
    readonly generation: number;
    readonly published: boolean;
    readonly retainedPreviousOverlay: boolean;
    readonly documents: readonly SemanticOverlayDocument[];
    readonly reasons: readonly SemanticDegradationReason[];
  },
): SemanticOverlayRefreshResult {
  const value = {
    correlationId: request.correlationId,
    projectId: request.projectId,
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {}),
    sessionId: request.sessionId,
    status: args.status,
    mode: request.mode,
    inputSource: request.inputSource,
    overlayGeneration: args.generation,
    published: args.published,
    retainedPreviousOverlay: args.retainedPreviousOverlay,
    touchedFileCount: request.touchedFiles.length,
    documentCount: args.documents.length,
    lexicalCount: args.documents.length,
    vectorCount: args.documents.filter((doc) => doc.vector !== undefined).length,
    maskCount: new Set(request.touchedFiles).size,
    degradationReasons: uniqueReasons(args.reasons),
  };
  return SemanticOverlayRefreshResultSchema.parse(value);
}
