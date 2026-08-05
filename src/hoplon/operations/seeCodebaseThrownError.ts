import type { HoplonEmitter } from '../adapters/emitter.js';
import type {
  SeeCodebaseEnvelope,
  SeeCodebaseRequestValidated,
} from '../contracts/seeCodebase.js';
import { isSeeCodebaseAstNodeError } from './seeCodebaseAstNodeErrors.js';
import { finalizeSeeCodebaseError } from './seeCodebaseEnvelope.js';
import type { SeeCodebaseExecutionPlan } from './seeCodebasePlanning.js';
import type { classifyFileKindSupport } from './seeCodebaseRouting.js';

interface FinalizeThrownErrorArgs {
  emitter: HoplonEmitter;
  engineId: string;
  request: SeeCodebaseRequestValidated;
  plan: SeeCodebaseExecutionPlan;
  fileKind: ReturnType<typeof classifyFileKindSupport>;
  started: number;
  err: unknown;
}

export function finalizeSeeCodebaseThrownError({
  emitter,
  engineId,
  request,
  plan,
  fileKind,
  started,
  err,
}: FinalizeThrownErrorArgs): SeeCodebaseEnvelope {
  emitter.emit({
    op: 'seeCodebase',
    phase: 'error',
    engineId,
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
    durationMs: Date.now() - started,
  });

  const kind = typeof err === 'object' && err !== null
    ? (err as { kind?: unknown }).kind
    : undefined;
  if (kind === 'invalid_manifest') {
    return finalizeSeeCodebaseError({
      emitter,
      engineId,
      request,
      plan,
      fileKind,
      started,
      kind: 'INVALID_REQUEST',
      message: err instanceof Error ? err.message : String(err),
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }
  if (kind === 'path_not_found' || kind === 'path_escape' || kind === 'path_traversal') {
    return finalizeSeeCodebaseError({
      emitter,
      engineId,
      request,
      plan,
      fileKind,
      started,
      kind: 'PATH_NOT_FOUND',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }
  if (kind === 'strict_file_policy') {
    return finalizeSeeCodebaseError({
      emitter,
      engineId,
      request,
      plan,
      fileKind,
      started,
      kind: 'UNSUPPORTED_TARGET',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }
  if (kind === 'edit_slice_unavailable') {
    return finalizeSeeCodebaseError({
      emitter,
      engineId,
      request,
      plan,
      fileKind,
      started,
      kind: 'INVALID_REQUEST',
      message: err instanceof Error ? err.message : String(err),
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }
  if (isSeeCodebaseAstNodeError(err)) {
    return finalizeSeeCodebaseError({
      emitter,
      engineId,
      request,
      plan,
      fileKind,
      started,
      kind: err.seeCodebaseKind,
      message: err.message,
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }
  return finalizeSeeCodebaseError({
    emitter,
    engineId,
    request,
    plan,
    fileKind,
    started,
    kind: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    fallbackBlockedByStrict: false,
    classification: 'ERROR',
  });
}
