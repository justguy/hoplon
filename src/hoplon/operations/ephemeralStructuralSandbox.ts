/**
 * operations/ephemeralStructuralSandbox.ts - t-108 in-memory planning macro.
 *
 * Parses synthetic snippets through the existing CodeIntelligenceAdapter,
 * summarizes structure, and returns an explicitly advisory result. No project
 * filesystem, versioning, snapshot store, audit log, session state, or lock
 * dependency is accepted by this operation.
 */

import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  EphemeralStructuralSandboxRequestSchema,
  EphemeralStructuralSandboxResultSchema,
  createAdvisoryIntelligenceAuthority,
  createStructuralSandboxNonBypass,
  createStructuralSandboxSideEffectProfile,
  type EphemeralStructuralSandboxRequest,
  type EphemeralStructuralSandboxResult,
  type StructuralSandboxSnippetResult,
} from '../contracts/structuralSandbox.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import {
  evaluateStructuralSandboxSnippet,
  structuralSandboxTypeProviderCheck,
  summarizeStructuralSandboxStatus,
} from './ephemeralStructuralSandboxInspect.js';

export interface EphemeralStructuralSandboxDeps {
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  config: {
    parseTimeoutMs: number;
  };
}

export async function ephemeralStructuralSandbox(
  deps: EphemeralStructuralSandboxDeps,
  req: EphemeralStructuralSandboxRequest,
  signal?: AbortSignal,
): Promise<EphemeralStructuralSandboxResult> {
  const parsed = EphemeralStructuralSandboxRequestSchema.safeParse(req);
  if (!parsed.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: corrId,
        cause: parsed.error,
      },
      `ephemeralStructuralSandbox: invalid request: ${parsed.error.message}`,
    );
  }

  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  if (request.runId !== undefined) validateRunId(request.runId);

  const start = Date.now();
  safeEmit(deps, request, { phase: 'start' });

  try {
    if (signal?.aborted) throw abortError(signal);

    const snippets: StructuralSandboxSnippetResult[] = [];
    for (const snippet of request.snippets) {
      if (signal?.aborted) throw abortError(signal);
      snippets.push(await evaluateStructuralSandboxSnippet(
        {
          codeIntelligence: deps.codeIntelligence,
          parseTimeoutMs: deps.config.parseTimeoutMs,
        },
        snippet,
        signal,
      ));
    }

    const result: EphemeralStructuralSandboxResult = {
      sandboxSchemaVersion: 1,
      correlationId: request.correlationId,
      advisory: true,
      status: summarizeStructuralSandboxStatus(snippets),
      checked: snippets.length,
      snippets,
      typeProvider: structuralSandboxTypeProviderCheck(
        request.options?.includeTypeProviderCheck === true,
      ),
      sideEffectProfile: createStructuralSandboxSideEffectProfile(),
      authority: createAdvisoryIntelligenceAuthority(),
      nonBypass: createStructuralSandboxNonBypass(),
    };

    const validated = EphemeralStructuralSandboxResultSchema.safeParse(result);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `ephemeralStructuralSandbox: produced invalid result: ${validated.error.message}`,
      );
    }

    safeEmit(deps, request, {
      phase: 'end',
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return validated.data;
  } catch (err) {
    safeEmit(deps, request, {
      phase: 'error',
      durationMs: Date.now() - start,
      classification: 'ERROR',
      errorCategory: err instanceof ValidationError ? 'validation' : 'adapter',
      errorKind: err instanceof ValidationError ? err.kind : 'structural_sandbox_failed',
    });
    throw err;
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}

function safeEmit(
  deps: EphemeralStructuralSandboxDeps,
  request: EphemeralStructuralSandboxRequest,
  event: {
    phase: 'start' | 'end' | 'error';
    durationMs?: number;
    classification?: 'PASS' | 'ERROR';
    errorCategory?: 'adapter' | 'validation';
    errorKind?: string;
  },
): void {
  try {
    deps.emitter.emit({
      op: 'ephemeralStructuralSandbox',
      phase: event.phase,
      engineId: deps.engineId,
      correlationId: request.correlationId,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.classification !== undefined ? { classification: event.classification } : {}),
      ...(event.errorCategory !== undefined ? { errorCategory: event.errorCategory } : {}),
      ...(event.errorKind !== undefined ? { errorKind: event.errorKind } : {}),
    });
  } catch {
    // Emitters are fire-and-forget; sandbox results must not depend on logging.
  }
}
