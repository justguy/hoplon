/**
 * tests/transport/dispatcher.test.ts — T-024 sub-slice A proof.
 *
 * Verifies the transport-agnostic engine dispatcher:
 *   - registry parity (operations === HOPLON_PROTO_OPERATIONS)
 *   - unknown method → ValidationError(kind='invalid_scope') with req engineId/correlationId
 *   - invalid body → ValidationError(kind='invalid_scope') with Zod cause attached
 *   - each of the four call shapes dispatches with the correct arguments
 *   - gc omits undefined keys before calling engine.gc
 *   - sync engine methods (computeMinimalPatch, compressRetryContext) flow through as Promise values
 *   - signal is forwarded to async_body_signal and async_signal_only methods
 *
 * No HTTP, no Fastify — just the dispatcher + a spy engine.
 */

import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';

import { createEngineDispatcher } from '../../src/hoplon/transport/dispatcher.js';
import { HOPLON_PROTO_OPERATIONS } from '../../src/hoplon/transport/proto/registry.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import { SemanticSearchRequestValidationError } from '../../src/hoplon/contracts/semanticSearchRecovery.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

const ENGINE_ID = 'test-dispatcher';
const CORR = 'corr-dispatcher';

// ---------------------------------------------------------------------------
// Spy engine — every method is a vi.fn with a deterministic canned return.
// Individual tests override only the methods they exercise.
// ---------------------------------------------------------------------------

function buildSpyEngine(overrides: Partial<HoplonEngine> = {}): HoplonEngine {
  const unused = (): never => {
    throw new Error('spy engine method not wired for this test');
  };
  const base: HoplonEngine = {
    createSnapshot: vi.fn(unused),
    auditDiff: vi.fn(unused),
    revertUncontracted: vi.fn(unused),
    packContext: vi.fn(unused),
    dryRun: vi.fn(unused),
    preflight: vi.fn(unused),
    queryStructure: vi.fn(unused),
    extractStructuralTemplate: vi.fn(unused),
    extractRollbackTemplate: vi.fn(unused),
    getRelevantTests: vi.fn(unused),
    searchSymbols: vi.fn(unused),
    describeProject: vi.fn(unused),
    predictViolationRisk: vi.fn(unused),
    scoreAnomaly: vi.fn(unused),
    analyzeBlastRadius: vi.fn(unused),
    findReferencingSymbols: vi.fn(unused),
    synthesizeInterfaceStubs: vi.fn(unused),
    ephemeralStructuralSandbox: vi.fn(unused),
    describeCapabilities: vi.fn(unused),
    semanticSearch: vi.fn(unused),
    indexSemanticCorpus: vi.fn(unused),
    refreshSemanticOverlay: vi.fn(unused),
    clearSemanticOverlay: vi.fn(unused),
    health: vi.fn(unused),
    reconcile: vi.fn(unused),
    gc: vi.fn(unused),
    computeMinimalPatch: vi.fn(unused),
    compressRetryContext: vi.fn(unused),
  } as unknown as HoplonEngine;
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Registry parity + operationFor
// ---------------------------------------------------------------------------

describe('dispatcher registry', () => {
  it('exposes the shared proto registry as operations', () => {
    const d = createEngineDispatcher(buildSpyEngine());
    expect(d.operations).toBe(HOPLON_PROTO_OPERATIONS);
    // Sanity: every HoplonEngine method appears exactly once.
    const methods = d.operations.map((op) => op.method);
    expect(new Set(methods).size).toBe(methods.length);
    expect(methods).toContain('createSnapshot');
    expect(methods).toContain('health');
    expect(methods).toContain('reconcile');
    expect(methods).toContain('gc');
    expect(methods).toContain('computeMinimalPatch');
    expect(methods).toContain('compressRetryContext');
    expect(methods).toContain('findReferencingSymbols');
    expect(methods).toContain('ephemeralStructuralSandbox');
    expect(methods).toContain('indexSemanticCorpus');
    expect(methods).toContain('semanticSearch');
  });

  it('operationFor(method) returns the op or null', () => {
    const d = createEngineDispatcher(buildSpyEngine());
    expect(d.operationFor('health')?.rpcName).toBe('Health');
    expect(d.operationFor('not-a-method')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown method → ValidationError
// ---------------------------------------------------------------------------

describe('dispatcher unknown method', () => {
  it('throws ValidationError with kind=invalid_scope carrying req identity', async () => {
    const d = createEngineDispatcher(buildSpyEngine());
    const p = d.invoke({
      method: 'nonExistentMethod',
      body: {},
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    try {
      await p;
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.kind).toBe('invalid_scope');
      expect(ve.engineId).toBe(ENGINE_ID);
      expect(ve.correlationId).toBe(CORR);
      expect(ve.message).toMatch(/Unknown engine method/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid body → ValidationError with Zod cause
// ---------------------------------------------------------------------------

describe('dispatcher body validation', () => {
  it('throws ValidationError(invalid_scope) with Zod cause on malformed body', async () => {
    const d = createEngineDispatcher(buildSpyEngine());
    // getRelevantTests requires projectId/runId/correlationId/modifiedFiles.
    const p = d.invoke({
      method: 'getRelevantTests',
      body: { projectId: 'only-this' }, // missing required fields
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    try {
      await p;
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.kind).toBe('invalid_scope');
      expect(ve.engineId).toBe(ENGINE_ID);
      expect(ve.correlationId).toBe(CORR);
      expect(ve.cause).toBeInstanceOf(ZodError);
    }
  });

  it('attaches semanticSearch recovery guidance on malformed semantic body', async () => {
    const d = createEngineDispatcher(buildSpyEngine());
    const p = d.invoke({
      method: 'semanticSearch',
      body: {
        projectId: 'proj-sem',
        correlationId: 'corr-sem',
        topK: 3,
        qurey: 'alpha',
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    await expect(p).rejects.toBeInstanceOf(SemanticSearchRequestValidationError);
    try {
      await p;
    } catch (err) {
      const ve = err as SemanticSearchRequestValidationError;
      expect(ve.recovery.diagnostics).toContainEqual(
        expect.objectContaining({
          fieldPath: 'query',
          message: "Missing required semanticSearch field 'query'",
        }),
      );
      expect(ve.recovery.diagnostics).toContainEqual(
        expect.objectContaining({ fieldPath: 'qurey', didYouMean: 'query' }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. async_body_signal — forwards parsed body + signal
// ---------------------------------------------------------------------------

describe('dispatcher async_body_signal shape', () => {
  it('forwards parsed body and signal to engine method', async () => {
    const received: { req?: unknown; signal?: AbortSignal } = {};
    const engine = buildSpyEngine({
      getRelevantTests: async (req, signal) => {
        received.req = req;
        received.signal = signal;
        return {
          relevantTests: [],
          coverageConfidence: 'exact',
          unusedModifiedFiles: [],
        };
      },
    });
    const d = createEngineDispatcher(engine);
    const signal = new AbortController().signal;
    const result = await d.invoke({
      method: 'getRelevantTests',
      body: {
        projectId: 'proj',
        runId: 'run',
        correlationId: 'corr',
        modifiedFiles: ['src/a.ts'],
      },
      signal,
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(result).toEqual({
      relevantTests: [],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const parsed = received.req as { projectId: string; maxDepth: number };
    expect(parsed.projectId).toBe('proj');
    // Zod defaults are applied — maxDepth must be present with the default.
    expect(parsed.maxDepth).toBe(2);
    expect(received.signal).toBe(signal);
  });

  it('dispatches findReferencingSymbols without touching PASS/BLOCK methods', async () => {
    const resultBody = {
      correlationId: 'corr-ref',
      advisory: true as const,
      status: 'UNAVAILABLE' as const,
      providerStatus: 'unavailable' as const,
      targetResolution: {
        status: 'resolved' as const,
        symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] as [number, number] },
        candidates: [{ name: 'alpha', kind: 'function', byteRange: [0, 5] as [number, number] }],
        reason: 'direct_symbol' as const,
      },
      references: [],
      files: [],
      referenceCount: 0,
      providerError: null,
    };
    const engine = buildSpyEngine({
      findReferencingSymbols: vi.fn(async () => resultBody),
      auditDiff: vi.fn(),
      dryRun: vi.fn(),
      preflight: vi.fn(),
    });
    const d = createEngineDispatcher(engine);
    const result = await d.invoke({
      method: 'findReferencingSymbols',
      body: {
        projectId: 'proj',
        correlationId: 'corr-ref',
        target: {
          type: 'symbol_identity',
          symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] },
        },
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(result).toEqual(resultBody);
    expect(engine.findReferencingSymbols).toHaveBeenCalledOnce();
    expect(engine.auditDiff).not.toHaveBeenCalled();
    expect(engine.dryRun).not.toHaveBeenCalled();
    expect(engine.preflight).not.toHaveBeenCalled();
  });

  it('forwards ephemeralStructuralSandbox requests and signal', async () => {
    const received: { req?: unknown; signal?: AbortSignal } = {};
    const engine = buildSpyEngine({
      ephemeralStructuralSandbox: async (req, signal) => {
        received.req = req;
        received.signal = signal;
        return {
          sandboxSchemaVersion: 1,
          correlationId: req.correlationId,
          advisory: true,
          status: 'PARSE_AND_STRUCTURE_OK',
          checked: 1,
          snippets: [],
          typeProvider: {
            status: 'NOT_REQUESTED',
            providerId: null,
            reason: null,
            compilerProof: false,
          },
          sideEffectProfile: {
            inMemoryOnly: true,
            detachedAstContext: true,
            usesFilesystem: false,
            usesVersioning: false,
            usesSnapshotStore: false,
            usesAuditLog: false,
            usesSessionMutation: false,
            usesLocks: false,
          },
          authority: {
            canMutateFiles: false,
            canChangeDeterministicVerdict: false,
            deterministicVerdictAuthority: 'structural_manifest_policy_only',
          },
          nonBypass: {
            doesNotReplace: ['dryRun', 'auditDiff', 'policy', 'session_apply_edits'],
            successCannotAuthorizeWrites: true,
          },
        };
      },
    });
    const d = createEngineDispatcher(engine);
    const signal = new AbortController().signal;
    const body = {
      correlationId: 'corr-sandbox',
      snippets: [{ id: 's1', path: 'snippet.ts', content: 'export const x = 1;' }],
    };
    const result = await d.invoke({
      method: 'ephemeralStructuralSandbox',
      body,
      signal,
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(result).toMatchObject({ status: 'PARSE_AND_STRUCTURE_OK' });
    expect((received.req as { correlationId: string }).correlationId).toBe('corr-sandbox');
    expect(received.signal).toBe(signal);
  });

  it('dispatches semantic index and search through the active engine methods', async () => {
    const engine = buildSpyEngine({
      indexSemanticCorpus: vi.fn(async (req) => ({
        correlationId: req.correlationId,
        projectId: req.projectId,
        status: 'AVAILABLE',
        providerStatus: 'AVAILABLE',
        providerAvailable: true,
        resultCount: req.documents.length,
        freshness: 'indexed',
        degradationReasons: [],
        indexedCount: req.documents.length,
        requestedCount: req.documents.length,
      })),
      semanticSearch: vi.fn(async (req) => ({
        correlationId: req.correlationId,
        projectId: req.projectId,
        advisory: true,
        status: 'AVAILABLE',
        providerStatus: 'AVAILABLE',
        providerAvailable: true,
        resultCount: 1,
        freshness: 'indexed',
        degradationReasons: [],
        topK: req.topK,
        matches: [
          {
            id: 'doc-alpha',
            score: 0.91,
            metadata: { path: 'src/alpha.ts' },
            source: 'baseline',
            rankSource: 'baseline_vector',
            freshness: 'indexed',
          },
        ],
      })),
    });
    const d = createEngineDispatcher(engine);

    const indexResult = await d.invoke({
      method: 'indexSemanticCorpus',
      body: {
        projectId: 'proj-sem',
        correlationId: 'corr-sem-index',
        documents: [{ id: 'doc-alpha', text: 'alpha semantic document' }],
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(indexResult).toMatchObject({ status: 'AVAILABLE', indexedCount: 1 });

    const searchResult = await d.invoke({
      method: 'semanticSearch',
      body: {
        projectId: 'proj-sem',
        correlationId: 'corr-sem-search',
        query: 'alpha',
        topK: 3,
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(searchResult).toMatchObject({
      advisory: true,
      status: 'AVAILABLE',
      resultCount: 1,
    });
    expect(engine.indexSemanticCorpus).toHaveBeenCalledOnce();
    expect(engine.semanticSearch).toHaveBeenCalledOnce();
    expect(engine.auditDiff).not.toHaveBeenCalled();
    expect(engine.dryRun).not.toHaveBeenCalled();
    expect(engine.preflight).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. async_signal_only — health + reconcile
// ---------------------------------------------------------------------------

describe('dispatcher async_signal_only shape', () => {
  it('calls engine.health with the signal and ignores body', async () => {
    let capturedSignal: AbortSignal | undefined;
    const engine = buildSpyEngine({
      health: async (signal) => {
        capturedSignal = signal;
        return {
          engineId: ENGINE_ID,
          snapshotStore: 'ok',
          gitRepo: 'ok',
          grammars: [],
          pool: { kind: 'single' },
        } as unknown as ReturnType<HoplonEngine['health']> extends Promise<infer T> ? T : never;
      },
    });
    const d = createEngineDispatcher(engine);
    const signal = new AbortController().signal;
    await d.invoke({
      method: 'health',
      body: { this: 'should', be: 'ignored' },
      signal,
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(capturedSignal).toBe(signal);
  });

  it('calls engine.reconcile with the signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const engine = buildSpyEngine({
      reconcile: async (signal) => {
        capturedSignal = signal;
        return {
          scanned: 0,
          resolved: 0,
          failed: 0,
        } as unknown as ReturnType<HoplonEngine['reconcile']> extends Promise<infer T> ? T : never;
      },
    });
    const d = createEngineDispatcher(engine);
    const signal = new AbortController().signal;
    await d.invoke({
      method: 'reconcile',
      signal,
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(capturedSignal).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// 6. async_body_no_signal — gc opts omit undefined keys
// ---------------------------------------------------------------------------

describe('dispatcher async_body_no_signal shape (gc)', () => {
  it('omits undefined keys from opts before calling engine.gc', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const engine = buildSpyEngine({
      gc: async (opts) => {
        receivedOpts = opts as Record<string, unknown>;
        return { deletedCount: 0 };
      },
    });
    const d = createEngineDispatcher(engine);
    await d.invoke({
      method: 'gc',
      body: { projectId: 'proj-only' },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(receivedOpts).toBeDefined();
    expect(Object.keys(receivedOpts as object).sort()).toEqual(['projectId']);
    expect((receivedOpts as { projectId: string }).projectId).toBe('proj-only');
  });

  it('keeps snapshot and semantic maintenance keys when provided', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const engine = buildSpyEngine({
      gc: async (opts) => {
        receivedOpts = opts as Record<string, unknown>;
        return { deletedCount: 3 };
      },
    });
    const d = createEngineDispatcher(engine);
    await d.invoke({
      method: 'gc',
      body: {
        projectId: 'p',
        olderThan: '2026-01-01T00:00:00Z',
        expiredBefore: '2026-02-01T00:00:00Z',
        semanticCache: true,
        semanticOverlays: true,
        semanticTombstones: true,
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(Object.keys(receivedOpts as object).sort()).toEqual([
      'expiredBefore',
      'olderThan',
      'projectId',
      'semanticCache',
      'semanticOverlays',
      'semanticTombstones',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. sync_body — computeMinimalPatch + compressRetryContext
// ---------------------------------------------------------------------------

describe('dispatcher sync_body shape', () => {
  it('calls engine.compressRetryContext synchronously and surfaces result through Promise', async () => {
    const canned = {
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      structuralDelta: '',
      retryDirective: 'Retry with fresh context.',
    };
    const engine = buildSpyEngine({
      compressRetryContext: vi.fn(() => canned),
    });
    const d = createEngineDispatcher(engine);
    const result = await d.invoke({
      method: 'compressRetryContext',
      body: [], // empty PriorAttempt[] is valid
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(result).toEqual(canned);
    expect(engine.compressRetryContext).toHaveBeenCalledTimes(1);
    expect(engine.compressRetryContext).toHaveBeenCalledWith([]);
  });

  it('calls engine.computeMinimalPatch synchronously and surfaces result', async () => {
    const canned = {
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE' as const,
      violationRanges: [],
      keepRanges: [],
      retryPrompt: 'irrelevant',
    };
    const engine = buildSpyEngine({
      computeMinimalPatch: vi.fn(() => canned as unknown as ReturnType<HoplonEngine['computeMinimalPatch']>),
    });
    const d = createEngineDispatcher(engine);
    const violations = [
      {
        kind: 'out_of_scope_symbol' as const,
        path: 'src/a.ts',
        symbolName: 'x',
        nodeKind: 'function_declaration',
        byteRange: [0, 10] as [number, number],
        sourceSlice: 'abc',
        expectedScope: { kind: 'symbols' as const, symbols: ['y'] },
        message: 'detected',
        correction: 'fix it',
      },
    ];
    const result = await d.invoke({
      method: 'computeMinimalPatch',
      body: {
        content: 'abc',
        violations,
      },
      engineId: ENGINE_ID,
      correlationId: CORR,
    });
    expect(result).toBe(canned);
    expect(engine.computeMinimalPatch).toHaveBeenCalledTimes(1);
  });
});
