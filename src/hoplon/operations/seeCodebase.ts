/** operations/seeCodebase.ts — t-061 unified `see_codebase` macro. */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { PackContextRequest } from '../contracts/requests.js';
import type { ExtractStructuralTemplateRequest, StructuralTemplate } from '../contracts/structuralTemplate.js';
import type { SearchSymbolsRequest, SearchSymbolsResult } from '../contracts/searchSymbols.js';
import type { DescribeProjectRequest, DescribeProjectResult } from '../contracts/describeProject.js';
import type { PackedContext } from '../contracts/context.js';
import type { SemanticSearchRequest, SemanticSearchResult } from '../contracts/semanticSearch.js';
import {
  SeeCodebaseRequestSchema,
  type SeeCodebaseEnvelope,
  type SeeCodebaseError,
  type SeeCodebasePrimitiveId,
  type SeeCodebaseProvenance,
  type SeeCodebaseRequest,
  type SeeCodebaseResult,
} from '../contracts/seeCodebase.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { classifyFileKindSupport, decideRoute } from './seeCodebaseRouting.js';
import { estimateResultBytes, executeSkeletonPath, executeStructuralPath } from './seeCodebasePaths.js';
import { executeRawPath } from './seeCodebaseRawPath.js';
import { finalizeSeeCodebaseError } from './seeCodebaseEnvelope.js';
import { resolveExecutionPlan } from './seeCodebasePlanning.js';
import { buildSeeCodebaseAdvisoryIntelligence } from './seeCodebaseIntelligence.js';
import { buildSeeCodebaseTokenTelemetry } from './seeCodebaseTelemetry.js';
import { finalizeSeeCodebaseThrownError } from './seeCodebaseThrownError.js';

export interface SeeCodebaseDeps {
  fs: HoplonFsAdapter;
  codeIntelligence?: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
  packContext: (req: PackContextRequest, signal?: AbortSignal) => Promise<PackedContext>;
  extractStructuralTemplate: (req: ExtractStructuralTemplateRequest, signal?: AbortSignal) => Promise<StructuralTemplate>;
  searchSymbols: (req: SearchSymbolsRequest, signal?: AbortSignal) => Promise<SearchSymbolsResult>;
  describeProject: (req: DescribeProjectRequest, signal?: AbortSignal) => Promise<DescribeProjectResult>;
  semanticSearch?: (req: SemanticSearchRequest, signal?: AbortSignal) => Promise<SemanticSearchResult>;
}

export async function seeCodebase(
  deps: SeeCodebaseDeps,
  req: SeeCodebaseRequest,
  signal?: AbortSignal,
): Promise<SeeCodebaseEnvelope> {
  const started = Date.now();
  const parsed = SeeCodebaseRequestSchema.safeParse(req);
  if (!parsed.success) {
    const correlationId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string'
        ? ((req as { correlationId: string }).correlationId || 'validator')
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId,
        cause: parsed.error,
      },
      `see_codebase: invalid request: ${parsed.error.message}`,
    );
  }
  const validated = parsed.data;
  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);

  const fileKind = classifyFileKindSupport(validated.targets);
  const route = decideRoute(validated.intent, validated.mode, fileKind, validated.targets);
  const decision = resolveExecutionPlan(route, validated.targets, validated.strict);

  deps.emitter.emit({
    op: 'seeCodebase',
    phase: 'start',
    engineId: deps.engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  if (route.fallbackPathLabel !== undefined && validated.strict) {
    return finalizeSeeCodebaseError({
      emitter: deps.emitter,
      engineId: deps.engineId,
      request: validated,
      plan: {
        selectedPath: route.selectedPath,
        routingReason: route.routingReason,
        requestedPathLabel: route.requestedPathLabel,
        fallbackPathLabel: route.fallbackPathLabel,
        fallbackOccurred: true,
        structuralTargets: [],
        skeletonTargets: [],
        rawTargets: [],
      },
      fileKind,
      started,
      kind: 'STRICT_BLOCKED_FALLBACK',
      message: `strict:true blocked fallback from ${route.requestedPathLabel} to ${route.fallbackPathLabel}`,
      fallbackBlockedByStrict: true,
      classification: 'BLOCK',
    });
  }
  if (decision.kind === 'strict_block') {
    return finalizeSeeCodebaseError({
      emitter: deps.emitter,
      engineId: deps.engineId,
      request: validated,
      plan: decision.plan,
      fileKind,
      started,
      kind: 'STRICT_BLOCKED_FALLBACK',
      message: decision.message,
      fallbackBlockedByStrict: true,
      classification: 'BLOCK',
    });
  }
  if (decision.kind === 'unsupported') {
    return finalizeSeeCodebaseError({
      emitter: deps.emitter,
      engineId: deps.engineId,
      request: validated,
      plan: decision.plan,
      fileKind,
      started,
      kind: 'UNSUPPORTED_TARGET',
      message: decision.message,
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }

  const plan = decision.plan;
  const results: SeeCodebaseResult[] = [];
  const targetErrors: SeeCodebaseError[] = [];
  const primitivesUsed = new Set<SeeCodebasePrimitiveId>();
  let truncated = false;
  let truncationReason: string | undefined;

  try {
    if (plan.selectedPath === 'structural' || plan.selectedPath === 'structural+raw') {
      await executeStructuralPath(deps, validated, plan.structuralTargets, signal, results, primitivesUsed);
    }
    if (plan.selectedPath === 'skeleton' || plan.selectedPath === 'skeleton+raw') {
      await executeSkeletonPath(deps, validated, plan.skeletonTargets, signal, results, primitivesUsed);
    }
    if (
      plan.selectedPath === 'raw' ||
      plan.selectedPath === 'structural+raw' ||
      plan.selectedPath === 'skeleton+raw'
    ) {
      const raw = await executeRawPath(deps, validated, plan.rawTargets, results, primitivesUsed);
      targetErrors.push(...raw.targetErrors);
      if (raw.truncated) {
        truncated = true;
        truncationReason = raw.truncationReason;
      }
    }
  } catch (err) {
    return finalizeSeeCodebaseThrownError({
      emitter: deps.emitter,
      engineId: deps.engineId,
      request: validated,
      plan,
      fileKind,
      started,
      err,
    });
  }

  if (results.length === 0 && targetErrors.length > 0) {
    const firstError = targetErrors[0];
    if (firstError === undefined) throw new Error('missing target error');
    return finalizeSeeCodebaseError({
      emitter: deps.emitter,
      engineId: deps.engineId,
      request: validated,
      plan,
      fileKind,
      started,
      kind: firstError.kind,
      message: firstError.message,
      error: firstError,
      fallbackBlockedByStrict: false,
      classification: 'BLOCK',
    });
  }

  const bytesReturned = estimateResultBytes(results);
  if (typeof validated.maxBytes === 'number' && bytesReturned > validated.maxBytes) {
    truncated = true;
    truncationReason = 'maxBytes';
  }

  const provenance: SeeCodebaseProvenance = {
    selectedPath: plan.selectedPath,
    routingReason: plan.routingReason,
    routingFactors: {
      intent: validated.intent,
      fileKindSupport: fileKind,
      modeRequested: validated.mode,
      strict: validated.strict,
    },
    primitivesUsed: Array.from(primitivesUsed),
    fallbackOccurred: plan.fallbackOccurred,
    fallbackBlockedByStrict: false,
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    metrics: {
      latencyMs: Date.now() - started,
      bytesReturned,
      tokenTelemetry: buildSeeCodebaseTokenTelemetry({ results, bytesReturned }),
    },
    correlationId: validated.correlationId,
    engineId: deps.engineId,
  };
  const intelligence = await buildSeeCodebaseAdvisoryIntelligence({
    request: validated,
    results,
    ...(deps.semanticSearch !== undefined
      ? { semanticSearch: deps.semanticSearch }
      : {}),
    ...(signal !== undefined ? { signal } : {}),
  });

  deps.emitter.emit({
    op: 'seeCodebase',
    phase: 'end',
    engineId: deps.engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs: Date.now() - started,
    classification: 'PASS',
  });

  return {
    ok: true,
    data: targetErrors.length > 0
      ? { results, partial: true, errors: targetErrors }
      : { results },
    ...(validated.includeProvenance ? { provenance } : {}),
    ...(intelligence.length > 0 ? { intelligence } : {}),
  };
}
