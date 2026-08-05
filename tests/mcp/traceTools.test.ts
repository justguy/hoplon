/**
 * tests/mcp/traceTools.test.ts — MCP trace read/export surface (t-068).
 *
 * Mirrors the HTTP trace-route test but over the MCP in-memory transport.
 * Proves that the MCP server registers the trace tools only when a
 * TraceStore is supplied, and that each tool returns the durable record
 * payload (or a well-formed error envelope) for a session-seeded store.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import type { TraceStore } from '../../src/hoplon/adapters/traceStore.js';
import { roleBasedProofAccessPolicy } from '../../src/hoplon/contracts/complianceAccess.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';
import { MANIFEST, BLOCK_AUDIT, makeMockEngine } from '../session/helpers.js';

async function seedStore(): Promise<{ store: TraceStore; executionId: string }> {
  const store = createInMemoryTraceStore();
  const sessionId = 'sess-mcp-trace';
  const session = createHoplonEditSession({
    engine: makeMockEngine({ auditDiff: async () => BLOCK_AUDIT }),
    manifest: MANIFEST,
    sessionId,
    traceStore: store,
  });
  await session.preflight();
  await session.createSnapshot();
  await session.markEdited(['src/foo.ts']);
  await session.audit();
  session.close();
  return { store, executionId: deriveExecutionId(sessionId) };
}

async function buildClientServer(
  store?: TraceStore,
  proofAccess?: Parameters<typeof createHoplonMcpServer>[0]['proofAccess'],
): Promise<{ client: Client }> {
  const engine = makeMockEngine();
  const server = createHoplonMcpServer(
    store ? { engine, traceStore: store, ...(proofAccess ? { proofAccess } : {}) } : { engine },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'trace-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client };
}

function parseText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const item = result.content[0] as { type: string; text?: string };
  return JSON.parse(item.text ?? '{}');
}

describe('MCP trace tools (t-068)', () => {
  it('trace tools are absent when no traceStore is supplied', async () => {
    const { client } = await buildClientServer();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).not.toContain('list_executions');
    expect(names).not.toContain('get_execution');
  });

  it('registers list_executions / get_execution / get_proof_bundle / search_traces / export_execution_json when a store is supplied', async () => {
    const { store } = await seedStore();
    const { client } = await buildClientServer(store);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    for (const expected of [
      'list_executions',
      'get_execution',
      'get_attempt',
      'get_proof_bundle',
      'get_violation',
      'search_traces',
      'export_execution_json',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('get_execution returns execution + attempts + proofBundles + provenance', async () => {
    const { store, executionId } = await seedStore();
    const { client } = await buildClientServer(store);
    const result = await client.callTool({
      name: 'get_execution',
      arguments: { executionId },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as { content: Array<{ type: string; text?: string }> }) as {
      execution: { executionId: string; currentStatus: string };
      attempts: Array<{ status: string }>;
      proofBundles: unknown[];
      provenance: Array<{ category: string }>;
    };
    expect(body.execution.executionId).toBe(executionId);
    expect(body.attempts[0]?.status).toBe('BLOCK');
    expect(body.proofBundles.length).toBe(1);
    expect(body.provenance[0]?.category).toBe('hoplon_proved');
  });

  it('get_execution returns an error envelope for an unknown id', async () => {
    const { store } = await seedStore();
    const { client } = await buildClientServer(store);
    const result = await client.callTool({
      name: 'get_execution',
      arguments: { executionId: 'exec_missing' },
    });
    expect(result.isError).toBe(true);
    const body = parseText(result as { content: Array<{ type: string; text?: string }> }) as {
      error: boolean;
      kind: string;
    };
    expect(body.error).toBe(true);
    expect(body.kind).toBe('execution_not_found');
  });

  it('search_traces filters by path via the violation index', async () => {
    const { store } = await seedStore();
    const { client } = await buildClientServer(store);
    const result = await client.callTool({
      name: 'search_traces',
      arguments: { path: 'src/foo.ts' },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as { content: Array<{ type: string; text?: string }> }) as {
      attempts: Array<{ attemptId: string }>;
    };
    expect(body.attempts.length).toBeGreaterThan(0);
  });

  it('export_execution_json returns the full durable bundle', async () => {
    const { store, executionId } = await seedStore();
    const { client } = await buildClientServer(store);
    const result = await client.callTool({
      name: 'export_execution_json',
      arguments: { executionId },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as { content: Array<{ type: string; text?: string }> }) as {
      execution: { executionId: string };
      attempts: unknown[];
      proofBundles: unknown[];
      violations: unknown[];
      provenance: unknown[];
      schemaVersion: number;
    };
    expect(body.execution.executionId).toBe(executionId);
    expect(body.schemaVersion).toBe(1);
  });

  it('enterprise get_proof_bundle audits and grants raw proof reads', async () => {
    const { store, executionId } = await seedStore();
    const events: ProofAccessAuditEvent[] = [];
    const bundles = await store.listProofBundles(executionId);
    const ref = bundles[0]!.proofBundleRef;
    const { client } = await buildClientServer(store, {
      policy: roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: ['compliance'],
        source_slice: [],
        export: [],
      }),
      auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
      principalId: 'compliance',
      engineId: 'mcp-test',
      now: () => '2026-04-01T00:00:00.000Z',
    });

    const result = await client.callTool({
      name: 'get_proof_bundle',
      arguments: { proofBundleRef: ref },
    });

    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      principalId: 'compliance',
      engineId: 'mcp-test',
      accessClass: 'raw_proof',
      objectRef: ref,
      outcome: 'GRANTED',
    });
  });

  it('enterprise get_proof_bundle denies before reading raw proof', async () => {
    const { store, executionId } = await seedStore();
    const bundles = await store.listProofBundles(executionId);
    const ref = bundles[0]!.proofBundleRef;
    let rawProofRead = false;
    const guardedStore: TraceStore = {
      ...store,
      getProofBundle: async () => {
        rawProofRead = true;
        throw new Error('raw proof should not be read before denial');
      },
    };
    const events: ProofAccessAuditEvent[] = [];
    const { client } = await buildClientServer(guardedStore, {
      policy: roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: ['compliance'],
        source_slice: [],
        export: [],
      }),
      auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
      principalId: 'viewer',
      engineId: 'mcp-test',
      now: () => '2026-04-01T00:00:00.000Z',
    });

    const result = await client.callTool({
      name: 'get_proof_bundle',
      arguments: { proofBundleRef: ref },
    });

    expect(result.isError).toBe(true);
    expect(rawProofRead).toBe(false);
    expect(events[0]).toMatchObject({
      principalId: 'viewer',
      accessClass: 'raw_proof',
      objectRef: ref,
      outcome: 'DENIED',
    });
  });

  it('enterprise export_execution_json audits and denies missing export role', async () => {
    const { store, executionId } = await seedStore();
    let rawExportRead = false;
    const guardedStore: TraceStore = {
      ...store,
      exportExecution: async () => {
        rawExportRead = true;
        throw new Error('raw export should not be read before denial');
      },
    };
    const events: ProofAccessAuditEvent[] = [];
    const { client } = await buildClientServer(guardedStore, {
      policy: roleBasedProofAccessPolicy({
        metadata: [],
        standard_trace: [],
        proof_detail: [],
        raw_proof: [],
        source_slice: [],
        export: ['compliance'],
      }),
      auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
      principalId: 'viewer',
      engineId: 'mcp-test',
      now: () => '2026-04-01T00:00:00.000Z',
    });

    const result = await client.callTool({
      name: 'export_execution_json',
      arguments: { executionId },
    });

    expect(result.isError).toBe(true);
    expect(rawExportRead).toBe(false);
    const body = parseText(result as { content: Array<{ type: string; text?: string }> }) as {
      kind: string;
    };
    expect(body.kind).toBe('missing_role');
    expect(events[0]).toMatchObject({
      principalId: 'viewer',
      accessClass: 'export',
      objectRef: executionId,
      outcome: 'DENIED',
      reasonCode: 'missing_role',
    });
  });
});
