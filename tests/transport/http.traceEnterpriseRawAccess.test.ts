/**
 * tests/transport/http.traceEnterpriseRawAccess.test.ts — GAP G5 regression.
 *
 * The raw trace endpoints /attempts/:id, /violations/:id, /audits/:ref and
 * /search returned raw proof content with no enterprise access check, unlike
 * their siblings /executions/:id and /proof/:ref. With enterprise access
 * configured they must now deny unauthorized reads (and not read raw proof
 * before denial). With no enterprise access configured they behave as before.
 */

import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import type { TraceStore } from '../../src/hoplon/adapters/traceStore.js';
import { MANIFEST, BLOCK_AUDIT, makeMockEngine } from '../session/helpers.js';
import { roleBasedProofAccessPolicy } from '../../src/hoplon/contracts/complianceAccess.js';
import type { ProofAccessAuditEvent } from '../../src/hoplon/contracts/complianceAccess.js';

async function seed(): Promise<{
  store: TraceStore;
  executionId: string;
  attemptId: string;
  violationId: string;
  auditRef: string;
}> {
  const store = createInMemoryTraceStore();
  const sessionId = 'sess-g5-raw';
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

  const executionId = deriveExecutionId(sessionId);
  const attempts = await store.listAttempts(executionId);
  const bundles = await store.listProofBundles(executionId);
  const violations = await store.listViolations(bundles[0]!.proofBundleRef);
  return {
    store,
    executionId,
    attemptId: attempts[0]!.attemptId,
    violationId: violations[0]!.violationId,
    auditRef: attempts[0]!.auditRef ?? 'audit-missing',
  };
}

function denyingProofAccess(events: ProofAccessAuditEvent[]) {
  return {
    policy: roleBasedProofAccessPolicy({
      metadata: [],
      standard_trace: [],
      proof_detail: [],
      raw_proof: ['compliance'], // only 'compliance' may read raw proof
      source_slice: [],
      export: [],
    }),
    auditSink: { appendProofAccessAudit: async (e: ProofAccessAuditEvent) => { events.push(e); } },
    getAuthContext: () => ({ principal: 'viewer', engineId: 'engine-http' }),
    now: () => '2026-04-01T00:00:00.000Z',
  };
}

describe('GAP G5 — enterprise access checks on raw trace endpoints', () => {
  it('denies /attempts, /violations, /audits, /search when the principal lacks raw_proof', async () => {
    const { store, attemptId, violationId, auditRef } = await seed();
    const events: ProofAccessAuditEvent[] = [];

    // Guard the store so any raw read before denial is caught.
    let rawRead = false;
    const guarded: TraceStore = {
      ...store,
      getAttempt: async () => { rawRead = true; throw new Error('read before denial'); },
      getViolation: async () => { rawRead = true; throw new Error('read before denial'); },
      searchAttempts: async () => { rawRead = true; throw new Error('read before denial'); },
    };

    const server: FastifyInstance = await createHoplonHttpServer({
      engine: makeMockEngine(),
      traceStore: guarded,
      proofAccess: denyingProofAccess(events),
    });

    for (const url of [
      `/attempts/${attemptId}`,
      `/violations/${violationId}`,
      `/audits/${auditRef}`,
      '/search?path=src/foo.ts',
    ]) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, `expected 403 for ${url}`).toBe(403);
      const body = res.json() as { error: { class: string } };
      expect(body.error.class).toBe('Forbidden');
    }

    // Raw proof was never read before the denial.
    expect(rawRead).toBe(false);
    // Every denied read was audited.
    expect(events.length).toBe(4);
    expect(events.every((e) => e.outcome === 'DENIED' && e.accessClass === 'raw_proof')).toBe(true);
  });

  it('grants the same endpoints when the principal holds the raw_proof role', async () => {
    const { store, attemptId, violationId, auditRef } = await seed();
    const events: ProofAccessAuditEvent[] = [];
    const access = denyingProofAccess(events);
    access.getAuthContext = () => ({ principal: 'compliance', engineId: 'engine-http' });

    const server = await createHoplonHttpServer({
      engine: makeMockEngine(),
      traceStore: store,
      proofAccess: access,
    });

    const attempt = await server.inject({ method: 'GET', url: `/attempts/${attemptId}` });
    expect(attempt.statusCode).toBe(200);
    const violation = await server.inject({ method: 'GET', url: `/violations/${violationId}` });
    expect(violation.statusCode).toBe(200);
    const audits = await server.inject({ method: 'GET', url: `/audits/${auditRef}` });
    expect(audits.statusCode).toBe(200);
    const search = await server.inject({ method: 'GET', url: '/search?path=src/foo.ts' });
    expect(search.statusCode).toBe(200);
  });

  it('with no enterprise access configured, the endpoints behave as before (open reads)', async () => {
    const { store, attemptId, violationId } = await seed();
    const server = await createHoplonHttpServer({ engine: makeMockEngine(), traceStore: store });

    const attempt = await server.inject({ method: 'GET', url: `/attempts/${attemptId}` });
    expect(attempt.statusCode).toBe(200);
    const violation = await server.inject({ method: 'GET', url: `/violations/${violationId}` });
    expect(violation.statusCode).toBe(200);
    const search = await server.inject({ method: 'GET', url: '/search?path=src/foo.ts' });
    expect(search.statusCode).toBe(200);
  });
});
