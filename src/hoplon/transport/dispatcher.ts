/**
 * transport/dispatcher.ts — transport-agnostic engine dispatcher (T-024 sub-slice A).
 *
 * Groundwork for the gRPC runtime waves: the HTTP server and any future gRPC
 * server both resolve (method, body, signal) against the same shared registry
 * and call the same engine surface with identical validation and call-shape
 * semantics. Zod stays the single wire source of truth; proto remains envelope-
 * carried per PG1.
 *
 * This module ships no runtime behavior change. The HTTP server delegates to
 * this dispatcher without altering error envelopes, status codes, AbortSignal
 * wiring, or route list. No gRPC runtime, server, or client is shipped here.
 */

import type { z } from 'zod';

import type { HoplonEngine } from '../engine/types.js';
import { ValidationError } from '../contracts/errors.js';
import { SemanticSearchRequestValidationError } from '../contracts/semanticSearchRecovery.js';
import type { ProtoOperation } from './proto/registry.js';
import { HOPLON_PROTO_OPERATIONS } from './proto/registry.js';
import { DISPATCH_CALL_SHAPE } from './dispatcherCallShape.js';

export type { DispatchCallShape } from './dispatcherCallShape.js';

// ---------------------------------------------------------------------------
// Call shapes
//
// Four shapes cover every method on HoplonEngine:
//   async_body_signal     — Promise<T>, (req, signal?) — the majority
//   async_signal_only     — Promise<T>, (signal?)       — health, reconcile
//   async_body_no_signal  — Promise<T>, (opts)          — gc
//   sync_body             — T, (req)                    — computeMinimalPatch, compressRetryContext
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One dispatch call. `engineId` and `correlationId` flow onto any ValidationError
 * the dispatcher raises for body validation or unknown-method lookup, so that
 * transports keep their own identity in error envelopes (H13).
 */
export interface DispatchRequest {
  readonly method: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly engineId: string;
  readonly correlationId: string;
}

/**
 * The transport-agnostic dispatcher surface.
 *
 * - `operations` exposes the shared registry so transports can drive their route
 *   tables (HTTP paths, gRPC RPCs) from a single source of truth.
 * - `operationFor(method)` is a convenience lookup by engine method name.
 * - `invoke(req)` validates the body against the method's Zod schema, calls the
 *   engine using the correct call shape, and returns the result. Sync engine
 *   methods are surfaced through `Promise<unknown>` so all transports share one
 *   return shape.
 */
export interface EngineDispatcher {
  readonly operations: readonly ProtoOperation[];
  operationFor(method: string): ProtoOperation | null;
  invoke(req: DispatchRequest): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function parseOrThrow<T>(
  schema: z.ZodTypeAny,
  rawBody: unknown,
  engineId: string,
  correlationId: string,
  method: string,
): T {
  const result = schema.safeParse(rawBody);
  if (!result.success) {
    if (method === 'semanticSearch') {
      throw new SemanticSearchRequestValidationError({
        engineId,
        correlationId,
        cause: result.error,
      });
    }
    throw new ValidationError(
      { kind: 'invalid_scope', engineId, correlationId, cause: result.error },
      `Request body validation failed: ${result.error.message}`,
    );
  }
  return result.data as T;
}

interface GcOpts {
  projectId?: string;
  olderThan?: string;
  expiredBefore?: string;
  semanticCache?: boolean;
  semanticOverlays?: boolean;
  semanticTombstones?: boolean;
}

function buildGcOpts(parsed: {
  projectId?: string;
  olderThan?: string;
  expiredBefore?: string;
  semanticCache?: boolean;
  semanticOverlays?: boolean;
  semanticTombstones?: boolean;
}): GcOpts {
  const opts: GcOpts = {};
  if (parsed.projectId !== undefined) opts.projectId = parsed.projectId;
  if (parsed.olderThan !== undefined) opts.olderThan = parsed.olderThan;
  if (parsed.expiredBefore !== undefined) opts.expiredBefore = parsed.expiredBefore;
  if (parsed.semanticCache !== undefined) opts.semanticCache = parsed.semanticCache;
  if (parsed.semanticOverlays !== undefined) {
    opts.semanticOverlays = parsed.semanticOverlays;
  }
  if (parsed.semanticTombstones !== undefined) {
    opts.semanticTombstones = parsed.semanticTombstones;
  }
  return opts;
}

export function createEngineDispatcher(engine: HoplonEngine): EngineDispatcher {
  const byMethod = new Map<string, ProtoOperation>();
  for (const op of HOPLON_PROTO_OPERATIONS) byMethod.set(op.method, op);

  async function invoke(req: DispatchRequest): Promise<unknown> {
    const op = byMethod.get(req.method);
    if (!op) {
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: req.engineId,
          correlationId: req.correlationId,
        },
        `Unknown engine method: ${req.method}`,
      );
    }

    const shape = DISPATCH_CALL_SHAPE[op.method];

    if (shape === 'async_signal_only') {
      if (op.method === 'health') return engine.health(req.signal);
      if (op.method === 'reconcile') return engine.reconcile(req.signal);
      // Unreachable — only health/reconcile are async_signal_only.
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: req.engineId,
          correlationId: req.correlationId,
        },
        `Unsupported signal-only method: ${op.method}`,
      );
    }

    if (op.requestSchema === null) {
      // hasRequestBody is false but CALL_SHAPE expected a body — registry drift.
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: req.engineId,
          correlationId: req.correlationId,
        },
        `Registry missing request schema for ${op.method}`,
      );
    }

    const parsed = parseOrThrow<unknown>(
      op.requestSchema,
      req.body,
      req.engineId,
      req.correlationId,
      op.method,
    );

    if (shape === 'async_body_no_signal') {
      // gc is the only async_body_no_signal method.
      const opts = buildGcOpts(parsed as GcOpts);
      return engine.gc(opts);
    }

    if (shape === 'sync_body') {
      if (op.method === 'computeMinimalPatch') {
        return engine.computeMinimalPatch(parsed as Parameters<HoplonEngine['computeMinimalPatch']>[0]);
      }
      if (op.method === 'compressRetryContext') {
        return engine.compressRetryContext(parsed as Parameters<HoplonEngine['compressRetryContext']>[0]);
      }
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: req.engineId,
          correlationId: req.correlationId,
        },
        `Unsupported sync method: ${op.method}`,
      );
    }

    // async_body_signal — dispatch by method name against the engine facade.
    const m = op.method;
    switch (m) {
      case 'createSnapshot':
        return engine.createSnapshot(parsed as Parameters<HoplonEngine['createSnapshot']>[0], req.signal);
      case 'auditDiff':
        return engine.auditDiff(parsed as Parameters<HoplonEngine['auditDiff']>[0], req.signal);
      case 'revertUncontracted':
        return engine.revertUncontracted(parsed as Parameters<HoplonEngine['revertUncontracted']>[0], req.signal);
      case 'packContext':
        return engine.packContext(parsed as Parameters<HoplonEngine['packContext']>[0], req.signal);
      case 'dryRun':
        return engine.dryRun(parsed as Parameters<HoplonEngine['dryRun']>[0], req.signal);
      case 'preflight':
        return engine.preflight(parsed as Parameters<HoplonEngine['preflight']>[0], req.signal);
      case 'queryStructure':
        return engine.queryStructure(parsed as Parameters<HoplonEngine['queryStructure']>[0], req.signal);
      case 'extractStructuralTemplate':
        return engine.extractStructuralTemplate(parsed as Parameters<HoplonEngine['extractStructuralTemplate']>[0], req.signal);
      case 'extractRollbackTemplate':
        return engine.extractRollbackTemplate(parsed as Parameters<HoplonEngine['extractRollbackTemplate']>[0], req.signal);
      case 'getRelevantTests':
        return engine.getRelevantTests(parsed as Parameters<HoplonEngine['getRelevantTests']>[0], req.signal);
      case 'searchSymbols':
        return engine.searchSymbols(parsed as Parameters<HoplonEngine['searchSymbols']>[0], req.signal);
      case 'describeProject':
        return engine.describeProject(parsed as Parameters<HoplonEngine['describeProject']>[0], req.signal);
      case 'seeCodebase':
        return engine.seeCodebase(parsed as Parameters<HoplonEngine['seeCodebase']>[0], req.signal);
      case 'predictViolationRisk':
        return engine.predictViolationRisk(parsed as Parameters<HoplonEngine['predictViolationRisk']>[0], req.signal);
      case 'scoreAnomaly':
        return engine.scoreAnomaly(parsed as Parameters<HoplonEngine['scoreAnomaly']>[0], req.signal);
      case 'analyzeBlastRadius':
        return engine.analyzeBlastRadius(parsed as Parameters<HoplonEngine['analyzeBlastRadius']>[0], req.signal);
      case 'findReferencingSymbols':
        return engine.findReferencingSymbols(parsed as Parameters<HoplonEngine['findReferencingSymbols']>[0], req.signal);
      case 'synthesizeInterfaceStubs':
        return engine.synthesizeInterfaceStubs(parsed as Parameters<HoplonEngine['synthesizeInterfaceStubs']>[0], req.signal);
      case 'ephemeralStructuralSandbox':
        return engine.ephemeralStructuralSandbox(parsed as Parameters<HoplonEngine['ephemeralStructuralSandbox']>[0], req.signal);
      case 'describeCapabilities':
        return engine.describeCapabilities(parsed as Parameters<HoplonEngine['describeCapabilities']>[0], req.signal);
      case 'indexSemanticCorpus':
        return engine.indexSemanticCorpus(parsed as Parameters<HoplonEngine['indexSemanticCorpus']>[0], req.signal);
      case 'semanticSearch':
        return engine.semanticSearch(parsed as Parameters<HoplonEngine['semanticSearch']>[0], req.signal);
      case 'refreshSemanticOverlay':
        return engine.refreshSemanticOverlay(parsed as Parameters<HoplonEngine['refreshSemanticOverlay']>[0], req.signal);
      case 'clearSemanticOverlay':
        return engine.clearSemanticOverlay(parsed as Parameters<HoplonEngine['clearSemanticOverlay']>[0], req.signal);
      default:
        throw new ValidationError(
          {
            kind: 'invalid_scope',
            engineId: req.engineId,
            correlationId: req.correlationId,
          },
          `Unsupported async method: ${m}`,
        );
    }
  }

  return {
    operations: HOPLON_PROTO_OPERATIONS,
    operationFor(method: string): ProtoOperation | null {
      return byMethod.get(method) ?? null;
    },
    invoke,
  };
}
