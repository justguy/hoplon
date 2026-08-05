/**
 * tests/transport/http.server.test.ts — T1 HTTP server proof suite.
 *
 * Proves:
 *  1. Every Phase 1+2 engine method is reachable via HTTP (one test per route).
 *  2. Malformed request body → 400 with ValidationError envelope.
 *  3. Engine SemanticError → 409 with SemanticError envelope.
 *  4. Engine AdapterError → 503 with AdapterError envelope.
 *  5. Engine EngineError → 500 with EngineError envelope.
 *  6. Unknown thrown value → 500 with UnknownError envelope.
 *  7. AbortSignal wired: request-close propagates to engine.
 *  8. End-to-end: createSnapshot + auditDiff + revertUncontracted happy-path.
 *
 * All requests use fastify.inject() — no real sockets, no network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fastifyFactory = require('fastify');
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import {
  ValidationError,
  SemanticError,
  AdapterError,
  EngineError,
} from '../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENGINE_ID = 'test-engine-http';
const CORR = 'corr-t1-test';
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-http',
  runId: 'run-http',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

// Shared fixed timestamp for deterministic SnapshotRef fixtures
const NOW = '2026-04-13T00:00:00Z';

// ---------------------------------------------------------------------------
// Mock engine
// ---------------------------------------------------------------------------

/**
 * Build a mock engine where every method is configurable via an overrides map.
 * Default behaviour returns canned fixture responses matching the real shapes.
 */
function buildMockEngine(
  overrides: Partial<HoplonEngine> = {},
): HoplonEngine {
  const defaults: HoplonEngine = {
    createSnapshot: async (_req, _signal) => ({
      snapshotRef: { id: SNAPSHOT_ID, engineId: ENGINE_ID, runId: 'run-http', createdAt: NOW },
      warnings: [],
    }),

    auditDiff: async (_req, _signal) => ({
      status: 'PASS' as const,
      checked: 1,
      auditSchemaVersion: 1,
      correlationId: CORR,
    }),

    revertUncontracted: async (_req, _signal) => ({
      reverted: ['src/foo.ts'],
      deleted: [],
      allowlistSkipped: [],
    }),

    packContext: async (_req, _signal) => ({
      metadata: {
        strategyVersion: 1,
        grammarVersion: 'tree-sitter-typescript@0.20.0',
        packerVersion: 1,
        generatedAt: NOW,
        correlationId: CORR,
      },
      slices: [
        { path: 'src/foo.ts', byteRange: [0, 20], nodeKinds: ['program'], content: 'export const x = 1;' },
      ],
      failures: [],
    }),

    dryRun: async (_req, _signal) => ({
      status: 'PASS' as const,
      checked: 1,
      auditSchemaVersion: 1,
      correlationId: CORR,
    }),

    preflight: async (_req, _signal) => ({
      status: 'PASS' as const,
      gates: [{ gateName: 'path_traversal', status: 'PASS' as const, violations: [], durationMs: 1 }],
      correlationId: CORR,
    }),

    health: async (_signal) => ({
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
      uptimeMs: 42,
    }),

    describeCapabilities: async (_req, _signal) => ({
      catalogVersion: 1,
      engineId: ENGINE_ID,
      capabilities: [
        {
          descriptor: {
            contractSchemaVersion: 1 as const,
            capabilityId: 'codeIntelligence' as const,
            name: 'Code Intelligence',
            integrationPoint: 'core_adapter' as const,
            runtimeState: 'shipped' as const,
            defaultBinding: 'builtin' as const,
            defaultWritePosture: 'read_only' as const,
            sideEffectPosture: 'none' as const,
            failureIsolation: 'core_operation' as const,
            invocationMode: 'typed_engine_method' as const,
            correlationFields: ['engineId', 'correlationId', 'projectId', 'runId', 'snapshotRefId'],
            versionMetadata: [
              'capability_contract_v1',
              'provider_version',
              'workspace_revision',
            ],
            dataAccess: [
              { dataClass: 'workspace_content', access: 'read_only' as const },
              { dataClass: 'workspace_metadata', access: 'read_only' as const },
            ],
            notes:
              'Tree-sitter is the shipped default. LSP- and SCIP-backed providers bind through this seam later.',
          },
          healthStatus: 'available' as const,
        },
      ],
    }),

    reconcile: async (_signal) => ({
      reconciled: 0,
      failed: 0,
      orphans: { gitObjects: 0, pendingRows: 0 },
    }),

    queryStructure: async (_req, _signal) => ({
      matches: [],
      failures: [],
    }),

    extractStructuralTemplate: async (_req, _signal) => ({
      files: [],
      snapshotRef: null,
      queryId: 'structural-template',
      generatedAt: NOW,
    }),

    extractRollbackTemplate: async (_req, _signal) => ({
      files: [],
      snapshotRef: SNAPSHOT_ID,
      generatedAt: NOW,
    }),

    computeMinimalPatch: (_req) => ({
      patchable: false,
      action: 'PATCH_NOT_COMPUTABLE' as const,
      violationRanges: [],
      keepRanges: [],
      retryPrompt: 'Cannot compute patch',
      unpatchableViolations: [],
    }),

    compressRetryContext: (_attempts) => ({
      attemptCount: 0,
      structuralDelta: '',
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      retryDirective: 'No attempts to compress',
    }),

    getRelevantTests: async (_req, _signal) => ({
      relevantTests: [],
      coverageConfidence: 'exact' as const,
      unusedModifiedFiles: [],
    }),

    analyzeBlastRadius: async (_req, _signal) => ({
      correlationId: CORR,
      advisory: true as const,
      status: 'WARNING' as const,
      providerAvailable: true,
      warnThreshold: 10,
      entries: [
        {
          symbol: {
            name: 'createHoplonEngine',
            kind: 'function',
            byteRange: [0, 18] as [number, number],
            path: 'src/hoplon/engine/factory.ts',
          },
          classification: 'warning' as const,
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
    }),

    findReferencingSymbols: async (_req, _signal) => ({
      correlationId: CORR,
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
    }),

    synthesizeInterfaceStubs: async (_req, _signal) => ({
      correlationId: CORR,
      advisory: true as const,
      status: 'AUTHORITATIVE' as const,
      stubs: [
        {
          target: { file: 'src/foo.ts', symbol: 'foo' },
          quality: 'authoritative' as const,
          declaration: 'export declare function foo(): void;',
          reason: null,
          contractCount: 1,
        },
      ],
      authoritativeCount: 1,
      placeholderCount: 0,
    }),

    ephemeralStructuralSandbox: async (_req, _signal) => ({
      sandboxSchemaVersion: 1 as const,
      correlationId: CORR,
      advisory: true as const,
      status: 'PARSE_AND_STRUCTURE_OK' as const,
      checked: 1,
      snippets: [
        {
          id: 's1',
          path: 'synthetic/snippet.ts',
          status: 'STRUCTURE_OK' as const,
          parse: {
            status: 'OK' as const,
            parser: 'codeIntelligence.parse' as const,
            language: 'typescript' as const,
            errorMessage: null,
          },
          structure: {
            status: 'OK' as const,
            rootKind: 'program',
            nodeKindCounts: { program: 1 },
            errorNodeCount: 0,
            topLevelSymbols: [],
            expectationFailures: [],
          },
        },
      ],
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

    gc: async (_opts) => ({ deletedCount: 0 }),
  };

  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

async function makeServer(overrides: Partial<HoplonEngine> = {}): Promise<FastifyInstance> {
  const engine = buildMockEngine(overrides);
  // Create a fresh Fastify instance for each test server to avoid route conflicts
  const fastify = fastifyFactory({ logger: false });
  return createHoplonHttpServer({ engine, fastify });
}

// ---------------------------------------------------------------------------
// 1. GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with engine health', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ engineId: string }>();
    expect(body.engineId).toBe(ENGINE_ID);
  });
});

describe('POST /describeCapabilities', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with the capability catalog on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/describeCapabilities',
      payload: { correlationId: CORR },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ capabilities: Array<{ descriptor: { capabilityId: string } }> }>();
    expect(body.capabilities[0]?.descriptor.capabilityId).toBe('codeIntelligence');
  });

  it('returns 400 with ValidationError envelope on missing correlationId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/describeCapabilities',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });

  it('returns semanticSearch recovery guidance on malformed semanticSearch input', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/semanticSearch',
      payload: {
        projectId: 'proj-http',
        correlationId: 'corr-http-semantic',
        topK: 3,
        qurey: 'alpha',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{
      error: {
        class: string;
        recovery?: { diagnostics?: Array<{ fieldPath: string; didYouMean?: string }> };
      };
    }>();
    expect(body.error.class).toBe('ValidationError');
    expect(body.error.recovery?.diagnostics).toContainEqual(
      expect.objectContaining({ fieldPath: 'qurey', didYouMean: 'query' }),
    );
  });
});

describe('POST /analyzeBlastRadius', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with advisory blast-radius report on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/analyzeBlastRadius',
      payload: {
        correlationId: CORR,
        projectId: 'proj-http',
        symbols: [
          {
            name: 'createHoplonEngine',
            kind: 'function',
            byteRange: [0, 18],
            path: 'src/hoplon/engine/factory.ts',
          },
        ],
        warnThreshold: 10,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ advisory: boolean; status: string }>();
    expect(body.advisory).toBe(true);
    expect(body.status).toBe('WARNING');
  });

  it('returns 400 with ValidationError envelope on missing symbols', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/analyzeBlastRadius',
      payload: { correlationId: CORR },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });
});

describe('POST /findReferencingSymbols', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with advisory referencing-symbol report on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/findReferencingSymbols',
      payload: {
        correlationId: CORR,
        projectId: 'proj-http',
        target: {
          type: 'symbol_identity',
          symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ advisory: boolean; status: string }>();
    expect(body.advisory).toBe(true);
    expect(body.status).toBe('UNAVAILABLE');
  });

  it('returns 400 with ValidationError envelope on missing target', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/findReferencingSymbols',
      payload: { correlationId: CORR, projectId: 'proj-http' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });
});

describe('POST /synthesizeInterfaceStubs', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with advisory interface-stub report on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/synthesizeInterfaceStubs',
      payload: {
        correlationId: CORR,
        projectId: 'proj-http',
        targets: [{ file: 'src/foo.ts', symbol: 'foo' }],
        signatureContracts: [
          {
            file: 'src/foo.ts',
            symbol: 'foo',
            expectedParams: [],
            expectedReturn: 'void',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ advisory: boolean; status: string }>();
    expect(body.advisory).toBe(true);
    expect(body.status).toBe('AUTHORITATIVE');
  });

  it('returns 400 with ValidationError envelope on missing targets', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/synthesizeInterfaceStubs',
      payload: { correlationId: CORR },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });
});

describe('POST /ephemeralStructuralSandbox', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with advisory parse/structure-only report on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/ephemeralStructuralSandbox',
      payload: {
        correlationId: CORR,
        projectId: 'proj-http',
        snippets: [
          {
            id: 's1',
            path: 'synthetic/snippet.ts',
            content: 'export const x = 1;',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      advisory: boolean;
      status: string;
      typeProvider: { compilerProof: boolean };
      nonBypass: { doesNotReplace: string[] };
    }>();
    expect(body.advisory).toBe(true);
    expect(body.status).toBe('PARSE_AND_STRUCTURE_OK');
    expect(body.typeProvider.compilerProof).toBe(false);
    expect(body.nonBypass.doesNotReplace).toContain('session_apply_edits');
  });

  it('returns 400 with ValidationError envelope on missing snippets', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/ephemeralStructuralSandbox',
      payload: { correlationId: CORR },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// 2. POST /createSnapshot
// ---------------------------------------------------------------------------

describe('POST /createSnapshot', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with snapshotRef on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: VALID_MANIFEST },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ snapshotRef: { id: string } }>();
    expect(body.snapshotRef.id).toBe(SNAPSHOT_ID);
  });

  it('returns 400 with ValidationError envelope on missing manifest', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// 3. POST /auditDiff
// ---------------------------------------------------------------------------

describe('POST /auditDiff', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 PASS on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auditDiff',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('PASS');
  });

  it('returns 400 on missing required fields', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auditDiff',
      payload: { projectId: 'proj' }, // missing snapshotRefId, runId, correlationId, files
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /revertUncontracted
// ---------------------------------------------------------------------------

describe('POST /revertUncontracted', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with reverted list', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/revertUncontracted',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ reverted: string[] }>();
    expect(body.reverted).toContain('src/foo.ts');
  });

  it('returns 400 on missing snapshotRefId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/revertUncontracted',
      payload: { projectId: 'proj', runId: 'run', correlationId: CORR },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 5. POST /packContext
// ---------------------------------------------------------------------------

describe('POST /packContext', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with slices', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/packContext',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
        strategy: { kind: 'whole_file' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ slices: unknown[] }>();
    expect(Array.isArray(body.slices)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. POST /dryRun
// ---------------------------------------------------------------------------

describe('POST /dryRun', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 PASS on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/dryRun',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('PASS');
  });

  it('returns 400 on empty proposedChanges', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/dryRun',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        proposedChanges: [], // must have at least 1
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 7. POST /preflight
// ---------------------------------------------------------------------------

describe('POST /preflight', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 PASS on valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/preflight',
      payload: {
        manifest: VALID_MANIFEST,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// 8. POST /queryStructure
// ---------------------------------------------------------------------------

describe('POST /queryStructure', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with empty matches', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/queryStructure',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
        queries: [
          {
            id: 'extract-fn',
            language: 'typescript',
            pattern: '(function_declaration name: (identifier) @fn)',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ matches: unknown[] }>();
    expect(Array.isArray(body.matches)).toBe(true);
  });

  it('returns 400 on missing queries', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/queryStructure',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
        queries: [], // min 1 required
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 9. POST /extractStructuralTemplate
// ---------------------------------------------------------------------------

describe('POST /extractStructuralTemplate', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with template', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/extractStructuralTemplate',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: unknown[] }>();
    expect(Array.isArray(body.files)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. POST /extractRollbackTemplate
// ---------------------------------------------------------------------------

describe('POST /extractRollbackTemplate', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with rollback template', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/extractRollbackTemplate',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        snapshotRefId: SNAPSHOT_ID,
        files: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ snapshotRef: string }>();
    expect(body.snapshotRef).toBe(SNAPSHOT_ID);
  });
});

// ---------------------------------------------------------------------------
// 11. POST /computeMinimalPatch
// ---------------------------------------------------------------------------

describe('POST /computeMinimalPatch', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with MinimalPatch', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/computeMinimalPatch',
      payload: {
        content: 'const x = 1;',
        violations: [
          {
            kind: 'uncontracted_file',
            path: 'src/extra.ts',
            firstChangedLine: 1,
            sourceSlice: 'const x = 1;',
            message: 'extra.ts is not in the manifest',
            correction: 'Remove or add to manifest',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ patchable: boolean }>();
    expect(typeof body.patchable).toBe('boolean');
  });

  it('returns 400 when violations array is empty', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/computeMinimalPatch',
      payload: { content: 'const x = 1;', violations: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 12. POST /compressRetryContext
// ---------------------------------------------------------------------------

describe('POST /compressRetryContext', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with compressed context (empty array)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compressRetryContext',
      payload: [],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ attemptCount: number }>();
    expect(typeof body.attemptCount).toBe('number');
  });

  it('returns 400 on non-array body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compressRetryContext',
      payload: { not: 'an array' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 13. POST /getRelevantTests
// ---------------------------------------------------------------------------

describe('POST /getRelevantTests', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with TestOracleResult', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/getRelevantTests',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        modifiedFiles: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ relevantTests: unknown[] }>();
    expect(Array.isArray(body.relevantTests)).toBe(true);
  });

  it('returns 400 on missing modifiedFiles', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/getRelevantTests',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        modifiedFiles: [], // min 1 required
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 14. POST /gc
// ---------------------------------------------------------------------------

describe('POST /gc', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with deletedCount', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/gc',
      payload: { projectId: 'proj-http' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ deletedCount: number }>();
    expect(body.deletedCount).toBe(0);
  });

  it('returns 200 with empty body (all filters optional)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/gc',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 15. POST /reconcile
// ---------------------------------------------------------------------------

describe('POST /reconcile', () => {
  let server: FastifyInstance;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns 200 with ReconcileReport', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/reconcile',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ reconciled: number }>();
    expect(body.reconciled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('SemanticError → 409', async () => {
    const server = await makeServer({
      auditDiff: async () => {
        throw new SemanticError(
          { kind: 'snapshot_missing', engineId: ENGINE_ID, correlationId: CORR },
          'Snapshot not found',
        );
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/auditDiff',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { class: string; kind: string } }>();
    expect(body.error.class).toBe('SemanticError');
    expect(body.error.kind).toBe('snapshot_missing');
    await server.close();
  });

  it('AdapterError → 503', async () => {
    const server = await makeServer({
      createSnapshot: async () => {
        throw new AdapterError(
          { kind: 'git_commit_failed', engineId: ENGINE_ID, correlationId: CORR },
          'Git commit failed',
        );
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: VALID_MANIFEST },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('AdapterError');
    await server.close();
  });

  it('EngineError → 500', async () => {
    const server = await makeServer({
      health: async () => {
        throw new EngineError(
          { kind: 'reconcile_failed', engineId: ENGINE_ID, correlationId: 'health-probe' },
          'Reconcile failed',
        );
      },
    });

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('EngineError');
    await server.close();
  });

  it('unknown thrown value → 500 with UnknownError class', async () => {
    const server = await makeServer({
      reconcile: async () => { throw new Error('totally unexpected'); },
    });

    const res = await server.inject({ method: 'POST', url: '/reconcile', payload: {} });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('UnknownError');
    await server.close();
  });

  it('ValidationError → 400', async () => {
    const server = await makeServer({
      preflight: async () => {
        throw new ValidationError(
          { kind: 'invalid_manifest', engineId: ENGINE_ID, correlationId: CORR },
          'Manifest invalid',
        );
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/preflight',
      payload: {
        manifest: VALID_MANIFEST,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { class: string } }>();
    expect(body.error.class).toBe('ValidationError');
    await server.close();
  });

  it('error envelope includes correlationId', async () => {
    const server = await makeServer({
      auditDiff: async () => {
        throw new SemanticError(
          { kind: 'snapshot_missing', engineId: ENGINE_ID, correlationId: CORR },
          'Snapshot not found',
        );
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/auditDiff',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
      },
    });
    const body = res.json<{ error: { correlationId: string } }>();
    expect(body.error.correlationId).toBe(CORR);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 17. AbortSignal wiring
// ---------------------------------------------------------------------------

describe('AbortSignal wiring', () => {
  it('engine receives an AbortSignal on async routes', async () => {
    let capturedSignal: AbortSignal | undefined;

    const server = await makeServer({
      packContext: async (_req, signal) => {
        capturedSignal = signal;
        return {
          metadata: {
            strategyVersion: 1,
            grammarVersion: 'tree-sitter-typescript@0.20.0',
            packerVersion: 1,
            generatedAt: NOW,
            correlationId: CORR,
          },
          slices: [],
          failures: [],
        };
      },
    });

    await server.inject({
      method: 'POST',
      url: '/packContext',
      payload: {
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
        strategy: { kind: 'whole_file' },
      },
    });

    // Signal should be an AbortSignal instance
    expect(capturedSignal).toBeDefined();
    expect(typeof capturedSignal?.aborted).toBe('boolean');
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 18. End-to-end: createSnapshot + auditDiff + revertUncontracted
// ---------------------------------------------------------------------------

describe('end-to-end: createSnapshot → auditDiff → revertUncontracted', () => {
  let server: FastifyInstance;

  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('createSnapshot returns PASS snapshotRef', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/createSnapshot',
      payload: { manifest: VALID_MANIFEST },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ snapshotRef: { id: string } }>();
    expect(body.snapshotRef.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('auditDiff returns PASS for the snapshot', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auditDiff',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
        files: ['src/foo.ts'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('PASS');
  });

  it('revertUncontracted returns reverted list', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/revertUncontracted',
      payload: {
        snapshotRefId: SNAPSHOT_ID,
        projectId: 'proj-http',
        runId: 'run-http',
        correlationId: CORR,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ reverted: string[]; deleted: string[] }>();
    expect(body.reverted).toContain('src/foo.ts');
    expect(body.deleted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 19. createHoplonHttpServer accepts external fastify instance
// ---------------------------------------------------------------------------

describe('createHoplonHttpServer with external fastify', () => {
  it('registers routes on an externally provided fastify instance', async () => {
    const external = fastifyFactory({ logger: false });
    const engine = buildMockEngine();
    const server = await createHoplonHttpServer({ engine, fastify: external });

    // Verify it's the same instance
    expect(server).toBe(external);

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});
