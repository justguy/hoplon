/**
 * tests/transport/http.strictSemanticEngagement.test.ts — strict-agent
 * engagement gating for the four semantic operations (critical review:
 * "Strict semantic operations bypass engagement/file-policy checks").
 *
 * Proves the data-driven HTTP path treats semanticSearch /
 * indexSemanticCorpus / refreshSemanticOverlay / clearSemanticOverlay
 * exactly like the strict read/search ops: denied without a verified
 * engagement (same typed error + audit row family), allowed with one,
 * folder/file-policy checked where the request carries paths, and
 * byte-identical outside the strict_agent profile.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-semantic-1';
const CORR_ID = 'corr-semantic-1';
const SESSION_ID = 'sess-semantic-1';
const ROOT_TOKEN = 'semantic-root-token';
const FOLDER_TOKEN = 'semantic-src-token';

function putToken(store: EngagementStore, token: string, folder: string): void {
  store.put(token, {
    projectId: PROJECT_ID,
    folder,
    access: 'read_only',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-27T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: `${token}-nonce`,
  });
}

function engagement(token: string, folder: string) {
  return { token, folder, principalId: 'agent-a' };
}

interface SemanticSpies {
  semanticSearch: ReturnType<typeof vi.fn>;
  indexSemanticCorpus: ReturnType<typeof vi.fn>;
  refreshSemanticOverlay: ReturnType<typeof vi.fn>;
  clearSemanticOverlay: ReturnType<typeof vi.fn>;
}

function makeSemanticSpies(): SemanticSpies {
  return {
    semanticSearch: vi.fn(async () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      advisory: true,
      status: 'EMPTY',
      providerStatus: 'EMPTY',
      providerAvailable: true,
      resultCount: 0,
      freshness: 'indexed',
      degradationReasons: [],
      topK: 5,
      matches: [],
    })),
    indexSemanticCorpus: vi.fn(async () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      status: 'AVAILABLE',
      providerStatus: 'AVAILABLE',
      providerAvailable: true,
      resultCount: 1,
      freshness: 'indexed',
      degradationReasons: [],
      indexedCount: 1,
      requestedCount: 1,
    })),
    refreshSemanticOverlay: vi.fn(async () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      status: 'EMPTY',
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      overlayGeneration: 1,
      published: true,
      retainedPreviousOverlay: false,
      touchedFileCount: 1,
      documentCount: 0,
      lexicalCount: 0,
      vectorCount: 0,
      maskCount: 1,
      degradationReasons: [],
    })),
    clearSemanticOverlay: vi.fn(async () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      cleared: true,
    })),
  };
}

/** Baseline (pre-strict-context) request body per semantic method. */
function baseBody(method: string): Record<string, unknown> {
  if (method === 'semanticSearch') {
    return {
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      query: 'auth flow',
      topK: 5,
    };
  }
  if (method === 'indexSemanticCorpus') {
    return {
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      documents: [{ id: 'doc-1', text: 'export const a = 1;' }],
    };
  }
  if (method === 'refreshSemanticOverlay') {
    return {
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      touchedFiles: ['src/foo.ts'],
    };
  }
  return {
    correlationId: CORR_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
  };
}

const SEMANTIC_METHODS = [
  'semanticSearch',
  'indexSemanticCorpus',
  'refreshSemanticOverlay',
  'clearSemanticOverlay',
] as const;

function spyFor(spies: SemanticSpies, method: string): ReturnType<typeof vi.fn> {
  return spies[method as keyof SemanticSpies];
}

interface StrictServer {
  server: FastifyInstance;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  spies: SemanticSpies;
  dispose: () => Promise<void>;
}

async function buildStrictServer(): Promise<StrictServer> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const spies = makeSemanticSpies();
  const engine = makeMockEngine(spies as unknown as Partial<HoplonEngine>);
  const server = await createHoplonHttpServer({
    engine,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-test' }),
  });
  return {
    server,
    store,
    engagementStore,
    spies,
    dispose: async () => {
      await server.close();
    },
  };
}

async function rows(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

describe('HTTP strict-agent semantic engagement gate', () => {
  it('keeps default-profile semantic dispatch unchanged without strict fields', async () => {
    const spies = makeSemanticSpies();
    const engine = makeMockEngine(spies as unknown as Partial<HoplonEngine>);
    const server = await createHoplonHttpServer({ engine });
    try {
      for (const method of SEMANTIC_METHODS) {
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: baseBody(method),
        });
        expect(response.statusCode).toBe(200);
        expect(spyFor(spies, method)).toHaveBeenCalledOnce();
      }
    } finally {
      await server.close();
    }
  });

  it('accepts the additive runId/engagement fields as inert in default profile', async () => {
    const spies = makeSemanticSpies();
    const engine = makeMockEngine(spies as unknown as Partial<HoplonEngine>);
    const server = await createHoplonHttpServer({ engine });
    try {
      for (const method of SEMANTIC_METHODS) {
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: {
            ...baseBody(method),
            runId: RUN_ID,
            engagement: engagement('unknown-token', ''),
          },
        });
        // No strict gate in the default profile: the new optional fields
        // must not change dispatch (the token is never verified).
        expect(response.statusCode).toBe(200);
        expect(spyFor(spies, method)).toHaveBeenCalledOnce();
      }
    } finally {
      await server.close();
    }
  });

  it('blocks each strict semantic op without engagement before engine dispatch', async () => {
    const { server, store, spies, dispose } = await buildStrictServer();
    try {
      for (const method of SEMANTIC_METHODS) {
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: { ...baseBody(method), runId: RUN_ID },
        });
        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body)).toMatchObject({
          error: {
            class: 'StrictEngagementError',
            kind: 'engagement_missing_or_revoked',
            correlationId: CORR_ID,
          },
        });
        expect(spyFor(spies, method)).not.toHaveBeenCalled();
      }

      const auditRows = await rows(store);
      expect(auditRows).toHaveLength(SEMANTIC_METHODS.length);
      for (const row of auditRows) {
        expect(row.operation).toBe('POLICY_ACCESS_CHECK');
        expect(row.result).toBe('REAUTH_REQUIRED');
        expect(row.policyEvent?.reasonCode).toBe('access_missing_token');
      }
      expect(auditRows.map((row) => row.policyEvent?.requestedAction)).toEqual([
        'search',
        'read',
        'read',
        'read',
      ]);
    } finally {
      await dispose();
    }
  });

  it('fails closed when a strict semantic op omits the strict context entirely', async () => {
    const { server, spies, dispose } = await buildStrictServer();
    try {
      for (const method of SEMANTIC_METHODS) {
        // No runId and no engagement — the schema alone would accept this
        // (both fields are optional for default-profile compatibility), so
        // the strict wrapper must deny instead of dispatching ungated.
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: baseBody(method),
        });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({
          error: {
            class: 'StrictEngagementError',
            kind: 'engagement_invalid_context',
            correlationId: CORR_ID,
          },
        });
        expect(spyFor(spies, method)).not.toHaveBeenCalled();
      }
    } finally {
      await dispose();
    }
  });

  it('allows each strict semantic op with a verified root engagement', async () => {
    const { server, store, engagementStore, spies, dispose } = await buildStrictServer();
    putToken(engagementStore, ROOT_TOKEN, '');
    try {
      for (const method of SEMANTIC_METHODS) {
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: {
            ...baseBody(method),
            runId: RUN_ID,
            engagement: engagement(ROOT_TOKEN, ''),
          },
        });
        expect(response.statusCode).toBe(200);
        expect(spyFor(spies, method)).toHaveBeenCalledOnce();
      }

      const auditRows = await rows(store);
      expect(auditRows).toHaveLength(SEMANTIC_METHODS.length);
      for (const row of auditRows) {
        expect(row.operation).toBe('POLICY_ACCESS_CHECK');
        expect(row.result).toBe('GRANTED');
        expect(row.policyEvent?.reasonCode).toBe('access_granted');
      }
    } finally {
      await dispose();
    }
  });

  it('denies corpus-wide semantic ops for folder-scoped engagements', async () => {
    const { server, engagementStore, spies, dispose } = await buildStrictServer();
    putToken(engagementStore, FOLDER_TOKEN, 'src');
    try {
      // semanticSearch / indexSemanticCorpus / clearSemanticOverlay are
      // whole-project scans — a folder-scoped engagement must not reach
      // beyond its folder (same rule as describeProject).
      for (const method of ['semanticSearch', 'indexSemanticCorpus', 'clearSemanticOverlay']) {
        const response = await server.inject({
          method: 'POST',
          url: `/${method}`,
          payload: {
            ...baseBody(method),
            runId: RUN_ID,
            engagement: engagement(FOLDER_TOKEN, 'src'),
          },
        });
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body)).toMatchObject({
          error: {
            class: 'SeeCodebaseFilePolicyError',
            kind: 'strict_file_policy',
          },
        });
        expect(spyFor(spies, method)).not.toHaveBeenCalled();
      }
    } finally {
      await dispose();
    }
  });

  it('applies folder containment and file classes to overlay touched files', async () => {
    const { server, engagementStore, spies, dispose } = await buildStrictServer();
    putToken(engagementStore, FOLDER_TOKEN, 'src');
    putToken(engagementStore, ROOT_TOKEN, '');
    try {
      const inFolder = await server.inject({
        method: 'POST',
        url: '/refreshSemanticOverlay',
        payload: {
          ...baseBody('refreshSemanticOverlay'),
          runId: RUN_ID,
          engagement: engagement(FOLDER_TOKEN, 'src'),
        },
      });
      expect(inFolder.statusCode).toBe(200);
      expect(spies.refreshSemanticOverlay).toHaveBeenCalledOnce();

      const outOfFolder = await server.inject({
        method: 'POST',
        url: '/refreshSemanticOverlay',
        payload: {
          ...baseBody('refreshSemanticOverlay'),
          touchedFiles: ['test/other.ts'],
          runId: RUN_ID,
          engagement: engagement(FOLDER_TOKEN, 'src'),
        },
      });
      expect(outOfFolder.statusCode).toBe(403);
      expect(JSON.parse(outOfFolder.body).error.kind).toBe('strict_file_policy');
      expect(spies.refreshSemanticOverlay).toHaveBeenCalledOnce();

      const envFile = await server.inject({
        method: 'POST',
        url: '/refreshSemanticOverlay',
        payload: {
          ...baseBody('refreshSemanticOverlay'),
          touchedFiles: ['.env'],
          runId: RUN_ID,
          engagement: engagement(ROOT_TOKEN, ''),
        },
      });
      expect(envFile.statusCode).toBe(403);
      expect(JSON.parse(envFile.body).error.kind).toBe('strict_file_policy');
      expect(spies.refreshSemanticOverlay).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });
});
