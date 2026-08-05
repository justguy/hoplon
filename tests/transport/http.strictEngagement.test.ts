import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type {
  SeeCodebaseEnvelope,
  SeeCodebaseRequest,
} from '../../src/hoplon/contracts/seeCodebase.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { MANIFEST, makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const FOLDER = 'src';
const READ_TOKEN = 'read-token-t096';
const WRITE_TOKEN = 'write-token-t096';

function putToken(
  store: EngagementStore,
  token: string,
  access: 'read_only' | 'read_write',
): void {
  store.put(token, {
    projectId: PROJECT_ID,
    folder: FOLDER,
    access,
    principalId: 'agent-a',
    issuedAtIso: '2026-04-27T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: `${token}-nonce`,
  });
}

function seeEnvelope(): SeeCodebaseEnvelope {
  return {
    ok: true,
    data: { results: [] },
    provenance: {
      selectedPath: 'raw',
      routingReason: 'test',
      routingFactors: {
        intent: 'read_exact_text',
        fileKindSupport: 'not_applicable',
        modeRequested: 'raw',
        strict: false,
      },
      primitivesUsed: [],
      fallbackOccurred: false,
      fallbackBlockedByStrict: false,
      truncated: false,
      metrics: { latencyMs: 1, bytesReturned: 0 },
      correlationId: CORR_ID,
      engineId: 'mock-engine',
    },
  };
}

interface StrictServer {
  server: FastifyInstance;
  registry: SessionRegistry;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  seeCodebase: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

async function buildStrictServer(): Promise<StrictServer> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const seeCodebase = vi.fn(async () => seeEnvelope());
  const engine = makeMockEngine({
    seeCodebase,
  } as Partial<HoplonEngine>);
  const registry = createSessionRegistry({ engine });
  const server = await createHoplonHttpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-test' }),
  });
  return {
    server,
    registry,
    store,
    engagementStore,
    seeCodebase,
    dispose: async () => {
      await server.close();
      registry.dispose();
    },
  };
}

function readRequest(intent: SeeCodebaseRequest['intent']): SeeCodebaseRequest {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    correlationId: CORR_ID,
    intent,
    targets: [{ kind: 'file', path: 'src/foo.ts' }],
    mode: 'raw',
  };
}

async function rows(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

describe('HTTP strict-agent engagement gate (t-096)', () => {
  it('keeps compatibility /seeCodebase dispatch unchanged outside strict_agent', async () => {
    const seeCodebase = vi.fn(async () => seeEnvelope());
    const engine = makeMockEngine({ seeCodebase } as Partial<HoplonEngine>);
    const server = await createHoplonHttpServer({ engine });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest('read_exact_text'),
      });
      expect(response.statusCode).toBe(200);
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('blocks strict read requests without engagement before engine dispatch', async () => {
    const { server, store, seeCodebase, dispose } = await buildStrictServer();
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest('read_exact_text'),
      });
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        error: {
          class: 'StrictEngagementError',
          kind: 'engagement_missing_or_revoked',
          correlationId: CORR_ID,
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();

      const auditRows = await rows(store);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.operation).toBe('POLICY_ACCESS_CHECK');
      expect(auditRows[0]?.result).toBe('REAUTH_REQUIRED');
      expect(auditRows[0]?.policyEvent?.reasonCode).toBe('access_missing_token');
      expect(auditRows[0]?.policyEvent?.requestedAction).toBe('read');
    } finally {
      await dispose();
    }
  });

  it('fails closed when strict engagement infrastructure is unavailable', async () => {
    const seeCodebase = vi.fn(async () => seeEnvelope());
    const engine = makeMockEngine({ seeCodebase } as Partial<HoplonEngine>);
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({
      engine,
      sessionRegistry: registry,
      agentToolProfile: 'strict_agent',
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest('read_exact_text'),
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: {
          class: 'StrictEngagementError',
          kind: 'engagement_gate_unavailable',
          correlationId: CORR_ID,
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('allows strict search requests with a matching engagement token', async () => {
    const { server, store, engagementStore, seeCodebase, dispose } =
      await buildStrictServer();
    putToken(engagementStore, READ_TOKEN, 'read_only');
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: {
          ...readRequest('search_exact_text'),
          engagement: {
            token: READ_TOKEN,
            folder: FOLDER,
            principalId: 'agent-a',
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(seeCodebase).toHaveBeenCalledOnce();

      const auditRows = await rows(store);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.operation).toBe('POLICY_ACCESS_CHECK');
      expect(auditRows[0]?.result).toBe('GRANTED');
      expect(auditRows[0]?.policyEvent?.reasonCode).toBe('access_granted');
      expect(auditRows[0]?.policyEvent?.requestedAction).toBe('search');
      expect(auditRows[0]?.policyEvent?.folder).toBe(FOLDER);
    } finally {
      await dispose();
    }
  });

  it('requires read_write engagement before strict edit-session start', async () => {
    const { server, store, engagementStore, registry, dispose } =
      await buildStrictServer();
    putToken(engagementStore, READ_TOKEN, 'read_only');
    putToken(engagementStore, WRITE_TOKEN, 'read_write');
    try {
      const missing = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: { manifest: MANIFEST },
      });
      expect(missing.statusCode).toBe(401);
      expect(JSON.parse(missing.body).error.kind).toBe('engagement_missing_or_revoked');
      expect(registry.list()).toHaveLength(0);

      const readOnly = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: {
          manifest: MANIFEST,
          engagement: {
            token: READ_TOKEN,
            folder: FOLDER,
            principalId: 'agent-a',
          },
        },
      });
      expect(readOnly.statusCode).toBe(403);
      expect(JSON.parse(readOnly.body).error.kind).toBe(
        'engagement_scope_mismatch_access',
      );
      expect(registry.list()).toHaveLength(0);

      const allowed = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: {
          manifest: MANIFEST,
          engagement: {
            token: WRITE_TOKEN,
            folder: FOLDER,
            principalId: 'agent-a',
          },
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(registry.list()).toHaveLength(1);
      const sessionId = (JSON.parse(allowed.body) as {
        session: { sessionId: string };
      }).session.sessionId;

      const closeWithoutToken = await server.inject({
        method: 'POST',
        url: '/session/close',
        payload: { sessionId },
      });
      expect(closeWithoutToken.statusCode).toBe(401);
      expect(registry.list()).toHaveLength(1);

      const closeWithToken = await server.inject({
        method: 'POST',
        url: '/session/close',
        payload: {
          sessionId,
          engagement: {
            token: WRITE_TOKEN,
            folder: FOLDER,
            principalId: 'agent-a',
          },
        },
      });
      expect(closeWithToken.statusCode).toBe(200);
      expect(registry.list()).toHaveLength(0);

      const auditRows = await rows(store);
      expect(auditRows.map((row) => row.policyEvent?.reasonCode)).toEqual([
        'access_missing_token',
        'access_scope_mismatch_access',
        'access_granted',
        'access_missing_token',
        'access_granted',
      ]);
      expect(auditRows.map((row) => row.policyEvent?.requestedAction)).toEqual([
        'edit',
        'edit',
        'edit',
        'edit',
        'edit',
      ]);
    } finally {
      await dispose();
    }
  });
});
