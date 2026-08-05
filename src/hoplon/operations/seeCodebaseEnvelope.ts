import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SeeCodebaseRequestSchema } from '../contracts/seeCodebase.js';
import {
  type SeeCodebaseError,
  type SeeCodebaseEnvelope,
  type SeeCodebaseProvenance,
} from '../contracts/seeCodebase.js';
import type { classifyFileKindSupport } from './seeCodebaseRouting.js';
import type { SeeCodebaseExecutionPlan } from './seeCodebasePlanning.js';

export type SeeCodebaseErrorKind =
  | 'STRICT_BLOCKED_FALLBACK'
  | 'UNSUPPORTED_TARGET'
  | 'PATH_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'DUPLICATE_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'UNRESOLVED_TARGET'
  | 'STALE_TARGET'
  | 'OUT_OF_SCOPE_TARGET'
  | 'INTERNAL';

interface FinalizeSeeCodebaseErrorArgs {
  emitter: HoplonEmitter;
  engineId: string;
  request: ReturnType<typeof SeeCodebaseRequestSchema.parse>;
  plan: SeeCodebaseExecutionPlan;
  fileKind: ReturnType<typeof classifyFileKindSupport>;
  started: number;
  kind: SeeCodebaseErrorKind;
  message: string;
  cause?: unknown;
  error?: SeeCodebaseError;
  fallbackBlockedByStrict: boolean;
  classification: 'BLOCK' | 'ERROR';
}

export function finalizeSeeCodebaseError({
  emitter,
  engineId,
  request,
  plan,
  fileKind,
  started,
  kind,
  message,
  cause,
  error,
  fallbackBlockedByStrict,
  classification,
}: FinalizeSeeCodebaseErrorArgs): SeeCodebaseEnvelope {
  const provenance: SeeCodebaseProvenance = {
    selectedPath: plan.selectedPath,
    routingReason: plan.routingReason,
    routingFactors: {
      intent: request.intent,
      fileKindSupport: fileKind,
      modeRequested: request.mode,
      strict: request.strict,
    },
    primitivesUsed: [],
    fallbackOccurred: plan.fallbackOccurred,
    fallbackBlockedByStrict,
    truncated: false,
    metrics: {
      latencyMs: Date.now() - started,
      bytesReturned: 0,
    },
    correlationId: request.correlationId,
    engineId,
  };

  emitter.emit({
    op: 'seeCodebase',
    phase: 'end',
    engineId,
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
    durationMs: Date.now() - started,
    classification,
  });

  const targetPath = extractTargetPath(cause);

  return {
    ok: false,
    error: error ?? {
      kind,
      message,
      requestedPath: plan.requestedPathLabel,
      ...(targetPath !== undefined ? { targetPath } : {}),
      ...(plan.fallbackPathLabel !== undefined ? { suggestedPath: plan.fallbackPathLabel } : {}),
    },
    ...(request.includeProvenance ? { provenance } : {}),
  };
}

function extractTargetPath(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const targetPath = (cause as { targetPath?: unknown; path?: unknown }).targetPath
    ?? (cause as { path?: unknown }).path;
  return typeof targetPath === 'string' && targetPath.length > 0 ? targetPath : undefined;
}
