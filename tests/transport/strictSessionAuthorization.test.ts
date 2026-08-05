/**
 * tests/transport/strictSessionAuthorization.test.ts — hcr-004 finding 4.
 *
 * Strict session authorization must be bound to the session owner and the
 * engagement folder:
 *   (i)   a different valid project token cannot inspect, operate, or list
 *         another caller's session;
 *   (ii)  strict sessions whose manifest / edited paths escape the
 *         authorized folder are denied;
 *   (iii) the non-strict local flow is unchanged.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { buildSessionToolRegistry } from '../../src/hoplon/mcp/sessionTools.js';
import { MANIFEST, makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = MANIFEST.projectId;
const OWNER_TOKEN = 'owner-token-hcr004';
const OTHER_FOLDER_TOKEN = 'other-folder-token-hcr004';
const OTHER_PRINCIPAL_TOKEN = 'other-principal-token-hcr004';

const OWNER_ENGAGEMENT = {
  token: OWNER_TOKEN,
  folder: 'src',
  principalId: 'agent-a',
};
const OTHER_FOLDER_ENGAGEMENT = {
  token: OTHER_FOLDER_TOKEN,
  folder: 'lib',
  principalId: 'agent-b',
};
const OTHER_PRINCIPAL_ENGAGEMENT = {
  token: OTHER_PRINCIPAL_TOKEN,
  folder: 'src',
  principalId: 'agent-b',
};

function seedTokens(store: EngagementStore): void {
  const base = {
    projectId: PROJECT_ID,
    access: 'read_write' as const,
    issuedAtIso: '2026-07-01T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
  };
  store.put(OWNER_TOKEN, {
    ...base,
    folder: 'src',
    principalId: 'agent-a',
    nonce: 'owner-nonce',
  });
  store.put(OTHER_FOLDER_TOKEN, {
    ...base,
    folder: 'lib',
    principalId: 'agent-b',
    nonce: 'other-folder-nonce',
  });
  store.put(OTHER_PRINCIPAL_TOKEN, {
    ...base,
    folder: 'src',
    principalId: 'agent-b',
    nonce: 'other-principal-nonce',
  });
}

interface StrictServer {
  server: FastifyInstance;
  registry: SessionRegistry;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  dispose: () => Promise<void>;
}

async function buildStrictServer(): Promise<StrictServer> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  seedTokens(engagementStore);
  const engine = makeMockEngine();
  const registry = createSessionRegistry({ engine });
  const server = await createHoplonHttpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-hcr004' }),
  });
  return {
    server,
    registry,
    store,
    engagementStore,
    dispose: async () => {
      await server.close();
      registry.dispose();
    },
  };
}

async function post<T = unknown>(
  server: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: T }> {
  const response = await server.inject({ method: 'POST', url, payload });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as T };
}

async function startOwnerSession(server: FastifyInstance): Promise<string> {
  const start = await post<{ session: { sessionId: string } }>(
    server,
    '/session/start',
    { manifest: MANIFEST, engagement: OWNER_ENGAGEMENT },
  );
  expect(start.statusCode).toBe(200);
  return start.body.session.sessionId;
}

describe('strict session authorization is owner-bound (hcr-004 finding 4)', () => {
  it('records the creator principal and engagement folder on strict start', async () => {
    const { server, registry, dispose } = await buildStrictServer();
    try {
      await startOwnerSession(server);
      const infos = registry.list();
      expect(infos).toHaveLength(1);
      expect(infos[0]?.owner).toEqual({ principalId: 'agent-a', folder: 'src' });
    } finally {
      await dispose();
    }
  });

  it("denies a different valid engagement from operating another caller's session", async () => {
    const { server, registry, store, dispose } = await buildStrictServer();
    try {
      const sessionId = await startOwnerSession(server);

      const inspectOtherFolder = await post<{ error: { class: string; kind: string } }>(
        server,
        '/session/inspect',
        { sessionId, engagement: OTHER_FOLDER_ENGAGEMENT },
      );
      expect(inspectOtherFolder.statusCode).toBe(403);
      expect(inspectOtherFolder.body.error).toMatchObject({
        class: 'StrictEngagementError',
        kind: 'engagement_scope_mismatch_folder',
      });

      const inspectOtherPrincipal = await post<{ error: { kind: string } }>(
        server,
        '/session/inspect',
        { sessionId, engagement: OTHER_PRINCIPAL_ENGAGEMENT },
      );
      expect(inspectOtherPrincipal.statusCode).toBe(403);
      expect(inspectOtherPrincipal.body.error.kind).toBe(
        'engagement_scope_mismatch_principal',
      );

      const closeOther = await post<{ error: { kind: string } }>(
        server,
        '/session/close',
        { sessionId, engagement: OTHER_FOLDER_ENGAGEMENT },
      );
      expect(closeOther.statusCode).toBe(403);
      expect(registry.list()).toHaveLength(1);

      // Denials are audited through the existing policy audit seam.
      const rows = await store.findAuditLogByProjectAndRun(
        PROJECT_ID,
        MANIFEST.runId,
      );
      const reasonCodes = rows.map((row) => row.policyEvent?.reasonCode);
      expect(reasonCodes).toContain('access_scope_mismatch_folder');
      expect(reasonCodes).toContain('access_scope_mismatch_principal');

      // The owner still operates their own session.
      const ownInspect = await post(server, '/session/inspect', {
        sessionId,
        engagement: OWNER_ENGAGEMENT,
      });
      expect(ownInspect.statusCode).toBe(200);
    } finally {
      await dispose();
    }
  });

  it('denies strict start when manifest entries escape the engagement folder', async () => {
    const { server, registry, dispose } = await buildStrictServer();
    try {
      const denied = await post<{ error: { kind: string } }>(
        server,
        '/session/start',
        {
          manifest: {
            ...MANIFEST,
            entries: [{ path: 'secrets/creds.ts', scope: { kind: 'whole_file' } }],
          },
          engagement: OWNER_ENGAGEMENT,
        },
      );
      expect(denied.statusCode).toBe(403);
      expect(denied.body.error.kind).toBe('strict_file_policy');
      expect(registry.list()).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('denies strict applyEdits paths outside the engagement folder', async () => {
    const { server, dispose } = await buildStrictServer();
    try {
      const sessionId = await startOwnerSession(server);
      const denied = await post<{ error: { kind: string } }>(
        server,
        '/session/applyEdits',
        {
          sessionId,
          engagement: OWNER_ENGAGEMENT,
          proposedChanges: [{ file: 'secrets/x.ts', content: 'x\n' }],
        },
      );
      expect(denied.statusCode).toBe(403);
      expect(denied.body.error.kind).toBe('strict_file_policy');
    } finally {
      await dispose();
    }
  });

  it('scopes strict session list to the caller engagement', async () => {
    const { server, dispose } = await buildStrictServer();
    try {
      const sessionId = await startOwnerSession(server);

      // Bodyless GET cannot present an engagement in strict mode — fail closed.
      const get = await server.inject({ method: 'GET', url: '/session/list' });
      expect(get.statusCode).toBe(401);
      expect(JSON.parse(get.body).error.class).toBe('StrictEngagementError');

      const ownList = await post<{ sessions: Array<{ sessionId: string }> }>(
        server,
        '/session/list',
        { projectId: PROJECT_ID, engagement: OWNER_ENGAGEMENT },
      );
      expect(ownList.statusCode).toBe(200);
      expect(ownList.body.sessions.map((s) => s.sessionId)).toEqual([sessionId]);

      const otherList = await post<{ sessions: unknown[] }>(
        server,
        '/session/list',
        { projectId: PROJECT_ID, engagement: OTHER_FOLDER_ENGAGEMENT },
      );
      expect(otherList.statusCode).toBe(200);
      expect(otherList.body.sessions).toEqual([]);

      const noEngagement = await post<{ error: { class: string } }>(
        server,
        '/session/list',
        { projectId: PROJECT_ID },
      );
      expect(noEngagement.statusCode).toBe(401);
      expect(noEngagement.body.error.class).toBe('StrictEngagementError');
    } finally {
      await dispose();
    }
  });

  it('scopes the strict MCP session_list tool to the caller engagement', async () => {
    const store = await createIsolatedTestStore();
    const engagementStore = createInMemoryEngagementStore();
    seedTokens(engagementStore);
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine });
    try {
      const tools = buildSessionToolRegistry({
        registry,
        strictEngagementGate: {
          store: engagementStore,
          sink: createPolicyAuditSink({ store, engineId: 'mcp-hcr004' }),
          engineId: 'mcp-hcr004',
        },
      });
      const startTool = tools.find((t) => t.name === 'start_edit_session');
      const listTool = tools.find((t) => t.name === 'session_list');
      expect(startTool).toBeDefined();
      expect(listTool).toBeDefined();

      const started = await startTool!.handler({
        manifest: MANIFEST as unknown as Record<string, unknown>,
        engagement: OWNER_ENGAGEMENT,
      } as unknown as Record<string, unknown>);
      expect(started.isError).not.toBe(true);

      const ownList = await listTool!.handler({
        projectId: PROJECT_ID,
        engagement: OWNER_ENGAGEMENT,
      });
      expect(ownList.isError).not.toBe(true);
      const ownPayload = JSON.parse(ownList.content[0]!.text) as {
        sessions: unknown[];
      };
      expect(ownPayload.sessions).toHaveLength(1);

      const otherList = await listTool!.handler({
        projectId: PROJECT_ID,
        engagement: OTHER_FOLDER_ENGAGEMENT,
      });
      expect(otherList.isError).not.toBe(true);
      const otherPayload = JSON.parse(otherList.content[0]!.text) as {
        sessions: unknown[];
      };
      expect(otherPayload.sessions).toEqual([]);

      const noEngagement = await listTool!.handler({ projectId: PROJECT_ID });
      expect(noEngagement.isError).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('keeps the non-strict local session flow unchanged', async () => {
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({
      engine,
      sessionRegistry: registry,
    });
    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: MANIFEST },
      );
      expect(start.statusCode).toBe(200);
      const sessionId = start.body.session.sessionId;
      expect(registry.list()[0]?.owner).toBeUndefined();

      const list = await server.inject({ method: 'GET', url: '/session/list' });
      expect(list.statusCode).toBe(200);
      expect(
        (JSON.parse(list.body) as { sessions: Array<{ sessionId: string }> })
          .sessions,
      ).toHaveLength(1);

      const inspect = await post(server, '/session/inspect', { sessionId });
      expect(inspect.statusCode).toBe(200);
      const close = await post(server, '/session/close', { sessionId });
      expect(close.statusCode).toBe(200);
    } finally {
      await server.close();
      registry.dispose();
    }
  });
});
