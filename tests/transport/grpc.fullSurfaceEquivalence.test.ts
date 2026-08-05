import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fastifyFactory from 'fastify';
import type { FastifyInstance } from 'fastify';

const testRequire = createRequire(import.meta.url);
const longModule = testRequire('long') as { default?: unknown } & Record<string, unknown>;
const longCtor = typeof longModule === 'function' ? longModule : longModule.default ?? longModule;
for (const spec of ['protobufjs/minimal', 'protobufjs/light', 'protobufjs']) {
  const pb = testRequire(spec) as { util?: { Long?: unknown }; configure?: () => void };
  if (pb?.util) {
    pb.util.Long = longCtor;
    pb.configure?.();
  }
}

import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { PackedContext } from '../../src/hoplon/contracts/context.js';
import { createHoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import type { HoplonGrpcServer } from '../../src/hoplon/transport/grpc/server.js';
import { createRemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';
import type { RemoteHoplonGrpcEngine } from '../../src/hoplon/transport/grpc/client.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';

const ENGINE_ID = 'test-engine-full-eq1';
const CORR = 'corr-full-eq1';
const NOW = '2026-04-17T00:00:00Z';
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

const MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-eq1',
  runId: 'run-eq1',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

const PACKED: PackedContext = {
  metadata: {
    strategyVersion: 1,
    grammarVersion: 'tree-sitter-typescript@0.20.0',
    packerVersion: 1,
    generatedAt: NOW,
    correlationId: CORR,
  },
  slices: [{ path: 'src/foo.ts', byteRange: [0, 18], nodeKinds: ['program'], content: 'export const x = 1;' }],
  failures: [],
};

const AUDIT_LOG = {
  id: '11111111-1111-4111-8111-111111111111',
  snapshotId: SNAPSHOT_ID,
  projectId: 'proj-eq1',
  runId: 'run-eq1',
  engineId: ENGINE_ID,
  correlationId: CORR,
  operation: 'AUDIT_DIFF' as const,
  result: 'PASS' as const,
  violationCount: 0,
  violationKinds: [],
  durationMs: 1,
  createdAt: NOW,
  astNodeCount: 10,
  fileLineCount: 1,
  manifestScopeRatio: 1,
};

function buildMockEngine(): HoplonEngine {
  return {
    createSnapshot: async () => ({ snapshotRef: { id: SNAPSHOT_ID, engineId: ENGINE_ID, runId: 'run-eq1', createdAt: NOW }, warnings: [] }),
    auditDiff: async () => ({ status: 'PASS' as const, checked: 1, auditSchemaVersion: 1, correlationId: CORR }),
    revertUncontracted: async () => ({ reverted: ['src/foo.ts'], deleted: [], allowlistSkipped: ['.git/config'] }),
    packContext: async () => PACKED,
    dryRun: async () => ({ status: 'PASS' as const, checked: 1, auditSchemaVersion: 1, correlationId: CORR }),
    preflight: async () => ({ status: 'PASS' as const, gates: [], correlationId: CORR }),
    health: async () => ({
      engineId: ENGINE_ID,
      adapters: {
        fs: 'ok' as const,
        versioning: 'ok' as const,
        snapshotStore: 'ok' as const,
        lockProvider: 'ok' as const,
        emitter: 'ok' as const,
        codeIntelligence: 'ok' as const,
        secretScanner: 'ok' as const,
        staticAnalysis: 'ok' as const,
      },
      semantic: {
        status: 'UNAVAILABLE' as const,
        capabilityClass: 'seam_only' as const,
        runtimeProfile: 'noop' as const,
        persistenceMode: 'process_local_overlay' as const,
        adapters: {
          embedding: 'noop' as const,
          vectorStore: 'noop' as const,
          embeddingCache: 'noop' as const,
          semanticIndexStore: 'noop' as const,
          lexicalIndex: 'noop' as const,
          vectorIndex: 'noop' as const,
          semanticStorageProfile: 'noop' as const,
        },
        embedding: { modelStatus: 'missing' as const, artifactStatus: 'missing' as const },
        runtimeArtifacts: { nativeExtensionStatus: 'unavailable' as const },
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
      uptimeMs: 1,
    }),
    describeCapabilities: async () => ({ catalogVersion: 1, engineId: ENGINE_ID, capabilities: [] }),
    reconcile: async () => ({ reconciled: 0, failed: 0, orphans: { gitObjects: 0, pendingRows: 0 } }),
    queryStructure: async () => ({
      matches: [{ queryId: 'find-export', path: 'src/foo.ts', captureName: '@name', text: 'x', byteRange: [13, 14], nodeKind: 'identifier' }],
      failures: [],
    }),
    extractStructuralTemplate: async () => ({
      files: [{ path: 'src/foo.ts', exports: [{ name: 'x', kind: 'variable', signature: 'export const x = 1;' }], imports: [], types: [] }],
      snapshotRef: null,
      queryId: 'structural-template',
    }),
    extractRollbackTemplate: async () => ({
      files: [{ path: 'src/foo.ts', structuralSkeleton: 'export const x', contractedChanges: 'Modify whole file', injectionHint: 'Return to this structure, then apply ONLY the contracted change.' }],
      snapshotRef: SNAPSHOT_ID,
      generatedAt: NOW,
    }),
    computeMinimalPatch: () => ({
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE' as const,
      violationRanges: [],
      keepRanges: [],
      retryPrompt: 'Review the structural violation and retry within scope.',
      unpatchableViolations: [],
    }),
    compressRetryContext: () => ({
      attemptCount: 1,
      structuralDelta: 'No structural delta.',
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      retryDirective: 'Retry within the contracted scope.',
    }),
    getRelevantTests: async () => ({ relevantTests: ['tests/foo.test.ts'], coverageConfidence: 'exact' as const, unusedModifiedFiles: [] }),
    searchSymbols: async () => ({
      matches: [{ path: 'src/foo.ts', name: 'createFoo', kind: 'function' as const, byteRange: [0, 9], nodeKind: 'identifier' }],
      failures: [],
      filesScanned: 1,
      truncated: false,
    }),
    describeProject: async () => ({
      files: { total: 1, byLanguage: [{ language: 'typescript' as const, fileCount: 1, samplePaths: ['src/foo.ts'] }] },
      symbols: { exports: 1, imports: 0, types: 0, functions: 1, classes: 0 },
      filesScanned: 1,
      truncated: false,
      failures: [],
    }),
    predictViolationRisk: async () => ({
      probability: 0.1,
      riskBand: 'low' as const,
      advisory: true as const,
      sampleSize: 1,
      perKindProbabilities: {},
      featuresUsed: { projectId: 'proj-eq1', astNodeCount: 10, fileLineCount: 1, manifestScopeRatio: 1 },
      reason: 'No elevated risk detected.',
    }),
    scoreAnomaly: async () => ({
      score: 0,
      isAnomalous: false,
      advisory: true as const,
      sampleSize: 1,
      signals: [],
      reason: 'No anomaly detected.',
    }),
    analyzeBlastRadius: async () => ({
      correlationId: CORR,
      advisory: true as const,
      status: 'SAFE' as const,
      providerAvailable: true,
      warnThreshold: 10,
      entries: [],
    }),
    findReferencingSymbols: async () => ({
      correlationId: CORR,
      advisory: true as const,
      status: 'UNAVAILABLE' as const,
      providerStatus: 'unavailable' as const,
      targetResolution: {
        status: 'resolved' as const,
        symbol: { name: 'createFoo', kind: 'function', byteRange: [0, 9] as [number, number] },
        candidates: [{ name: 'createFoo', kind: 'function', byteRange: [0, 9] as [number, number] }],
        reason: 'direct_symbol' as const,
      },
      references: [],
      files: [],
      referenceCount: 0,
      providerError: null,
    }),
    synthesizeInterfaceStubs: async () => ({
      correlationId: CORR,
      advisory: true as const,
      status: 'AUTHORITATIVE' as const,
      stubs: [{
        target: { file: 'src/foo.ts', symbol: 'createFoo' },
        quality: 'authoritative' as const,
        declaration: 'export declare function createFoo(): void;',
        reason: null,
        contractCount: 1,
      }],
      authoritativeCount: 1,
      placeholderCount: 0,
    }),
    ephemeralStructuralSandbox: async () => ({
      sandboxSchemaVersion: 1 as const,
      correlationId: CORR,
      advisory: true as const,
      status: 'PARSE_AND_STRUCTURE_OK' as const,
      checked: 1,
      snippets: [],
      typeProvider: {
        status: 'NOT_REQUESTED' as const,
        providerId: null,
        reason: null,
        compilerProof: false as const,
      },
      sideEffectProfile: {
        inMemoryOnly: true as const,
        detachedAstContext: true as const,
        usesFilesystem: false as const,
        usesVersioning: false as const,
        usesSnapshotStore: false as const,
        usesAuditLog: false as const,
        usesSessionMutation: false as const,
        usesLocks: false as const,
      },
      authority: {
        canMutateFiles: false as const,
        canChangeDeterministicVerdict: false as const,
        deterministicVerdictAuthority: 'structural_manifest_policy_only' as const,
      },
      nonBypass: {
        doesNotReplace: ['dryRun', 'auditDiff', 'policy', 'session_apply_edits'] as const,
        successCannotAuthorizeWrites: true as const,
      },
    }),
    indexSemanticCorpus: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      status: 'AVAILABLE' as const,
      providerStatus: 'AVAILABLE' as const,
      providerAvailable: true,
      resultCount: req.documents.length,
      freshness: 'indexed' as const,
      degradationReasons: [],
      indexedCount: req.documents.length,
      requestedCount: req.documents.length,
    }),
    semanticSearch: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      advisory: true as const,
      status: 'AVAILABLE' as const,
      providerStatus: 'AVAILABLE' as const,
      providerAvailable: true,
      resultCount: 1,
      freshness: 'indexed' as const,
      degradationReasons: [],
      topK: req.topK,
      suggestions: [
        {
          kind: 'query' as const,
          message: 'Use a more specific symbol or path token.',
          provenance: 'semantic' as const,
        },
      ],
      matches: [
        {
          id: 'doc-alpha',
          score: 0.91,
          metadata: { path: 'src/alpha.ts' },
          source: 'baseline' as const,
          rankSource: 'baseline_vector' as const,
          freshness: 'indexed' as const,
        },
      ],
    }),
    refreshSemanticOverlay: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      worktreeId: req.worktreeId,
      sessionId: req.sessionId,
      status: 'AVAILABLE' as const,
      mode: req.mode,
      inputSource: req.inputSource,
      overlayGeneration: 1,
      published: true,
      retainedPreviousOverlay: false,
      touchedFileCount: req.touchedFiles.length,
      documentCount: req.documents?.length ?? 0,
      lexicalCount: req.documents?.length ?? 0,
      vectorCount: req.documents?.length ?? 0,
      maskCount: 0,
      degradationReasons: [],
    }),
    clearSemanticOverlay: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      worktreeId: req.worktreeId,
      sessionId: req.sessionId,
      cleared: true,
    }),
    gc: async () => ({ deletedCount: 0 }),
  };
}

function injectFetchAdapter(server: FastifyInstance): typeof globalThis.fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const parsed = new URL(url);
    const res = await server.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: parsed.pathname + parsed.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body as string | undefined,
    });
    return new Response(res.rawPayload, { status: res.statusCode, headers: res.headers as Record<string, string> });
  }) as typeof globalThis.fetch;
}

interface DualFixture {
  http: HoplonEngine;
  grpc: RemoteHoplonGrpcEngine;
  httpServer: FastifyInstance;
  grpcServer: HoplonGrpcServer;
}

async function makeFixture(): Promise<DualFixture> {
  const engine = buildMockEngine();
  const httpServer = await createHoplonHttpServer({ engine, fastify: fastifyFactory({ logger: false }) });
  const http = createRemoteHoplonEngine({ baseUrl: 'http://inject.local', engineId: 'client-http', fetchImpl: injectFetchAdapter(httpServer) });
  const grpcServer = await createHoplonGrpcServer({ engine });
  const port = await grpcServer.start('127.0.0.1:0');
  const grpc = await createRemoteHoplonGrpcEngine({ address: `127.0.0.1:${port}`, engineId: 'client-grpc' });
  return { http, grpc, httpServer, grpcServer };
}

async function teardown(fx: DualFixture | undefined): Promise<void> {
  if (!fx) return;
  fx.grpc.close();
  await fx.grpcServer.stop(1000);
  await fx.httpServer.close();
}

const CASES: Array<{ name: string; run: (engine: HoplonEngine) => Promise<unknown> }> = [
  { name: 'health', run: (engine) => engine.health() },
  { name: 'reconcile', run: (engine) => engine.reconcile() },
  { name: 'createSnapshot', run: (engine) => engine.createSnapshot({ manifest: MANIFEST }) },
  { name: 'auditDiff', run: (engine) => engine.auditDiff({ snapshotRefId: SNAPSHOT_ID, projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, files: ['src/foo.ts'] }) },
  { name: 'revertUncontracted', run: (engine) => engine.revertUncontracted({ snapshotRefId: SNAPSHOT_ID, projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR }) },
  { name: 'packContext', run: (engine) => engine.packContext({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, files: ['src/foo.ts'], strategy: { kind: 'whole_file' } }) },
  { name: 'dryRun', run: (engine) => engine.dryRun({ snapshotRefId: SNAPSHOT_ID, projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 2;' }] }) },
  { name: 'preflight', run: (engine) => engine.preflight({ manifest: MANIFEST, projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR }) },
  { name: 'queryStructure', run: (engine) => engine.queryStructure({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, files: ['src/foo.ts'], queries: [{ id: 'find-export', language: 'typescript', pattern: '(export_statement) @name' }] }) },
  { name: 'extractStructuralTemplate', run: (engine) => engine.extractStructuralTemplate({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, files: ['src/foo.ts'] }) },
  { name: 'extractRollbackTemplate', run: (engine) => engine.extractRollbackTemplate({ snapshotRefId: SNAPSHOT_ID, projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, files: ['src/foo.ts'] }) },
  { name: 'computeMinimalPatch', run: (engine) => Promise.resolve(engine.computeMinimalPatch({ content: 'export const x = 1;', violations: [{ kind: 'snapshot_missing', path: 'src/foo.ts', snapshotRefId: SNAPSHOT_ID, message: 'Missing snapshot', correction: 'Recreate the snapshot before retrying.' }] })) },
  { name: 'compressRetryContext', run: (engine) => Promise.resolve(engine.compressRetryContext([{ attemptNumber: 1, proposedContent: 'export const x = 1;', violations: [] }])) },
  { name: 'getRelevantTests', run: (engine) => engine.getRelevantTests({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, modifiedFiles: ['src/foo.ts'] }) },
  { name: 'searchSymbols', run: (engine) => engine.searchSymbols({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR, namePattern: 'createFoo', files: ['src/foo.ts'] }) },
  { name: 'describeProject', run: (engine) => engine.describeProject({ projectId: 'proj-eq1', runId: 'run-eq1', correlationId: CORR }) },
  { name: 'predictViolationRisk', run: (engine) => engine.predictViolationRisk({ correlationId: CORR, projectId: 'proj-eq1', proposedFeatures: { projectId: 'proj-eq1', astNodeCount: 10, fileLineCount: 1, manifestScopeRatio: 1 }, historicalRecords: [AUDIT_LOG] }) },
  { name: 'scoreAnomaly', run: (engine) => engine.scoreAnomaly({ correlationId: CORR, projectId: 'proj-eq1', proposedMetrics: { projectId: 'proj-eq1', astNodeCount: 10, fileLineCount: 1, manifestScopeRatio: 1 }, historicalRecords: [AUDIT_LOG] }) },
  { name: 'analyzeBlastRadius', run: (engine) => engine.analyzeBlastRadius({ correlationId: CORR, projectId: 'proj-eq1', symbols: [{ name: 'createFoo', kind: 'function', byteRange: [0, 9], path: 'src/foo.ts' }] }) },
  { name: 'findReferencingSymbols', run: (engine) => engine.findReferencingSymbols({ correlationId: CORR, projectId: 'proj-eq1', target: { type: 'symbol_identity', symbol: { name: 'createFoo', kind: 'function', byteRange: [0, 9], path: 'src/foo.ts' } } }) },
  { name: 'synthesizeInterfaceStubs', run: (engine) => engine.synthesizeInterfaceStubs({ correlationId: CORR, projectId: 'proj-eq1', targets: [{ file: 'src/foo.ts', symbol: 'createFoo' }], signatureContracts: [{ file: 'src/foo.ts', symbol: 'createFoo', expectedParams: [], expectedReturn: 'void' }] }) },
  { name: 'ephemeralStructuralSandbox', run: (engine) => engine.ephemeralStructuralSandbox({ correlationId: CORR, projectId: 'proj-eq1', snippets: [{ id: 's1', path: 'synthetic/snippet.ts', content: 'export const x = 1;' }] }) },
  { name: 'describeCapabilities', run: (engine) => engine.describeCapabilities({ correlationId: CORR }) },
  { name: 'indexSemanticCorpus', run: (engine) => engine.indexSemanticCorpus({ projectId: 'proj-eq1', correlationId: CORR, documents: [{ id: 'doc-alpha', text: 'alpha semantic document', metadata: { path: 'src/alpha.ts' } }] }) },
  { name: 'semanticSearch', run: (engine) => engine.semanticSearch({ projectId: 'proj-eq1', correlationId: CORR, query: 'alpha', topK: 3 }) },
  { name: 'refreshSemanticOverlay', run: (engine) => engine.refreshSemanticOverlay({ projectId: 'proj-eq1', correlationId: CORR, sessionId: 'session-eq1', mode: 'written_bytes', inputSource: 'written_bytes', touchedFiles: ['src/alpha.ts'], documents: [{ id: 'doc-alpha', text: 'alpha semantic document', metadata: { path: 'src/alpha.ts' } }] }) },
  { name: 'clearSemanticOverlay', run: (engine) => engine.clearSemanticOverlay({ projectId: 'proj-eq1', correlationId: CORR, sessionId: 'session-eq1' }) },
  { name: 'gc', run: (engine) => engine.gc({ projectId: 'proj-eq1' }) },
];

describe('EQ1 — full-surface HTTP↔gRPC happy-path equivalence', () => {
  let fx: DualFixture;

  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await teardown(fx); });

  for (const testCase of CASES) {
    it(`returns equivalent decoded results for ${testCase.name}`, async () => {
      const [httpResult, grpcResult] = await Promise.all([testCase.run(fx.http), testCase.run(fx.grpc)]);
      expect(grpcResult).toEqual(httpResult);
    });
  }
});
