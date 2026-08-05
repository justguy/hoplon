/**
 * transport/grpc/client.ts — CL1 `createRemoteHoplonGrpcEngine` factory.
 *
 * Returns a HoplonEngine-shaped object whose methods dispatch over gRPC to
 * the SV1 server. The wire contract is PG1 (HoplonService + HoplonEnvelope /
 * HoplonStreamFrame / HoplonUnit), and the dispatch logic lives in
 * `clientDispatch.ts` so this file can stay a thin facade.
 *
 * Behavioral parity with the HTTP client:
 *   - Engine methods in the shared proto registry, same signatures.
 *   - `compressRetryContext` / `computeMinimalPatch` are synchronous on the
 *     HoplonEngine interface but return a Promise over the wire. Callers that
 *     `await` are unaffected; the divergence is identical to the HTTP client.
 *   - Errors deserialize into the typed HoplonError hierarchy via the
 *     `hoplon-error-bin` metadata envelope (see clientErrors.ts).
 *
 * gRPC remains optional at runtime: constructing this client is the only
 * path that loads `@grpc/grpc-js` + `@grpc/proto-loader`. No default binding,
 * no hidden transport swap. The factory is async because the proto load and
 * client-handle construction are both async; callers should construct once
 * and reuse the returned engine.
 */

import { EngineError } from '../../contracts/errors.js';
import type { HoplonEngine } from '../../engine/types.js';
import {
  HOPLON_PROTO_OPERATIONS,
  type ProtoOperation,
} from '../proto/registry.js';

import {
  buildGrpcClientHandle,
  dispatchStream,
  dispatchUnary,
} from './clientDispatch.js';

export interface RemoteHoplonGrpcEngineOptions {
  /**
   * `host:port` of the Hoplon gRPC server (e.g. `'hoplon.internal:50051'`).
   * No scheme; grpc-js applies its own scheme/resolver conventions.
   */
  address: string;
  /**
   * Optional bearer token. When present, every RPC carries the gRPC
   * metadata entry `authorization: Bearer <token>` — identical header
   * name to the HTTP client so the same middleware accepts both.
   */
  authToken?: string;
  /** Stable engine id for client-side parse errors. Defaults to `remote-grpc`. */
  engineId?: string;
}

export interface RemoteHoplonGrpcEngine extends HoplonEngine {
  /** Close the underlying gRPC channel. Safe to call multiple times. */
  close(): void;
}

const OP_BY_METHOD: Map<string, ProtoOperation> = new Map(
  HOPLON_PROTO_OPERATIONS.map((op) => [op.method as string, op]),
);

function requireOp(method: keyof HoplonEngine): ProtoOperation {
  const op = OP_BY_METHOD.get(method as string);
  if (!op) {
    throw new Error(`Hoplon gRPC client: missing proto op for engine method "${String(method)}"`);
  }
  return op;
}

function corrOf(req: unknown): string {
  if (req && typeof req === 'object' && 'correlationId' in req) {
    const v = (req as { correlationId?: unknown }).correlationId;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown';
}

export async function createRemoteHoplonGrpcEngine(
  opts: RemoteHoplonGrpcEngineOptions,
): Promise<RemoteHoplonGrpcEngine> {
  const handle = await buildGrpcClientHandle(opts.address);
  const engineId = opts.engineId ?? 'remote-grpc';
  const authToken = opts.authToken;

  function callUnary<Req, Res>(
    method: keyof HoplonEngine,
    body: Req | undefined,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<Res> {
    const op = requireOp(method);
    return dispatchUnary({
      handle,
      op,
      body,
      reqSchema: op.requestSchema,
      resSchema: op.responseSchema,
      authToken,
      engineId,
      correlationId,
      signal,
    }) as Promise<Res>;
  }

  function callStream<Req, Res>(
    method: keyof HoplonEngine,
    body: Req,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<Res> {
    const op = requireOp(method);
    if (!op.requestSchema) {
      throw new Error(`gRPC client: streaming op ${op.rpcName} requires a request schema`);
    }
    return dispatchStream({
      handle,
      op,
      body,
      reqSchema: op.requestSchema,
      resSchema: op.responseSchema,
      authToken,
      engineId,
      correlationId,
      signal,
    }) as Promise<Res>;
  }

  const engine: RemoteHoplonGrpcEngine = {
    close(): void { handle.close(); },

    createSnapshot: (req, signal) =>
      callUnary('createSnapshot', req, req.manifest.correlationId, signal),
    auditDiff: (req, signal) =>
      callUnary('auditDiff', req, corrOf(req), signal),
    revertUncontracted: (req, signal) =>
      callUnary('revertUncontracted', req, corrOf(req), signal),
    packContext: (req, signal) =>
      callStream('packContext', req, corrOf(req), signal),
    dryRun: (req, signal) =>
      callUnary('dryRun', req, corrOf(req), signal),
    preflight: (req, signal) =>
      callUnary('preflight', req, corrOf(req), signal),
    queryStructure: (req, signal) =>
      callUnary('queryStructure', req, corrOf(req), signal),
    extractStructuralTemplate: (req, signal) =>
      callUnary('extractStructuralTemplate', req, corrOf(req), signal),
    extractRollbackTemplate: (req, signal) =>
      callUnary('extractRollbackTemplate', req, corrOf(req), signal),
    searchSymbols: (req, signal) =>
      callUnary('searchSymbols', req, corrOf(req), signal),
    describeProject: (req, signal) =>
      callUnary('describeProject', req, corrOf(req), signal),
    predictViolationRisk: (req, signal) =>
      callUnary('predictViolationRisk', req, corrOf(req), signal),
    scoreAnomaly: (req, signal) =>
      callUnary('scoreAnomaly', req, corrOf(req), signal),
    analyzeBlastRadius: (req, signal) =>
      callUnary('analyzeBlastRadius', req, corrOf(req), signal),
    findReferencingSymbols: (req, signal) =>
      callUnary('findReferencingSymbols', req, corrOf(req), signal),
    findSyntaxNode: (req) => {
      throw new EngineError(
        {
          kind: 'remote_not_supported',
          engineId,
          correlationId: corrOf(req),
        },
        'findSyntaxNode is exposed through the in-process engine and MCP until a future transport slice exposes it.',
      );
    },
    synthesizeInterfaceStubs: (req, signal) =>
      callUnary('synthesizeInterfaceStubs', req, corrOf(req), signal),
    ephemeralStructuralSandbox: (req, signal) =>
      callUnary('ephemeralStructuralSandbox', req, corrOf(req), signal),
    getRelevantTests: (req, signal) =>
      callUnary('getRelevantTests', req, corrOf(req), signal),
    describeCapabilities: (req, signal) =>
      callUnary('describeCapabilities', req, corrOf(req), signal),

    health: (signal) =>
      callUnary('health', undefined, 'health', signal),
    reconcile: (signal) =>
      callUnary('reconcile', undefined, 'reconcile', signal),

    gc: (gcOpts) =>
      callUnary('gc', gcOpts, 'gc'),

    /**
     * BEHAVIORAL DIVERGENCE (matches HTTP client): synchronous on the
     * HoplonEngine interface, async over the wire. Callers that `await` the
     * result are unaffected.
     */
    compressRetryContext: ((
      attempts: Parameters<HoplonEngine['compressRetryContext']>[0],
    ) => callUnary('compressRetryContext', attempts, 'compressRetryContext')) as
      unknown as HoplonEngine['compressRetryContext'],
    computeMinimalPatch: ((
      req: Parameters<HoplonEngine['computeMinimalPatch']>[0],
    ) => callUnary('computeMinimalPatch', req, 'computeMinimalPatch')) as
      unknown as HoplonEngine['computeMinimalPatch'],

    indexSemanticCorpus: (req, signal) =>
      callUnary('indexSemanticCorpus', req, corrOf(req), signal),
    semanticSearch: (req, signal) =>
      callUnary('semanticSearch', req, corrOf(req), signal),
    refreshSemanticOverlay: (req, signal) =>
      callUnary('refreshSemanticOverlay', req, corrOf(req), signal),
    clearSemanticOverlay: (req, signal) =>
      callUnary('clearSemanticOverlay', req, corrOf(req), signal),
    // t-062: see_codebase dispatches over gRPC via the shared proto registry.
    seeCodebase: (req, signal) =>
      callUnary('seeCodebase', req, corrOf(req), signal),
  };

  return engine;
}
