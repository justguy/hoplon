/**
 * tests/transport/http.sessionRouteParity.test.ts — packaged session route parity.
 *
 * Proves the packaged HTTP session surface stays honest: when a session
 * registry is supplied, every shipped `/session/*` route is present; when the
 * registry is omitted, none of those additive routes are registered.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { makeMockEngine } from '../session/helpers.js';

const SESSION_POST_ROUTES = [
  '/session/start',
  '/session/preflight',
  '/session/createSnapshot',
  '/session/dryRun',
  '/session/applyEdits',
  '/session/stageContent',
  '/session/markEdited',
  '/session/audit',
  '/session/revert',
  '/session/extractRollbackTemplate',
  '/session/getRepairContext',
  '/session/review',
  '/session/verifyBehavior',
  '/session/quickEdit',
  '/session/snapshotEvidence',
  '/session/inspect',
  '/session/close',
] as const;

const STRICT_SESSION_POST_ROUTES = [
  '/session/start',
  '/session/preflight',
  '/session/createSnapshot',
  '/session/dryRun',
  '/session/applyEdits',
  '/session/stageContent',
  '/session/audit',
  '/session/revert',
  '/session/extractRollbackTemplate',
  '/session/getRepairContext',
  '/session/review',
  '/session/verifyBehavior',
  '/session/snapshotEvidence',
  '/session/inspect',
  '/session/close',
] as const;

describe('HTTP session route parity (t-069)', () => {
  it('registers every shipped /session/* route when a session registry is present', async () => {
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });

    try {
      for (const route of SESSION_POST_ROUTES) {
        expect(server.hasRoute({ method: 'POST', url: route })).toBe(true);
      }
      expect(server.hasRoute({ method: 'GET', url: '/session/list' })).toBe(true);
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('does not register /session/* routes when no session registry is supplied', async () => {
    const engine = makeMockEngine();
    const server = await createHoplonHttpServer({ engine });

    try {
      for (const route of SESSION_POST_ROUTES) {
        expect(server.hasRoute({ method: 'POST', url: route })).toBe(false);
      }
      expect(server.hasRoute({ method: 'GET', url: '/session/list' })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('strict_agent omits markEdited and quickEdit while keeping session loop routes', async () => {
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({
      engine,
      sessionRegistry: registry,
      agentToolProfile: 'strict_agent',
    });

    try {
      for (const route of STRICT_SESSION_POST_ROUTES) {
        expect(server.hasRoute({ method: 'POST', url: route })).toBe(true);
      }
      expect(server.hasRoute({ method: 'GET', url: '/session/list' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/session/markEdited' })).toBe(false);
      expect(server.hasRoute({ method: 'POST', url: '/session/quickEdit' })).toBe(false);

      const markEdited = await server.inject({
        method: 'POST',
        url: '/session/markEdited',
        payload: { sessionId: 'missing', files: ['src/a.ts'] },
      });
      expect(markEdited.statusCode).toBe(403);
      expect(JSON.parse(markEdited.body)).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_route',
          details: {
            agentFallbackAllowed: false,
            surface: '/session/markEdited',
          },
        },
      });

      const quickEdit = await server.inject({
        method: 'POST',
        url: '/session/quickEdit',
        payload: { editMode: 'markEdited', markEditedFiles: ['src/a.ts'] },
      });
      expect(quickEdit.statusCode).toBe(403);
      const quickEditBody = JSON.parse(quickEdit.body);
      expect(quickEditBody).toMatchObject({
        error: {
          class: 'StrictAgentFallbackError',
          kind: 'strict_agent_unsupported_route',
          details: {
            agentFallbackAllowed: false,
            surface: '/session/quickEdit',
          },
        },
      });
      expect(quickEditBody.error.message).not.toMatch(/cat|rg|filesystem|IDE/i);
    } finally {
      await server.close();
      registry.dispose();
    }
  });
});
