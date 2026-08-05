/**
 * tests/transport/http/client.test.ts — T2 proof suite.
 *
 * Proves:
 * 1. createRemoteHoplonEngine returns an object satisfying HoplonEngine interface
 *    (structural check: all 14 methods present at runtime)
 * 2. End-to-end via mock fetch: send request → verify body Zod-parseable →
 *    receive response → parse succeeds
 * 3. 4xx response → correct HoplonError subclass thrown
 * 4. Network refused → TransportError({ kind: 'connection_refused' })
 * 5. AbortSignal: abort mid-request → fetch cancellation propagates
 * 6. Authorization header injected when authToken provided
 * 7. 401/403 → TransportError({ kind: 'auth_failed' })
 * 8. Malformed JSON response → TransportError({ kind: 'malformed_response' })
 * 9. Valid schema-conformant response → parsed correctly (H24)
 * 10. compressRetryContext and computeMinimalPatch work over HTTP (behavioral divergence)
 * 11. t-056 methods searchSymbols and describeProject round-trip over HTTP
 * 12. t-036 method predictViolationRisk round-trips over HTTP
 * 13. t-027 method analyzeBlastRadius round-trips over HTTP
 * 14. t-118 method findReferencingSymbols round-trips over HTTP
 * 15. t-028 method synthesizeInterfaceStubs round-trips over HTTP
 * 16. t-108 method ephemeralStructuralSandbox round-trips over HTTP
 *
 * All tests use mock fetch — no real network.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import {
  createRemoteHoplonEngine,
} from '../../../src/hoplon/transport/http/client.js';
import {
  TransportError,
} from '../../../src/hoplon/transport/types.js';
import {
  ValidationError,
  SemanticError,
  AdapterError,
  EngineError,
} from '../../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:3000';
const CORR = 'corr-t2-test';
const ENGINE_ID = 'test-engine-0';
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-1',
  runId: 'run-1',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

type MockFetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Build a mock fetch that returns a 2xx JSON response. */
function mockFetchSuccess(body: unknown, status = 200): MockFetchImpl {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

/** Build a mock fetch that returns a non-2xx JSON error envelope. */
function mockFetchError(
  errorEnvelope: object,
  status: number,
): MockFetchImpl {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(errorEnvelope)),
  } as unknown as Response);
}

/** Build a mock fetch that throws a network error (connection refused). */
function mockFetchNetworkError(err: Error): MockFetchImpl {
  return vi.fn().mockRejectedValue(err);
}

// ---------------------------------------------------------------------------
// 1. Interface structural check — all methods present
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — structural interface satisfaction', () => {
  it('returns an object satisfying HoplonEngine interface (all methods present)', () => {
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL });

    // TypeScript structural check: engine must be assignable to HoplonEngine
    const _typeCheck: HoplonEngine = engine;
    void _typeCheck;

    // Runtime method-presence check
    const requiredMethods: (keyof HoplonEngine)[] = [
      'createSnapshot',
      'auditDiff',
      'revertUncontracted',
      'packContext',
      'health',
      'describeCapabilities',
      'reconcile',
      'dryRun',
      'preflight',
      'queryStructure',
      'extractStructuralTemplate',
      'gc',
      'compressRetryContext',
      'computeMinimalPatch',
      'getRelevantTests',
      'extractRollbackTemplate',
      'searchSymbols',
      'describeProject',
      'predictViolationRisk',
      'scoreAnomaly',
      'analyzeBlastRadius',
      'findReferencingSymbols',
      'synthesizeInterfaceStubs',
      'ephemeralStructuralSandbox',
      'indexSemanticCorpus',
      'semanticSearch',
      'refreshSemanticOverlay',
      'clearSemanticOverlay',
    ];

    for (const method of requiredMethods) {
      expect(typeof engine[method], `${method} should be a function`).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end via mock fetch — request body Zod-parseable, response parsed
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — end-to-end happy path', () => {
  it('createSnapshot: serializes request body and parses response', async () => {
    const mockResponse = {
      snapshotRef: {
        id: SNAPSHOT_ID,
        engineId: ENGINE_ID,
        runId: 'run-1',
        createdAt: '2026-04-13T00:00:00Z',
      },
      warnings: [],
    };
    const fetchMock = mockFetchSuccess(mockResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.createSnapshot({ manifest: VALID_MANIFEST });

    // Response parsed correctly
    expect(result.snapshotRef.id).toBe(SNAPSHOT_ID);
    expect(result.warnings).toHaveLength(0);

    // Request body is valid JSON and Zod-parseable
    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/createSnapshot`);
    const body = JSON.parse(callArgs[1].body as string) as unknown;
    expect(body).toBeTruthy();
    // Verify the body can be parsed back by the request schema
    const { CreateSnapshotRequestSchema } = await import('../../../src/hoplon/contracts/requests.js');
    const parsed = CreateSnapshotRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('health: GETs /health and parses response', async () => {
    const healthResponse = {
      engineId: ENGINE_ID,
      adapters: {
        fs: 'ok',
        versioning: 'ok',
        snapshotStore: 'ok',
        lockProvider: 'ok',
        emitter: 'ok',
        codeIntelligence: 'ok',
        secretScanner: 'ok',
        staticAnalysis: 'ok',
      },
      semantic: {
        status: 'UNAVAILABLE',
        capabilityClass: 'seam_only',
        runtimeProfile: 'noop',
        persistenceMode: 'process_local_overlay',
        adapters: {
          embedding: 'noop',
          vectorStore: 'noop',
          embeddingCache: 'noop',
          semanticIndexStore: 'noop',
          lexicalIndex: 'noop',
          vectorIndex: 'noop',
          semanticStorageProfile: 'noop',
        },
        embedding: { modelStatus: 'missing', artifactStatus: 'missing' },
        runtimeArtifacts: { nativeExtensionStatus: 'unavailable' },
        cache: { reachable: false },
        index: { reachable: false },
        overlays: {
          activeOverlayCount: 0,
          reapedOverlayCount: 0,
          documentCount: 0,
          vectorCount: 0,
          maskCount: 0,
        },
        tombstones: { reachable: false },
        degradationReasons: [],
      },
      uptimeMs: 500,
    };
    const fetchMock = mockFetchSuccess(healthResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.health();
    expect(result.engineId).toBe(ENGINE_ID);
    expect(result.adapters.fs).toBe('ok');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/health`);
    expect(callArgs[1].method).toBe('GET');
    expect(callArgs[1].body).toBeUndefined();
  });

  it('describeCapabilities: serializes request and parses response', async () => {
    const describeResponse = {
      catalogVersion: 1,
      engineId: ENGINE_ID,
      capabilities: [
        {
          descriptor: {
            contractSchemaVersion: 1,
            capabilityId: 'codeIntelligence',
            name: 'Code Intelligence',
            integrationPoint: 'core_adapter',
            runtimeState: 'shipped',
            defaultBinding: 'builtin',
            defaultWritePosture: 'read_only',
            sideEffectPosture: 'none',
            failureIsolation: 'core_operation',
            invocationMode: 'typed_engine_method',
            correlationFields: ['engineId', 'correlationId', 'projectId', 'runId', 'snapshotRefId'],
            versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
            dataAccess: [
              { dataClass: 'workspace_content', access: 'read_only' },
              { dataClass: 'workspace_metadata', access: 'read_only' },
            ],
            notes:
              'Tree-sitter is the shipped default. LSP- and SCIP-backed providers bind through this seam later.',
          },
          healthStatus: 'available',
        },
      ],
    };
    const fetchMock = mockFetchSuccess(describeResponse);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.describeCapabilities({ correlationId: CORR });
    expect(result.capabilities[0]?.descriptor.capabilityId).toBe('codeIntelligence');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/describeCapabilities`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['correlationId']).toBe(CORR);
  });

  it('auditDiff: serializes request, returns PASS result', async () => {
    const auditResponse = {
      status: 'PASS',
      checked: 2,
      auditSchemaVersion: 1,
      correlationId: CORR,
    };
    const fetchMock = mockFetchSuccess(auditResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.auditDiff({
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
    });
    expect(result.status).toBe('PASS');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/auditDiff`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['correlationId']).toBe(CORR);
  });

  it('packContext: serializes request and parses PackedContext response', async () => {
    const packedCtxResponse = {
      metadata: {
        strategyVersion: 1,
        grammarVersion: 'tree-sitter-typescript@0.20.0',
        packerVersion: 1,
        generatedAt: '2026-04-13T00:00:00Z',
        correlationId: CORR,
      },
      slices: [],
      failures: [],
    };
    const fetchMock = mockFetchSuccess(packedCtxResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.packContext({
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
      strategy: { kind: 'whole_file' },
    });
    expect(result.slices).toHaveLength(0);
    expect(result.metadata.correlationId).toBe(CORR);
  });

  it('gc: POSTs to /gc with filter body, returns deletedCount', async () => {
    const fetchMock = mockFetchSuccess({ deletedCount: 3 });
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.gc({ projectId: 'proj-1', olderThan: '2025-01-01T00:00:00Z' });
    expect(result.deletedCount).toBe(3);

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/gc`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('trailing slash on baseUrl is stripped', async () => {
    const fetchMock = mockFetchSuccess({ deletedCount: 0 });
    const engine = createRemoteHoplonEngine({
      baseUrl: 'http://localhost:3000/', // trailing slash
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    await engine.gc({});
    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('http://localhost:3000/gc');
  });

  it('searchSymbols: serializes request and parses response', async () => {
    const searchResponse = {
      matches: [
        {
          path: 'src/foo.ts',
          name: 'createSession',
          kind: 'function',
          byteRange: [0, 13],
          nodeKind: 'identifier',
        },
      ],
      failures: [],
      filesScanned: 1,
      truncated: false,
    };
    const fetchMock = mockFetchSuccess(searchResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.searchSymbols({
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      namePattern: '^create',
      files: ['src/foo.ts'],
      kinds: ['function'],
      maxResults: 5,
    });
    expect(result.matches[0]?.name).toBe('createSession');
    expect(result.truncated).toBe(false);

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/searchSymbols`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['namePattern']).toBe('^create');
  });

  it('describeProject: serializes request and parses response', async () => {
    const projectResponse = {
      files: {
        total: 2,
        byLanguage: [
          { language: 'javascript', fileCount: 0, samplePaths: [] },
          { language: 'typescript', fileCount: 2, samplePaths: ['a.ts', 'b.ts'] },
          { language: 'tsx', fileCount: 0, samplePaths: [] },
        ],
      },
      symbols: { exports: 2, imports: 1, types: 1, functions: 1, classes: 1 },
      filesScanned: 2,
      truncated: false,
      failures: [],
    };
    const fetchMock = mockFetchSuccess(projectResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.describeProject({
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      maxFiles: 10,
      samplePathsPerLanguage: 5,
    });
    expect(result.files.total).toBe(2);
    expect(result.failures).toEqual([]);

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/describeProject`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['maxFiles']).toBe(10);
  });

  it('predictViolationRisk: serializes request and parses response', async () => {
    const predictResponse = {
      probability: 0.4,
      riskBand: 'medium',
      advisory: true,
      sampleSize: 5,
      perKindProbabilities: { out_of_scope_symbol: 0.4 },
      featuresUsed: { projectId: 'proj-1', manifestScopeRatio: 0.5 },
      reason: 'base-rate 2/5=0.400',
    };
    const fetchMock = mockFetchSuccess(predictResponse);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.predictViolationRisk({
      projectId: 'proj-1',
      correlationId: CORR,
      proposedFeatures: { projectId: 'proj-1', manifestScopeRatio: 0.5 },
      historicalRecords: [],
    });
    expect(result.advisory).toBe(true);
    expect(result.riskBand).toBe('medium');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/predictViolationRisk`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('scoreAnomaly: serializes request and parses response (t-037)', async () => {
    const scoreResponse = {
      score: 0.6,
      isAnomalous: true,
      advisory: true,
      sampleSize: 5,
      signals: [
        {
          metric: 'astNodeCount',
          observedValue: 10_000,
          baselineValue: 100,
          stddev: 10,
          zScore: 990,
          description: 'astNodeCount z=990.00 exceeds threshold 3',
        },
      ],
      reason: 'sample=5; max-z=990.00; threshold=3; signals=1',
    };

    const fetchMock = mockFetchSuccess(scoreResponse);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.scoreAnomaly({
      projectId: 'proj-1',
      correlationId: CORR,
      proposedMetrics: { projectId: 'proj-1', astNodeCount: 10_000 },
      historicalRecords: [],
    });
    expect(result.advisory).toBe(true);
    expect(result.isAnomalous).toBe(true);
    expect(result.signals[0]?.metric).toBe('astNodeCount');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/scoreAnomaly`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('analyzeBlastRadius: serializes request and parses response (t-027)', async () => {
    const response = {
      correlationId: CORR,
      advisory: true,
      status: 'WARNING',
      providerAvailable: true,
      warnThreshold: 10,
      entries: [
        {
          symbol: {
            name: 'createHoplonEngine',
            kind: 'function',
            byteRange: [0, 18],
            path: 'src/hoplon/engine/factory.ts',
          },
          classification: 'warning',
          referenceCount: 12,
          affectedFileCount: 3,
          affectedFiles: [
            'src/hoplon/engine/factory.ts',
            'src/hoplon/engine/types.ts',
            'tests/engine/factory.test.ts',
          ],
          thresholdUsed: 10,
        },
      ],
    };
    const fetchMock = mockFetchSuccess(response);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.analyzeBlastRadius({
      correlationId: CORR,
      projectId: 'proj-1',
      symbols: [
        {
          name: 'createHoplonEngine',
          kind: 'function',
          byteRange: [0, 18],
          path: 'src/hoplon/engine/factory.ts',
        },
      ],
      warnThreshold: 10,
    });
    expect(result.advisory).toBe(true);
    expect(result.status).toBe('WARNING');
    expect(result.entries[0]?.referenceCount).toBe(12);

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/analyzeBlastRadius`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('findReferencingSymbols: serializes request and parses response (t-118)', async () => {
    const response = {
      correlationId: CORR,
      advisory: true,
      status: 'AVAILABLE',
      providerStatus: 'available',
      targetResolution: {
        status: 'resolved',
        symbol: {
          name: 'createHoplonEngine',
          kind: 'function',
          byteRange: [0, 18],
          path: 'src/hoplon/engine/factory.ts',
        },
        candidates: [
          {
            name: 'createHoplonEngine',
            kind: 'function',
            byteRange: [0, 18],
            path: 'src/hoplon/engine/factory.ts',
          },
        ],
        reason: 'direct_symbol',
      },
      references: [
        {
          path: 'src/hoplon/engine/types.ts',
          byteRange: [10, 28],
          containingSymbol: {
            name: 'HoplonEngine',
            kind: 'interface',
            byteRange: [0, 200],
            path: 'src/hoplon/engine/types.ts',
          },
          symbolResolution: 'resolved',
        },
      ],
      files: ['src/hoplon/engine/types.ts'],
      referenceCount: 1,
      providerError: null,
    };
    const fetchMock = mockFetchSuccess(response);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.findReferencingSymbols({
      correlationId: CORR,
      projectId: 'proj-1',
      target: {
        type: 'symbol_identity',
        symbol: {
          name: 'createHoplonEngine',
          kind: 'function',
          byteRange: [0, 18],
          path: 'src/hoplon/engine/factory.ts',
        },
      },
    });
    expect(result.advisory).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.references[0]?.containingSymbol?.name).toBe('HoplonEngine');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/findReferencingSymbols`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('synthesizeInterfaceStubs: serializes request and parses response (t-028)', async () => {
    const response = {
      correlationId: CORR,
      advisory: true,
      status: 'AUTHORITATIVE',
      stubs: [
        {
          target: { file: 'src/foo.ts', symbol: 'foo' },
          quality: 'authoritative',
          declaration: 'export declare function foo(): void;',
          reason: null,
          contractCount: 1,
        },
      ],
      authoritativeCount: 1,
      placeholderCount: 0,
    };
    const fetchMock = mockFetchSuccess(response);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.synthesizeInterfaceStubs({
      correlationId: CORR,
      projectId: 'proj-1',
      targets: [{ file: 'src/foo.ts', symbol: 'foo' }],
      signatureContracts: [
        {
          file: 'src/foo.ts',
          symbol: 'foo',
          expectedParams: [],
          expectedReturn: 'void',
        },
      ],
    });
    expect(result.advisory).toBe(true);
    expect(result.status).toBe('AUTHORITATIVE');
    expect(result.stubs[0]?.contractCount).toBe(1);

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/synthesizeInterfaceStubs`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });

  it('ephemeralStructuralSandbox: serializes request and parses response (t-108)', async () => {
    const response = {
      sandboxSchemaVersion: 1,
      correlationId: CORR,
      advisory: true,
      status: 'PARSE_AND_STRUCTURE_OK',
      checked: 1,
      snippets: [
        {
          id: 's1',
          path: 'synthetic/snippet.ts',
          status: 'STRUCTURE_OK',
          parse: {
            status: 'OK',
            parser: 'codeIntelligence.parse',
            language: 'typescript',
            errorMessage: null,
          },
          structure: {
            status: 'OK',
            rootKind: 'program',
            nodeKindCounts: { program: 1 },
            errorNodeCount: 0,
            topLevelSymbols: [],
            expectationFailures: [],
          },
        },
      ],
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
    const fetchMock = mockFetchSuccess(response);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    const result = await engine.ephemeralStructuralSandbox({
      correlationId: CORR,
      projectId: 'proj-1',
      snippets: [
        {
          id: 's1',
          path: 'synthetic/snippet.ts',
          content: 'export const x = 1;',
        },
      ],
    });
    expect(result.advisory).toBe(true);
    expect(result.typeProvider.compilerProof).toBe(false);
    expect(result.nonBypass.doesNotReplace).toContain('auditDiff');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(`${BASE_URL}/ephemeralStructuralSandbox`);
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body['projectId']).toBe('proj-1');
  });
});

// ---------------------------------------------------------------------------
// 3. 4xx response → correct HoplonError subclass thrown
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — error envelope translation', () => {
  it('ValidationError envelope → throws ValidationError', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'ValidationError',
        kind: 'invalid_manifest',
        message: 'Manifest entries array is empty',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 400);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.createSnapshot({ manifest: VALID_MANIFEST })).rejects.toBeInstanceOf(ValidationError);
  });

  it('ValidationError has correct kind', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'ValidationError',
        kind: 'path_traversal',
        message: 'Path traversal detected',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 400);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.auditDiff({
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-1',
        runId: 'run-1',
        correlationId: CORR,
        files: ['../etc/passwd'],
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).kind).toBe('path_traversal');
    }
  });

  it('ValidationError preserves semanticSearch recovery guidance from HTTP envelope', async () => {
    const recovery = {
      error: true,
      kind: 'invalid_semantic_search_request',
      advisory: true,
      tool: 'semanticSearch',
      diagnostics: [{ fieldPath: 'query', code: 'invalid_type', message: 'missing', expectedShape: 'non-empty string' }],
      minimalValidRequest: {
        correlationId: 'corr-semantic-search',
        projectId: 'project-id',
        query: 'semantic search query',
        topK: 5,
      },
      requestShape: {
        required: ['correlationId', 'projectId', 'query', 'topK'],
        optional: [],
      },
    };
    const fetchMock = mockFetchError({
      error: {
        name: 'ValidationError',
        kind: 'invalid_scope',
        message: 'semanticSearch: invalid request',
        engineId: ENGINE_ID,
        correlationId: CORR,
        recovery,
      },
    }, 400);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.semanticSearch({
        projectId: 'proj-1',
        correlationId: CORR,
        query: 'alpha',
        topK: 3,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError & { recovery?: unknown }).recovery).toEqual(recovery);
    }
  });

  it('SemanticError envelope → throws SemanticError', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'SemanticError',
        kind: 'snapshot_missing',
        message: 'Snapshot not found',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 404);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.auditDiff({
      snapshotRefId: 'sha256:' + 'b'.repeat(64),
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
    })).rejects.toBeInstanceOf(SemanticError);
  });

  it('AdapterError envelope → throws AdapterError', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'AdapterError',
        kind: 'snapshot_store_read_failed',
        message: 'Database connection error',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 503);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.health()).rejects.toBeInstanceOf(AdapterError);
  });

  it('EngineError envelope → throws EngineError', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'EngineError',
        kind: 'reconcile_failed',
        message: 'Reconcile failed',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 500);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.reconcile()).rejects.toBeInstanceOf(EngineError);
  });

  it('TransportError envelope → throws TransportError', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'TransportError',
        kind: 'stream_interrupted',
        message: 'Stream was interrupted',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 500);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.packContext({
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
      strategy: { kind: 'whole_file' },
    })).rejects.toBeInstanceOf(TransportError);
  });

  it('unknown error name → throws EngineError({ kind: remote_not_supported })', async () => {
    const fetchMock = mockFetchError({
      error: {
        name: 'UnknownHoplonError',
        kind: 'something_weird',
        message: 'Unknown error occurred',
        engineId: ENGINE_ID,
        correlationId: CORR,
      },
    }, 500);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).kind).toBe('remote_not_supported');
    }
  });

  it('non-conforming error body → TransportError({ kind: malformed_response })', async () => {
    const fetchMock = mockFetchError({ not_an_error_envelope: true }, 500);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });

  it('non-JSON error body → TransportError({ kind: malformed_response })', async () => {
    // Mock that returns plain text body (not JSON)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    } as unknown as Response);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as unknown as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Network refused → TransportError({ kind: 'connection_refused' })
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — network error translation', () => {
  it('connection refused → TransportError({ kind: connection_refused })', async () => {
    const networkErr = new Error('connect ECONNREFUSED 127.0.0.1:3000');
    (networkErr as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    const fetchMock = mockFetchNetworkError(networkErr);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('connection_refused');
    }
  });

  it('connection_refused TransportError carries cause', async () => {
    const networkErr = new Error('ECONNREFUSED');
    const fetchMock = mockFetchNetworkError(networkErr);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TransportError).cause).toBe(networkErr);
    }
  });

  it('generic fetch error → TransportError({ kind: connection_refused })', async () => {
    const fetchMock = mockFetchNetworkError(new Error('Network error'));
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    await expect(engine.reconcile()).rejects.toBeInstanceOf(TransportError);
  });
});

// ---------------------------------------------------------------------------
// 5. AbortSignal — cancellation propagates
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — AbortSignal propagation', () => {
  it('abort mid-request → TransportError({ kind: timeout })', async () => {
    const controller = new AbortController();

    // Mock fetch that captures the signal and rejects with AbortError
    let capturedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          // Abort immediately
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      },
    );

    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    controller.abort();
    try {
      await engine.health(controller.signal);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('timeout');
    }

    // The signal was passed to fetch
    expect(capturedSignal).toBe(controller.signal);
  });

  it('signal passed to fetch even when not aborted', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null = null;

    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            reconciled: 0,
            failed: 0,
            orphans: { gitObjects: 0, pendingRows: 0 },
          })),
        } as unknown as Response);
      },
    );

    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    await engine.reconcile(controller.signal);
    expect(capturedSignal).toBe(controller.signal);
  });

  it('abort before response body read → TransportError({ kind: timeout })', async () => {
    const controller = new AbortController();

    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        // Abort the signal
        if (signal) {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          return Promise.reject(abortErr);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{}'),
        } as unknown as Response);
      },
    );

    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    controller.abort();
    await expect(engine.health(controller.signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof TransportError && (err as TransportError).kind === 'timeout',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Authorization header
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — Authorization header', () => {
  it('injects Authorization: Bearer when authToken provided', async () => {
    const fetchMock = mockFetchSuccess({
      reconciled: 0, failed: 0, orphans: { gitObjects: 0, pendingRows: 0 },
    });
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      authToken: 'my-secret-token',
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    await engine.reconcile();

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-secret-token');
  });

  it('no Authorization header when authToken not provided', async () => {
    const fetchMock = mockFetchSuccess({
      reconciled: 0, failed: 0, orphans: { gitObjects: 0, pendingRows: 0 },
    });
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    await engine.reconcile();

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. 401 / 403 → TransportError({ kind: 'auth_failed' })
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — auth status codes', () => {
  it('401 response → TransportError({ kind: auth_failed })', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as unknown as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('auth_failed');
    }
  });

  it('403 response → TransportError({ kind: auth_failed })', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as unknown as Response);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as unknown as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('auth_failed');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed response body → TransportError({ kind: 'malformed_response' })
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — malformed response body', () => {
  it('non-JSON 2xx response → TransportError({ kind: malformed_response })', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('NOT-JSON{{{'),
    } as unknown as Response);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as unknown as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });

  it('valid JSON but wrong schema → TransportError({ kind: malformed_response })', async () => {
    // Returns valid JSON but not matching EngineHealthSchema
    const fetchMock = mockFetchSuccess({ unexpected: 'shape', foo: 42 });
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    try {
      await engine.health();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });
});

// ---------------------------------------------------------------------------
// 9. H24 — valid round-trip via mock fetch
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — H24 round-trip', () => {
  it('revertUncontracted: body round-trips through schema', async () => {
    const revertResponse = {
      reverted: ['src/foo.ts'],
      deleted: ['src/extra.ts'],
      allowlistSkipped: [],
    };
    const fetchMock = mockFetchSuccess(revertResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.revertUncontracted({
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
    });
    expect(result.reverted).toEqual(['src/foo.ts']);
    expect(result.deleted).toEqual(['src/extra.ts']);

    // Verify the sent body parses through the request schema
    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as unknown;
    const { RevertRequestSchema } = await import('../../../src/hoplon/contracts/requests.js');
    expect(RevertRequestSchema.safeParse(body).success).toBe(true);
  });

  it('dryRun: sends proposedChanges, returns AuditResult', async () => {
    const auditResponse = {
      status: 'BLOCK',
      auditSchemaVersion: 1,
      correlationId: CORR,
      violations: [
        {
          kind: 'uncontracted_file',
          path: 'src/extra.ts',
          firstChangedLine: 1,
          sourceSlice: '',
          message: 'not in manifest',
          correction: 'add to manifest',
        },
      ],
    };
    const fetchMock = mockFetchSuccess(auditResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.dryRun({
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      proposedChanges: [{ file: 'src/foo.ts', content: 'const x = 1;' }],
    });
    expect(result.status).toBe('BLOCK');
  });

  it('indexSemanticCorpus and semanticSearch dispatch over HTTP with validated responses', async () => {
    const indexResponse = {
      correlationId: CORR,
      projectId: 'proj-1',
      status: 'AVAILABLE',
      providerStatus: 'AVAILABLE',
      providerAvailable: true,
      resultCount: 1,
      freshness: 'indexed',
      degradationReasons: [],
      indexedCount: 1,
      requestedCount: 1,
    };
    const searchResponse = {
      correlationId: CORR,
      projectId: 'proj-1',
      advisory: true,
      status: 'AVAILABLE',
      providerStatus: 'AVAILABLE',
      providerAvailable: true,
      resultCount: 1,
      freshness: 'indexed',
      degradationReasons: [],
      topK: 3,
      suggestions: [
        {
          kind: 'query',
          message: 'Use a more specific symbol or path token.',
          provenance: 'semantic',
        },
      ],
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
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(indexResponse)),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(searchResponse)),
      } as unknown as Response);
    const engine = createRemoteHoplonEngine({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    const indexResult = await engine.indexSemanticCorpus({
      projectId: 'proj-1',
      correlationId: CORR,
      documents: [
        {
          id: 'doc-alpha',
          text: 'alpha semantic document',
          metadata: { path: 'src/alpha.ts' },
        },
      ],
    });
    expect(indexResult.status).toBe('AVAILABLE');
    expect(indexResult.indexedCount).toBe(1);

    const searchResult = await engine.semanticSearch({
      projectId: 'proj-1',
      correlationId: CORR,
      query: 'alpha',
      topK: 3,
    });
    expect(searchResult.advisory).toBe(true);
    expect(searchResult.suggestions?.[0]).toMatchObject({
      kind: 'query',
      provenance: 'semantic',
    });
    expect(searchResult.matches[0]?.id).toBe('doc-alpha');
    expect(searchResult.matches[0]?.rankSource).toBe('baseline_vector');

    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(`${BASE_URL}/indexSemanticCorpus`);
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toBe(`${BASE_URL}/semanticSearch`);
  });

  it('preflight: sends manifest, returns PreflightResult', async () => {
    const preflightResponse = {
      status: 'PASS',
      gates: [{ gateName: 'path_traversal', status: 'PASS', violations: [], durationMs: 2 }],
      correlationId: CORR,
    };
    const fetchMock = mockFetchSuccess(preflightResponse);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const result = await engine.preflight({
      manifest: VALID_MANIFEST,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
    });
    expect(result.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// 10. Behavioral divergence: compressRetryContext / computeMinimalPatch
// ---------------------------------------------------------------------------

describe('createRemoteHoplonEngine — sync method behavioral divergence', () => {
  it('compressRetryContext dispatches POST to /compressRetryContext', async () => {
    const mockResult = {
      attemptCount: 1,
      structuralDelta: 'No previous attempts.',
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      retryDirective: 'Fix the violation.',
    };
    const fetchMock = mockFetchSuccess(mockResult);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    // Over HTTP this returns a Promise, not a direct value
    const resultOrPromise = engine.compressRetryContext([
      {
        attemptNumber: 1,
        proposedContent: 'const x = 1;',
        violations: [],
      },
    ]);

    // Verify it's thenable (Promise)
    expect(typeof (resultOrPromise as unknown as Promise<unknown>).then).toBe('function');
    const result = await (resultOrPromise as unknown as Promise<typeof mockResult>);
    expect(result.attemptCount).toBe(1);
    expect(result.retryDirective).toBe('Fix the violation.');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/compressRetryContext`);
  });

  it('computeMinimalPatch dispatches POST to /computeMinimalPatch', async () => {
    const mockResult = {
      patchable: true,
      action: 'REMOVE_NODES' as const,
      violationRanges: [[0, 10]] as [number, number][],
      keepRanges: [[10, 100]] as [number, number][],
      correctedContent: 'const y = 2;',
      retryPrompt: 'Remove the out-of-scope symbol.',
      unpatchableViolations: [],
    };
    const fetchMock = mockFetchSuccess(mockResult);
    const engine = createRemoteHoplonEngine({ baseUrl: BASE_URL, fetchImpl: fetchMock as typeof globalThis.fetch });

    const resultOrPromise = engine.computeMinimalPatch({
      content: 'const x = 1; const y = 2;',
      violations: [
        {
          kind: 'out_of_scope_symbol',
          path: 'src/foo.ts',
          symbolName: 'x',
          nodeKind: 'variable_declaration',
          byteRange: [0, 10],
          sourceSlice: 'const x = 1;',
          expectedScope: { kind: 'whole_file' },
          message: 'x is out of scope',
          correction: 'Remove x',
        },
      ],
    });

    expect(typeof (resultOrPromise as unknown as Promise<unknown>).then).toBe('function');
    const result = await (resultOrPromise as unknown as Promise<typeof mockResult>);
    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');

    const callArgs = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe(`${BASE_URL}/computeMinimalPatch`);
  });
});
