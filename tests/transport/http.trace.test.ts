/**
 * tests/transport/http.trace.test.ts — HTTP trace read/export surface (t-068).
 *
 * Exercises GET /executions, /executions/:id, /attempts/:id, /proof/:ref,
 * /audits/:ref, /violations/:id, /search plus POST /executions/:id/export
 * over fastify.inject(). The trace store is pre-populated through a real
 * HoplonEditSession + in-memory TraceStore so this suite also proves end-
 * to-end HTTP parity with the data that session.traceWriter actually writes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import type { TraceStore } from '../../src/hoplon/adapters/traceStore.js';
import {
  MANIFEST,
  BLOCK_AUDIT,
  makeMockEngine,
} from '../session/helpers.js';
import { roleBasedProofAccessPolicy } from '../../src/hoplon/contracts/complianceAccess.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';

async function seedTraceStore(): Promise<{ store: TraceStore; executionId: string }> {
  const store = createInMemoryTraceStore();
  const sessionId = 'sess-http-trace';
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
  await session.revert();
  session.close();
  return { store, executionId: deriveExecutionId(sessionId) };
}

interface Fixture {
  server: FastifyInstance;
  executionId: string;
}

describe('HTTP trace routes (t-068)', () => {
  const fixture: { value: Fixture | null } = { value: null };

  beforeAll(async () => {
    const { store, executionId } = await seedTraceStore();
    const engine = makeMockEngine();
    const server = await createHoplonHttpServer({ engine, traceStore: store });
    fixture.value = { server, executionId };
  });

  it('GET /executions lists traces, filterable by projectId', async () => {
    const { server } = fixture.value!;
    const all = await server.inject({ method: 'GET', url: '/executions' });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { executions: Array<{ executionId: string }> };
    expect(allBody.executions.length).toBeGreaterThan(0);

    const filtered = await server.inject({
      method: 'GET',
      url: `/executions?projectId=${MANIFEST.projectId}`,
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { executions: Array<{ projectId: string }> };
    expect(filteredBody.executions.every((e) => e.projectId === MANIFEST.projectId)).toBe(true);
  });

  it('GET /executions/:id returns execution + attempts + proofBundles + provenance', async () => {
    const { server, executionId } = fixture.value!;
    const res = await server.inject({ method: 'GET', url: `/executions/${executionId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      execution: { executionId: string; currentStatus: string };
      attempts: Array<{ attemptId: string; status: string }>;
      proofBundles: Array<{ proofBundleRef: string }>;
      provenance: Array<{ category: string }>;
    };
    expect(body.execution.executionId).toBe(executionId);
    expect(body.execution.currentStatus).toBe('BLOCK');
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]?.status).toBe('BLOCK');
    expect(body.proofBundles).toHaveLength(1);
    expect(body.provenance[0]?.category).toBe('hoplon_proved');
  });

  it('GET /executions/:id returns 404 for unknown execution', async () => {
    const { server } = fixture.value!;
    const res = await server.inject({ method: 'GET', url: '/executions/exec_missing' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { kind: string } };
    expect(body.error.kind).toBe('execution_not_found');
  });

  it('GET /proof/:ref returns bundle + violations; raw AuditResult preserved', async () => {
    const { server, executionId } = fixture.value!;
    const execRes = await server.inject({ method: 'GET', url: `/executions/${executionId}` });
    const execBody = execRes.json() as { proofBundles: Array<{ proofBundleRef: string }> };
    const ref = execBody.proofBundles[0]!.proofBundleRef;

    const res = await server.inject({ method: 'GET', url: `/proof/${ref}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bundle: { auditResult: { status: string } };
      violations: Array<{ path: string; kind: string }>;
    };
    expect(body.bundle.auditResult.status).toBe('BLOCK');
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0]?.path).toBe('src/foo.ts');
  });

  it('enterprise GET /proof/:ref audits and grants raw proof reads', async () => {
    const { store, executionId } = await seedTraceStore();
    const events: ProofAccessAuditEvent[] = [];
    const server = await createHoplonHttpServer({
      engine: makeMockEngine(),
      traceStore: store,
      proofAccess: {
        policy: roleBasedProofAccessPolicy({
          metadata: [],
          standard_trace: [],
          proof_detail: [],
          raw_proof: ['compliance'],
          source_slice: [],
          export: [],
        }),
        auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
        getAuthContext: () => ({ principal: 'compliance', engineId: 'engine-http' }),
        now: () => '2026-04-01T00:00:00.000Z',
      },
    });
    const exec = await store.getExecution(executionId);
    expect(exec).not.toBeNull();
    const bundles = await store.listProofBundles(executionId);
    const ref = bundles[0]!.proofBundleRef;

    const res = await server.inject({ method: 'GET', url: `/proof/${ref}` });
    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      principalId: 'compliance',
      engineId: 'engine-http',
      accessClass: 'raw_proof',
      objectType: 'proof_bundle',
      objectRef: ref,
      outcome: 'GRANTED',
    });
  });

  it('enterprise GET /proof/:ref denies before reading raw proof', async () => {
    const { store, executionId } = await seedTraceStore();
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
    const server = await createHoplonHttpServer({
      engine: makeMockEngine(),
      traceStore: guardedStore,
      proofAccess: {
        policy: roleBasedProofAccessPolicy({
          metadata: [],
          standard_trace: [],
          proof_detail: [],
          raw_proof: ['compliance'],
          source_slice: [],
          export: [],
        }),
        auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
        getAuthContext: () => ({ principal: 'viewer', engineId: 'engine-http' }),
        now: () => '2026-04-01T00:00:00.000Z',
      },
    });

    const res = await server.inject({ method: 'GET', url: `/proof/${ref}` });
    expect(res.statusCode).toBe(403);
    expect(rawProofRead).toBe(false);
    expect(events[0]).toMatchObject({
      principalId: 'viewer',
      accessClass: 'raw_proof',
      objectType: 'proof_bundle',
      objectRef: ref,
      outcome: 'DENIED',
    });
  });

  it('enterprise POST /executions/:id/export audits and denies missing export role', async () => {
    const { store, executionId } = await seedTraceStore();
    let rawExportRead = false;
    const guardedStore: TraceStore = {
      ...store,
      exportExecution: async () => {
        rawExportRead = true;
        throw new Error('raw export should not be read before denial');
      },
    };
    const events: ProofAccessAuditEvent[] = [];
    const server = await createHoplonHttpServer({
      engine: makeMockEngine(),
      traceStore: guardedStore,
      proofAccess: {
        policy: roleBasedProofAccessPolicy({
          metadata: [],
          standard_trace: [],
          proof_detail: [],
          raw_proof: [],
          source_slice: [],
          export: ['compliance'],
        }),
        auditSink: { appendProofAccessAudit: async (event) => { events.push(event); } },
        getAuthContext: () => ({ principal: 'viewer', engineId: 'engine-http' }),
        now: () => '2026-04-01T00:00:00.000Z',
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/executions/${executionId}/export`,
    });
    expect(res.statusCode).toBe(403);
    expect(rawExportRead).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      principalId: 'viewer',
      accessClass: 'export',
      objectType: 'export_bundle',
      objectRef: executionId,
      outcome: 'DENIED',
      reasonCode: 'missing_role',
    });
  });

  it('GET /search filters by path against the violation index', async () => {
    const { server } = fixture.value!;
    const res = await server.inject({ method: 'GET', url: '/search?path=src/foo.ts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { attempts: Array<{ attemptId: string }> };
    expect(body.attempts.length).toBeGreaterThan(0);
  });

  it('POST /executions/:id/export returns the full durable bundle', async () => {
    const { server, executionId } = fixture.value!;
    const res = await server.inject({
      method: 'POST',
      url: `/executions/${executionId}/export`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      execution: { executionId: string };
      attempts: unknown[];
      proofBundles: unknown[];
      violations: unknown[];
      provenance: unknown[];
      schemaVersion: number;
    };
    expect(body.execution.executionId).toBe(executionId);
    expect(body.attempts.length).toBe(1);
    expect(body.schemaVersion).toBe(1);
  });

  it('POST /executions/:id/export returns 404 for unknown execution', async () => {
    const { server } = fixture.value!;
    const res = await server.inject({
      method: 'POST',
      url: '/executions/exec_missing/export',
    });
    expect(res.statusCode).toBe(404);
  });
});
