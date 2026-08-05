/**
 * tests/mcp/server.test.ts — MCP wrapper targeted test suite.
 *
 * Proof scope (per slice spec):
 *   1. Server construction with mock engine succeeds.
 *   2. tools/list returns all registered tools with correct JSON Schema shapes.
 *   3. Each tool handler: valid input → engine method invoked with parsed args →
 *      JSON string returned in content[0].text.
 *   4. Invalid input → typed error response (isError: true, kind present).
 *   5. H13: error responses never include symbol names / file paths beyond counts.
 *   6. End-to-end in-memory transport: server connect → client callTool round-trip.
 *   7. health tool: no args → engine.health() invoked.
 *   8. compute_minimal_patch: synchronous engine method routed correctly.
 *   9. Unknown tool name → error response.
 *
 * Does NOT use live filesystem, git, or WASM parsers.
 * All engine calls are intercepted by the mock engine.
 */

import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { EngineHealth } from '../../src/hoplon/contracts/health.js';
import type { SnapshotResult } from '../../src/hoplon/contracts/snapshot.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import type { RevertResult } from '../../src/hoplon/contracts/revert.js';
import type { PackedContext } from '../../src/hoplon/contracts/context.js';
import type { PreflightResult } from '../../src/hoplon/contracts/preflight.js';
import type { QueryStructureResult } from '../../src/hoplon/contracts/queryStructure.js';
import type { StructuralTemplate } from '../../src/hoplon/contracts/structuralTemplate.js';
import type { MinimalPatch } from '../../src/hoplon/contracts/computeMinimalPatch.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';
import type { DescribeCapabilitiesResult } from '../../src/hoplon/contracts/capabilities.js';
import type { FindReferencingSymbolsResult } from '../../src/hoplon/contracts/referencingSymbols.js';
import type { FindSyntaxNodeResult } from '../../src/hoplon/contracts/syntaxNodeLookup.js';

// ---------------------------------------------------------------------------
// Mock engine factory
// ---------------------------------------------------------------------------

function makeMockEngine(): HoplonEngine {
  const snapshotResult: SnapshotResult = {
    snapshotRef: {
      id: 'sha256:' + 'a'.repeat(64),
      engineId: 'test',
      runId: 'run-1',
      createdAt: '2026-01-01T00:00:00Z',
    },
    warnings: [],
  };

  const auditResult: AuditResult = {
    status: 'PASS',
    violations: [],
    auditedFileCount: 0,
    snapshotRef: { id: 'sha256:' + 'a'.repeat(64), engineId: 'test', runId: 'run-1', createdAt: '2026-01-01T00:00:00Z' },
  };

  const revertResult: RevertResult = {
    restoredCount: 0,
    deletedCount: 0,
    snapshotRef: { id: 'sha256:' + 'a'.repeat(64), engineId: 'test', runId: 'run-1', createdAt: '2026-01-01T00:00:00Z' },
  };

  const packedContext: PackedContext = {
    projectId: 'p1',
    runId: 'run-1',
    correlationId: 'c1',
    files: [],
    strategy: { kind: 'whole_file' },
    tokenEstimate: 0,
  };

  const preflightResult: PreflightResult = {
    status: 'PASS',
    gates: [],
  };

  const queryResult: QueryStructureResult = {
    matches: [],
    failures: [],
  };

  const structuralTemplate: StructuralTemplate = {
    files: [],
    queryId: 'structural-template',
    snapshotRef: null,
  };

  const minimalPatch: MinimalPatch = {
    patchable: true,
    action: 'REMOVE_NODES',
    violationRanges: [],
    keepRanges: [[0, 10]],
    correctedContent: 'ok',
    retryPrompt: 'Patch applied.',
    unpatchableViolations: [],
  };

  const testOracleResult: TestOracleResult = {
    relevantTests: [],
    coverageConfidence: 'exact',
    unusedModifiedFiles: [],
  };

  const referencingSymbolsResult: FindReferencingSymbolsResult = {
    correlationId: 'c1',
    advisory: true,
    status: 'UNAVAILABLE',
    providerStatus: 'unavailable',
    targetResolution: {
      status: 'resolved',
      symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] },
      candidates: [{ name: 'alpha', kind: 'function', byteRange: [0, 5] }],
      reason: 'direct_symbol',
    },
    references: [],
    files: [],
    referenceCount: 0,
    providerError: null,
  };

  const syntaxNodeResult: FindSyntaxNodeResult = {
    correlationId: 'c1',
    advisory: true,
    status: 'FOUND',
    file: 'src/foo.ts',
    node: {
      kind: 'identifier',
      byteRange: [0, 3],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 3 },
      named: true,
      missing: false,
      error: false,
      text: 'foo',
    },
    ancestors: [],
    parserStatus: {
      advisory: true,
      status: 'OK',
      language: 'typescript',
      grammarVersion: '15',
      hasError: false,
      errorNodes: [],
      missingNodes: [],
      degradationReason: null,
    },
    failureReason: null,
  };

  const indexSemanticCorpusResult = {
    correlationId: 'c1',
    projectId: 'p1',
    status: 'AVAILABLE' as const,
    providerStatus: 'AVAILABLE' as const,
    providerAvailable: true,
    resultCount: 1,
    freshness: 'indexed' as const,
    degradationReasons: [],
    indexedCount: 1,
    requestedCount: 1,
  };

  const semanticSearchResult = {
    correlationId: 'c1',
    projectId: 'p1',
    advisory: true as const,
    status: 'AVAILABLE' as const,
    providerStatus: 'AVAILABLE' as const,
    providerAvailable: true,
    resultCount: 1,
    freshness: 'indexed' as const,
    degradationReasons: [],
    topK: 3,
    suggestions: [
      {
        kind: 'stale_index' as const,
        message: 'Index the target branch before searching branch-scoped semantic results.',
        value: 'branch:feature/semantic',
        provenance: 'deterministic' as const,
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
  };

  const health: EngineHealth = {
    engineId: 'test',
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
    uptimeMs: 100,
  };

  const describeCapabilities: DescribeCapabilitiesResult = {
    catalogVersion: 1,
    engineId: 'test',
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

  return {
    createSnapshot: vi.fn().mockResolvedValue(snapshotResult),
    auditDiff: vi.fn().mockResolvedValue(auditResult),
    revertUncontracted: vi.fn().mockResolvedValue(revertResult),
    packContext: vi.fn().mockResolvedValue(packedContext),
    dryRun: vi.fn().mockResolvedValue(auditResult),
    preflight: vi.fn().mockResolvedValue(preflightResult),
    queryStructure: vi.fn().mockResolvedValue(queryResult),
    extractStructuralTemplate: vi.fn().mockResolvedValue(structuralTemplate),
    computeMinimalPatch: vi.fn().mockReturnValue(minimalPatch),
    getRelevantTests: vi.fn().mockResolvedValue(testOracleResult),
    health: vi.fn().mockResolvedValue(health),
    describeCapabilities: vi.fn().mockResolvedValue(describeCapabilities),
    reconcile: vi.fn().mockResolvedValue({ reconciledCount: 0, failedCount: 0 }),
    gc: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    compressRetryContext: vi.fn().mockReturnValue({
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      structuralDelta: '',
      retryDirective: '',
    }),
    extractRollbackTemplate: vi.fn().mockResolvedValue({
      files: [],
      snapshotRef: 'sha256:' + 'a'.repeat(64),
      generatedAt: '2026-01-01T00:00:00Z',
    }),
    searchSymbols: vi.fn().mockResolvedValue({
      matches: [],
      failures: [],
      filesScanned: 0,
      truncated: false,
    }),
    findReferencingSymbols: vi.fn().mockResolvedValue(referencingSymbolsResult),
    findSyntaxNode: vi.fn().mockResolvedValue(syntaxNodeResult),
    indexSemanticCorpus: vi.fn().mockResolvedValue(indexSemanticCorpusResult),
    semanticSearch: vi.fn().mockResolvedValue(semanticSearchResult),
    refreshSemanticOverlay: vi.fn().mockResolvedValue({
      correlationId: 'c1',
      projectId: 'p1',
      sessionId: 'session-1',
      status: 'AVAILABLE',
      mode: 'written_bytes',
      inputSource: 'written_bytes',
      overlayGeneration: 1,
      published: true,
      retainedPreviousOverlay: false,
      touchedFileCount: 1,
      documentCount: 1,
      lexicalCount: 1,
      vectorCount: 1,
      maskCount: 0,
      degradationReasons: [],
    }),
    clearSemanticOverlay: vi.fn().mockResolvedValue({
      correlationId: 'c1',
      projectId: 'p1',
      sessionId: 'session-1',
      cleared: true,
    }),
    describeProject: vi.fn().mockResolvedValue({
      files: { total: 0, byLanguage: [] },
      symbols: { exports: 0, imports: 0, types: 0, functions: 0, classes: 0 },
      filesScanned: 0,
      truncated: false,
      failures: [],
    }),
    ephemeralStructuralSandbox: vi.fn().mockResolvedValue({
      sandboxSchemaVersion: 1,
      correlationId: 'c1',
      advisory: true,
      status: 'PARSE_AND_STRUCTURE_OK',
      checked: 0,
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
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a connected client+server pair over in-memory transports.
 * Returns the client (already connected) and the mock engine.
 */
async function buildClientServer(): Promise<{ client: Client; engine: HoplonEngine }> {
  const engine = makeMockEngine();
  const server = createHoplonMcpServer({ engine });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, engine };
}

async function buildClientServerWithSessions(): Promise<{ client: Client; engine: HoplonEngine }> {
  const engine = makeMockEngine();
  const registry = createSessionRegistry({ engine });
  const server = createHoplonMcpServer({ engine, sessionRegistry: registry });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, engine };
}

function collectSchemaRefs(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value as Record<string, unknown>);
  const here =
    typeof (value as Record<string, unknown>)['$ref'] === 'string' ? [path] : [];
  return [
    ...here,
    ...entries.flatMap(([key, child]) => collectSchemaRefs(child, `${path}.${key}`)),
  ];
}

function collectDraft7TupleItems(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value as Record<string, unknown>);
  const items = (value as Record<string, unknown>)['items'];
  const here = Array.isArray(items) ? [`${path}.items`] : [];
  return [
    ...here,
    ...entries.flatMap(([key, child]) =>
      collectDraft7TupleItems(child, `${path}.${key}`),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHoplonMcpServer', () => {
  // 1. Server construction
  it('constructs without error given a mock engine', () => {
    const engine = makeMockEngine();
    const server = createHoplonMcpServer({ engine });
    expect(server).toBeDefined();
  });

  // 2. Tool listing
  it('tools/list returns the full registered tool set', async () => {
    const { client } = await buildClientServer();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'audit_diff',
      'clear_semantic_overlay',
      'compute_minimal_patch',
      'create_snapshot',
      'describe_capabilities',
      'describe_project',
      'dry_run',
      'extract_structural_template',
      'find_referencing_symbols',
      'find_syntax_node',
      'get_relevant_tests',
      'health',
      'index_semantic_corpus',
      'pack_context',
      'preflight',
      'query_structure',
      'refresh_semantic_overlay',
      'revert_uncontracted',
      'search_symbols',
      'see_codebase',
      'semantic_search',
    ]);
    const semanticSearchTool = result.tools.find((tool) => tool.name === 'semantic_search');
    expect(semanticSearchTool?.description).toContain('unified advisory semantic retrieval');
    expect(semanticSearchTool?.description).toContain('see_codebase');
    expect(semanticSearchTool?.description).toContain('typed recovery guidance');
  });

  it('strict_agent profile exposes only the curated agent tools', async () => {
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine });
    const server = createHoplonMcpServer({
      engine,
      sessionRegistry: registry,
      agentToolProfile: 'strict_agent',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'describe_capabilities',
          'describe_project',
          'find_syntax_node',
          'get_relevant_tests',
          'health',
          'index_semantic_corpus',
          'refresh_semantic_overlay',
          'clear_semantic_overlay',
          'search_symbols',
          'see_codebase',
          'semantic_search',
          'session_apply_edits',
          'session_audit',
          'session_close',
          'session_create_snapshot',
          'session_dry_run',
          'session_extract_rollback_template',
          'session_get_closeout_proof_bundle',
          'session_get_repair_context',
          'session_inspect',
          'session_list',
          'session_preflight',
          'session_revert',
          'session_review',
          'session_stage_content',
          'session_target_first_scoped_edit',
          'session_verify_behavior',
          'start_edit_session',
        ].sort(),
      );
      expect(names).not.toContain('pack_context');
      expect(names).not.toContain('query_structure');
      expect(names).not.toContain('extract_structural_template');
      expect(names).not.toContain('session_mark_edited');
      expect(names).not.toContain('session_quick_edit');

      const hidden = await client.callTool({
        name: 'session_mark_edited',
        arguments: {},
      });
      expect(hidden.isError).toBe(true);
      const content = hidden.content[0] as { type: string; text: string };
      expect(JSON.parse(content.text)).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_tool',
          details: {
            agentFallbackAllowed: false,
            surface: 'session_mark_edited',
          },
        },
      });

      const quickEdit = await client.callTool({
        name: 'session_quick_edit',
        arguments: {},
      });
      expect(quickEdit.isError).toBe(true);
      const quickEditContent = quickEdit.content[0] as { type: string; text: string };
      const quickEditBody = JSON.parse(quickEditContent.text);
      expect(quickEditBody).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_tool',
          details: {
            agentFallbackAllowed: false,
            surface: 'session_quick_edit',
          },
        },
      });
      expect(quickEditBody.error.message).not.toMatch(/cat|rg|filesystem|IDE/i);
    } finally {
      await client.close();
      await server.close();
      registry.dispose();
    }
  });

  // 2b. Each tool has an inputSchema with type 'object'
  it('each tool has inputSchema.type === "object"', async () => {
    const { client } = await buildClientServer();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('tools/list emits Claude-compatible draft 2020-12 input schemas', async () => {
    const { client } = await buildClientServerWithSessions();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(collectSchemaRefs(tool.inputSchema), tool.name).toEqual([]);
      expect(collectDraft7TupleItems(tool.inputSchema), tool.name).toEqual([]);
    }
  });

  // 2c. Specific tools have expected properties in their inputSchema
  it('audit_diff inputSchema has required fields', async () => {
    const { client } = await buildClientServer();
    const result = await client.listTools();
    const auditTool = result.tools.find((t) => t.name === 'audit_diff');
    expect(auditTool).toBeDefined();
    const props = auditTool!.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('snapshotRefId');
    expect(props).toHaveProperty('projectId');
    expect(props).toHaveProperty('runId');
    expect(props).toHaveProperty('correlationId');
    expect(props).toHaveProperty('files');
  });

  it('create_snapshot inputSchema has manifest property', async () => {
    const { client } = await buildClientServer();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'create_snapshot');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('manifest');
  });

  // 3a. health tool: no args → engine.health() invoked → JSON result
  it('health tool invokes engine.health() and returns JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const content = result.content[0] as { type: string; text: string };
    expect(content.type).toBe('text');
    const parsed = JSON.parse(content.text) as { engineId: string };
    expect(parsed.engineId).toBe('test');
    expect(engine.health).toHaveBeenCalledOnce();
  });

  it('describe_capabilities invokes engine.describeCapabilities() and returns JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const result = await client.callTool({
      name: 'describe_capabilities',
      arguments: { correlationId: 'corr-mcp-cap-1' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as {
      capabilities: Array<{ descriptor: { capabilityId: string } }>;
    };
    expect(parsed.capabilities[0]?.descriptor.capabilityId).toBe('codeIntelligence');
    expect(engine.describeCapabilities).toHaveBeenCalledOnce();
  });

  it('search_symbols: valid args → engine.searchSymbols invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      namePattern: '^create',
      files: ['src/foo.ts'],
      kinds: ['function'],
      maxResults: 10,
    };
    const result = await client.callTool({ name: 'search_symbols', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { matches: unknown[]; failures: unknown[] };
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
    expect(engine.searchSymbols).toHaveBeenCalledOnce();
  });

  it('find_referencing_symbols: valid args → engine.findReferencingSymbols invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      correlationId: 'c1',
      target: {
        type: 'symbol_identity',
        symbol: { name: 'alpha', kind: 'function', byteRange: [0, 5] },
      },
    };
    const result = await client.callTool({ name: 'find_referencing_symbols', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { advisory: boolean; status: string };
    expect(parsed.advisory).toBe(true);
    expect(parsed.status).toBe('UNAVAILABLE');
    expect(engine.findReferencingSymbols).toHaveBeenCalledOnce();
  });

  it('find_syntax_node: valid args → engine.findSyntaxNode invoked without PASS/BLOCK calls', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      file: 'src/foo.ts',
      target: { type: 'byte_offset', byteOffset: 0, namedOnly: true },
      includeText: true,
    };
    const result = await client.callTool({ name: 'find_syntax_node', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { advisory: boolean; status: string };
    expect(parsed.advisory).toBe(true);
    expect(parsed.status).toBe('FOUND');
    expect(engine.findSyntaxNode).toHaveBeenCalledOnce();
    expect(engine.auditDiff).not.toHaveBeenCalled();
    expect(engine.dryRun).not.toHaveBeenCalled();
    expect(engine.preflight).not.toHaveBeenCalled();
  });

  it('index_semantic_corpus: valid args → engine.indexSemanticCorpus invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      correlationId: 'c1',
      documents: [
        {
          id: 'doc-alpha',
          text: 'alpha semantic document',
          metadata: { path: 'src/alpha.ts' },
        },
      ],
    };
    const result = await client.callTool({ name: 'index_semantic_corpus', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { status: string; indexedCount: number };
    expect(parsed.status).toBe('AVAILABLE');
    expect(parsed.indexedCount).toBe(1);
    expect(engine.indexSemanticCorpus).toHaveBeenCalledOnce();
    expect(engine.auditDiff).not.toHaveBeenCalled();
  });

  it('semantic_search: valid args → engine.semanticSearch invoked → advisory matches', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      correlationId: 'c1',
      query: 'alpha',
      topK: 3,
    };
    const result = await client.callTool({ name: 'semantic_search', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as {
      advisory: boolean;
      status: string;
      suggestions?: Array<{ kind: string; value?: string; provenance?: string }>;
      matches: Array<{ id: string; rankSource?: string }>;
    };
    expect(parsed.advisory).toBe(true);
    expect(parsed.status).toBe('AVAILABLE');
    expect(parsed.suggestions?.[0]).toMatchObject({
      kind: 'stale_index',
      value: 'branch:feature/semantic',
      provenance: 'deterministic',
    });
    expect(parsed.matches[0]?.id).toBe('doc-alpha');
    expect(parsed.matches[0]?.rankSource).toBe('baseline_vector');
    expect(engine.semanticSearch).toHaveBeenCalledOnce();
    expect(engine.auditDiff).not.toHaveBeenCalled();
    expect(engine.dryRun).not.toHaveBeenCalled();
    expect(engine.preflight).not.toHaveBeenCalled();
  });

  it('create_snapshot: valid args → engine.createSnapshot invoked with parsed args', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'p1',
        runId: 'run-1',
        correlationId: 'c1',
        entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
      },
    };
    const result = await client.callTool({ name: 'create_snapshot', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { snapshotRef: { id: string } };
    expect(parsed.snapshotRef.id).toMatch(/^sha256:/);
    expect(engine.createSnapshot).toHaveBeenCalledOnce();
    const call = (engine.createSnapshot as MockedFunction<HoplonEngine['createSnapshot']>).mock.calls[0];
    expect(call?.[0]).toEqual(args);
  });

  it('describe_project: valid args → engine.describeProject invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      maxFiles: 10,
      samplePathsPerLanguage: 5,
    };
    const result = await client.callTool({ name: 'describe_project', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as {
      files: { total: number; byLanguage: unknown[] };
      failures: unknown[];
    };
    expect(parsed.files.total).toBe(0);
    expect(Array.isArray(parsed.files.byLanguage)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
    expect(engine.describeProject).toHaveBeenCalledOnce();
  });

  // 3b. audit_diff: valid input → engine.auditDiff called
  it('audit_diff: valid args → engine.auditDiff invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      snapshotRefId: 'sha256:' + 'a'.repeat(64),
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      files: ['src/index.ts'],
    };
    const result = await client.callTool({ name: 'audit_diff', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { status: string };
    expect(parsed.status).toBe('PASS');
    expect(engine.auditDiff).toHaveBeenCalledOnce();
    const call = (engine.auditDiff as MockedFunction<HoplonEngine['auditDiff']>).mock.calls[0];
    expect(call?.[0].snapshotRefId).toBe('sha256:' + 'a'.repeat(64));
  });

  // 3c. pack_context: valid input → engine.packContext invoked
  it('pack_context: valid args → engine.packContext invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      files: ['src/foo.ts'],
      strategy: { kind: 'whole_file' },
    };
    const result = await client.callTool({ name: 'pack_context', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { projectId: string };
    expect(parsed.projectId).toBe('p1');
    expect(engine.packContext).toHaveBeenCalledOnce();
  });

  // 3d. compute_minimal_patch: synchronous engine method routed correctly
  it('compute_minimal_patch: valid args → engine.computeMinimalPatch invoked synchronously', async () => {
    const { client, engine } = await buildClientServer();
    // AuditViolationUncontractedFileSchema shape (simpler — no expectedScope required)
    const args = {
      content: 'const x = 1;',
      violations: [
        {
          kind: 'uncontracted_file',
          path: 'src/foo.ts',
          firstChangedLine: 1,
          sourceSlice: 'const x = 1;',
          message: 'File not in manifest.',
          correction: 'Remove this file.',
        },
      ],
    };
    const result = await client.callTool({ name: 'compute_minimal_patch', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { patchable: boolean };
    expect(parsed.patchable).toBe(true);
    expect(engine.computeMinimalPatch).toHaveBeenCalledOnce();
  });

  // 3e. query_structure: valid input → engine.queryStructure invoked
  it('query_structure: valid args → engine.queryStructure invoked → JSON result', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      files: ['src/foo.ts'],
      queries: [{ id: 'q1', language: 'typescript', pattern: '(identifier) @name' }],
    };
    const result = await client.callTool({ name: 'query_structure', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { matches: unknown[] };
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(engine.queryStructure).toHaveBeenCalledOnce();
  });

  // 3f. get_relevant_tests: valid input → engine.getRelevantTests invoked
  it('get_relevant_tests: valid args → engine.getRelevantTests invoked', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      modifiedFiles: ['src/foo.ts'],
    };
    const result = await client.callTool({ name: 'get_relevant_tests', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { coverageConfidence: string };
    expect(parsed.coverageConfidence).toBe('exact');
    expect(engine.getRelevantTests).toHaveBeenCalledOnce();
  });

  it('revert_uncontracted: valid args → engine.revertUncontracted invoked with parsed args', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      snapshotRefId: 'sha256:' + 'a'.repeat(64),
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
    };
    const result = await client.callTool({ name: 'revert_uncontracted', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { restoredCount: number };
    expect(parsed.restoredCount).toBe(0);
    expect(engine.revertUncontracted).toHaveBeenCalledOnce();
    const call = (engine.revertUncontracted as MockedFunction<
      HoplonEngine['revertUncontracted']
    >).mock.calls[0];
    expect(call?.[0]).toEqual(args);
  });

  it('session_dry_run: valid args → session wrapper routes to engine.dryRun with parsed args', async () => {
    const { client, engine } = await buildClientServerWithSessions();
    const manifest = {
      manifestSchemaVersion: 1,
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
    };
    const startRaw = await client.callTool({ name: 'start_edit_session', arguments: { manifest } });
    expect(startRaw.isError).toBeFalsy();
    const startData = JSON.parse(startRaw.content[0]!.text) as { session: { sessionId: string } };

    const preflight = await client.callTool({
      name: 'session_preflight',
      arguments: { sessionId: startData.session.sessionId },
    });
    expect(preflight.isError).toBeFalsy();

    const snapped = await client.callTool({
      name: 'session_create_snapshot',
      arguments: { sessionId: startData.session.sessionId },
    });
    expect(snapped.isError).toBeFalsy();

    const proposedChanges = [{ file: 'src/foo.ts', content: 'const x = 1;' }];
    const result = await client.callTool({
      name: 'session_dry_run',
      arguments: {
        sessionId: startData.session.sessionId,
        proposedChanges,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(engine.dryRun).toHaveBeenCalledOnce();
    const call = (engine.dryRun as MockedFunction<HoplonEngine['dryRun']>).mock.calls[0];
    expect(call?.[0]).toMatchObject({
      snapshotRefId: 'sha256:' + 'a'.repeat(64),
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      proposedChanges,
    });
  });

  // 4a. audit_diff: missing required fields → isError response
  it('audit_diff: missing required fields → isError: true, kind present', async () => {
    const { client } = await buildClientServer();
    // Missing projectId, runId, correlationId, files
    const result = await client.callTool({
      name: 'audit_diff',
      arguments: { snapshotRefId: 'sha256:' + 'a'.repeat(64) },
    });
    expect(result.isError).toBe(true);
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { error: boolean; kind: string };
    expect(parsed.error).toBe(true);
    expect(typeof parsed.kind).toBe('string');
    expect(parsed.kind.length).toBeGreaterThan(0);
  });

  // 4b. pack_context: missing required strategy field → isError response
  it('pack_context: missing required strategy field → isError: true', async () => {
    const { client } = await buildClientServer();
    // strategy is required; omitting it should fail Zod parse
    const result = await client.callTool({
      name: 'pack_context',
      arguments: {
        projectId: 'p1',
        runId: 'run-1',
        correlationId: 'c1',
        files: ['src/foo.ts'],
        // strategy is intentionally omitted
      },
    });
    expect(result.isError).toBe(true);
  });

  // 4c. query_structure: empty queries array → isError response
  it('query_structure: empty queries array → isError: true', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({
      name: 'query_structure',
      arguments: {
        projectId: 'p1',
        runId: 'run-1',
        correlationId: 'c1',
        files: ['src/foo.ts'],
        queries: [], // empty — fails min(1) constraint
      },
    });
    expect(result.isError).toBe(true);
  });

  it('search_symbols: missing namePattern → isError: true', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({
      name: 'search_symbols',
      arguments: {
        projectId: 'p1',
        runId: 'run-1',
        correlationId: 'c1',
      },
    });
    expect(result.isError).toBe(true);
  });

  it('semantic_search: missing query → isError: true', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({
      name: 'semantic_search',
      arguments: {
        projectId: 'p1',
        correlationId: 'c1',
        topK: 3,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as {
      recovery?: { diagnostics?: Array<{ fieldPath: string; message: string }> };
    };
    expect(parsed.recovery?.diagnostics).toContainEqual(
      expect.objectContaining({
        fieldPath: 'query',
        message: "Missing required semanticSearch field 'query'",
      }),
    );
  });

  it('describe_project: non-positive maxFiles → isError: true', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({
      name: 'describe_project',
      arguments: {
        projectId: 'p1',
        runId: 'run-1',
        correlationId: 'c1',
        maxFiles: 0,
      },
    });
    expect(result.isError).toBe(true);
  });

  // 5. H13: error response content must not expose symbol names or file paths
  it('H13: error response does not include symbol names or file paths', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({
      name: 'audit_diff',
      arguments: { snapshotRefId: 'sha256:' + 'a'.repeat(64) },
    });
    expect(result.isError).toBe(true);
    const content = result.content[0] as { type: string; text: string };
    const text = content.text;
    // H13: error text must not contain file paths like 'src/', '/', '.ts'
    // beyond the top-level 'kind' + 'message' envelope.
    // We check the parsed JSON fields — message must only contain the error kind.
    const parsed = JSON.parse(text) as { message: string; kind: string };
    // The message should only reference the kind, not any file path or symbol.
    expect(parsed.message).toMatch(/^Hoplon error:/);
    expect(parsed.message).not.toMatch(/src\//);
    expect(parsed.message).not.toMatch(/\.ts/);
  });

  // 9. Unknown tool name → error response
  it('unknown tool name → isError: true, tool_not_found kind', async () => {
    const { client } = await buildClientServer();
    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { kind: string };
    expect(parsed.kind).toBe('tool_not_found');
  });

  // 6. End-to-end stdio transport test: round-trip via in-memory transport
  it('end-to-end: in-process client connects and dry_run round-trips', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      snapshotRefId: 'sha256:' + 'a'.repeat(64),
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      proposedChanges: [{ file: 'src/foo.ts', content: 'const x = 1;' }],
    };
    const result = await client.callTool({ name: 'dry_run', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    expect(content.type).toBe('text');
    const parsed = JSON.parse(content.text) as { status: string };
    expect(parsed.status).toBe('PASS');
    expect(engine.dryRun).toHaveBeenCalledOnce();
  });

  // Additional coverage: preflight tool
  it('preflight: valid args → engine.preflight invoked', async () => {
    const { client, engine } = await buildClientServer();
    // entries must have at least one entry (manifest.ts min(1) constraint)
    const manifest = {
      manifestSchemaVersion: 2,
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
    };
    const args = {
      manifest,
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
    };
    const result = await client.callTool({ name: 'preflight', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { status: string };
    expect(parsed.status).toBe('PASS');
    expect(engine.preflight).toHaveBeenCalledOnce();
  });

  // Additional coverage: extract_structural_template tool
  it('extract_structural_template: valid args → engine method invoked', async () => {
    const { client, engine } = await buildClientServer();
    const args = {
      projectId: 'p1',
      runId: 'run-1',
      correlationId: 'c1',
      files: ['src/foo.ts'],
    };
    const result = await client.callTool({ name: 'extract_structural_template', arguments: args });
    expect(result.isError).toBeFalsy();
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { queryId: string };
    expect(parsed.queryId).toBe('structural-template');
    expect(engine.extractStructuralTemplate).toHaveBeenCalledOnce();
  });

  // Engine error propagated correctly
  it('engine error propagated as isError response without exposing internal details', async () => {
    const engine = makeMockEngine();
    // Override health to throw an engine error
    const { SemanticError } = await import('../../src/hoplon/contracts/errors.js');
    (engine.health as MockedFunction<HoplonEngine['health']>).mockRejectedValue(
      new SemanticError({ kind: 'snapshot_missing', engineId: 'test', correlationId: 'c1' }),
    );
    const server = createHoplonMcpServer({ engine });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text) as { kind: string; message: string };
    expect(parsed.kind).toBe('snapshot_missing');
    // H13: message must not contain file paths or symbol names
    expect(parsed.message).toBe('Hoplon error: snapshot_missing');
  });
});
