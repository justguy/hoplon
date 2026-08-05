/**
 * tests/transport/http.serverRouteParity.test.ts — HTTP route surface parity.
 *
 * Proves the HTTP server's registered route set is derived from the shared
 * proto registry, so `POST /<method>` cannot drift from
 * `HOPLON_PROTO_OPERATIONS`. Adding or removing an engine method in the
 * registry flips this test immediately instead of at runtime.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { HOPLON_PROTO_OPERATIONS } from '../../src/hoplon/transport/proto/registry.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

function buildSpyEngine(): HoplonEngine {
  const noop = (): never => {
    throw new Error('spy engine method not wired for this test');
  };
  return {
    createSnapshot: vi.fn(noop),
    auditDiff: vi.fn(noop),
    revertUncontracted: vi.fn(noop),
    packContext: vi.fn(noop),
    dryRun: vi.fn(noop),
    preflight: vi.fn(noop),
    queryStructure: vi.fn(noop),
    extractStructuralTemplate: vi.fn(noop),
    extractRollbackTemplate: vi.fn(noop),
    getRelevantTests: vi.fn(noop),
    searchSymbols: vi.fn(noop),
    describeProject: vi.fn(noop),
    predictViolationRisk: vi.fn(noop),
    scoreAnomaly: vi.fn(noop),
    analyzeBlastRadius: vi.fn(noop),
    findReferencingSymbols: vi.fn(noop),
    synthesizeInterfaceStubs: vi.fn(noop),
    ephemeralStructuralSandbox: vi.fn(noop),
    describeCapabilities: vi.fn(noop),
    health: vi.fn(noop),
    reconcile: vi.fn(noop),
    gc: vi.fn(noop),
    computeMinimalPatch: vi.fn(noop),
    compressRetryContext: vi.fn(noop),
  } as unknown as HoplonEngine;
}

describe('HTTP route surface parity with proto registry', () => {
  it('registers POST /<method> for every op with hasRequestBody, plus the two bodyless routes', async () => {
    const server = await createHoplonHttpServer({ engine: buildSpyEngine() });
    try {
      // Bodyless routes are HTTP-specific bindings for async_signal_only ops.
      expect(server.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/reconcile' })).toBe(true);

      // POST /<method> is derived from the shared registry — exact parity.
      for (const op of HOPLON_PROTO_OPERATIONS) {
        if (!op.hasRequestBody) continue;
        expect(server.hasRoute({ method: 'POST', url: `/${op.method}` })).toBe(true);
      }

      // Bodyless ops are NOT duplicated as POST /<method> routes.
      for (const op of HOPLON_PROTO_OPERATIONS) {
        if (op.hasRequestBody) continue;
        if (op.method === 'reconcile') continue; // bound bodyless above
        expect(server.hasRoute({ method: 'POST', url: `/${op.method}` })).toBe(false);
      }
    } finally {
      await server.close();
    }
  });

  it('strict_agent registers only curated engine routes', async () => {
    const server = await createHoplonHttpServer({
      engine: buildSpyEngine(),
      agentToolProfile: 'strict_agent',
    });
    const allowedBodyRoutes = new Set([
      'describeCapabilities',
      'describeProject',
      'getRelevantTests',
      'searchSymbols',
      'seeCodebase',
      // Semantic ops are curated into the strict surface (allow-with-
      // engagement): the routes register, and dispatch is gated by the
      // strict engagement gate + file policy.
      'indexSemanticCorpus',
      'semanticSearch',
      'refreshSemanticOverlay',
      'clearSemanticOverlay',
    ]);

    try {
      expect(server.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/reconcile' })).toBe(false);

      for (const op of HOPLON_PROTO_OPERATIONS) {
        if (!op.hasRequestBody) continue;
        expect(server.hasRoute({ method: 'POST', url: `/${op.method}` })).toBe(
          allowedBodyRoutes.has(op.method),
        );
      }

      const hidden = await server.inject({
        method: 'POST',
        url: '/packContext',
        payload: {},
      });
      expect(hidden.statusCode).toBe(403);
      expect(JSON.parse(hidden.body)).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_route',
          details: {
            agentFallbackAllowed: false,
            surface: '/packContext',
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it('strict_agent keeps policy project routes but omits registry management', async () => {
    const server = await createHoplonHttpServer({
      engine: buildSpyEngine(),
      launcherRoot: '/tmp/hoplon-strict-project-route-test',
      agentToolProfile: 'strict_agent',
    });

    try {
      expect(server.hasRoute({ method: 'GET', url: '/projects' })).toBe(false);
      expect(server.hasRoute({ method: 'POST', url: '/projects/register' })).toBe(false);
      expect(server.hasRoute({ method: 'POST', url: '/projects/unregister' })).toBe(false);
      expect(server.hasRoute({ method: 'POST', url: '/projects/select' })).toBe(false);
      expect(server.hasRoute({ method: 'POST', url: '/projects/clear-active' })).toBe(false);

      expect(server.hasRoute({ method: 'POST', url: '/projects/handshake' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/projects/renew' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/projects/revoke' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/projects/prune' })).toBe(true);
      expect(server.hasRoute({ method: 'GET', url: '/projects/policy/summary' })).toBe(true);

      const response = await server.inject({
        method: 'POST',
        url: '/projects/register',
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_route',
          details: {
            agentFallbackAllowed: false,
            surface: '/projects/register',
          },
        },
      });
    } finally {
      await server.close();
    }
  });
});
