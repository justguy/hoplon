import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SeeCodebaseEnvelope, SeeCodebaseRequest } from '../../src/hoplon/contracts/seeCodebase.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const READ_TOKEN = 'read-token-t098';

function seeEnvelope(): SeeCodebaseEnvelope {
  return {
    ok: true,
    data: { results: [] },
    provenance: {
      selectedPath: 'raw',
      routingReason: 'test',
      routingFactors: {
        intent: 'read_exact_text',
        fileKindSupport: 'other_supported',
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
  engagementStore: EngagementStore;
  seeCodebase: ReturnType<typeof vi.fn>;
  searchSymbols: ReturnType<typeof vi.fn>;
  describeProject: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

async function buildStrictServer(): Promise<StrictServer> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const seeCodebase = vi.fn(async () => seeEnvelope());
  const searchSymbols = vi.fn(async () => ({
    matches: [],
    failures: [],
    filesScanned: 0,
    truncated: false,
  }));
  const describeProject = vi.fn(async () => ({
    files: { total: 0, byLanguage: [] },
    symbols: { exports: 0, imports: 0, types: 0, functions: 0, classes: 0 },
    filesScanned: 0,
    truncated: false,
    failures: [],
  }));
  const engine = makeMockEngine({
    seeCodebase,
    searchSymbols,
    describeProject,
  } as Partial<HoplonEngine>);
  const server = await createHoplonHttpServer({
    engine,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'http-test' }),
  });
  return {
    server,
    engagementStore,
    seeCodebase,
    searchSymbols,
    describeProject,
    dispose: async () => {
      await server.close();
    },
  };
}

function putRootReadToken(store: EngagementStore): void {
  putReadToken(store, '');
}

function putScopedReadToken(store: EngagementStore): void {
  putReadToken(store, 'src');
}

function putReadToken(store: EngagementStore, folder: string): void {
  store.put(READ_TOKEN, {
    projectId: PROJECT_ID,
    folder,
    access: 'read_only',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-27T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: `${READ_TOKEN}-nonce`,
  });
}

function requestFor(path: string): SeeCodebaseRequest {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    correlationId: CORR_ID,
    intent: 'read_exact_text',
    targets: [{ kind: 'file', path }],
    mode: 'raw',
    engagement: {
      token: READ_TOKEN,
      folder: '',
      principalId: 'agent-a',
    },
  };
}

describe('HTTP strict-agent file policy (t-098)', () => {
  it('allows approved code-adjacent reads with a matching engagement token', async () => {
    const { server, engagementStore, seeCodebase, dispose } = await buildStrictServer();
    putRootReadToken(engagementStore);
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: requestFor('package.json'),
      });
      expect(response.statusCode).toBe(200);
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });

  it.each([
    ['env file', '.env'],
    ['log file', 'logs/runtime.log'],
    ['binary file', 'assets/logo.png'],
  ])('fails closed for strict %s reads before engine dispatch', async (_label, path) => {
    const { server, engagementStore, seeCodebase, dispose } = await buildStrictServer();
    putRootReadToken(engagementStore);
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: requestFor(path),
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: {
          class: 'SeeCodebaseFilePolicyError',
          kind: 'strict_file_policy',
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('fails closed for non-root strict project scans before engine dispatch', async () => {
    const { server, engagementStore, seeCodebase, describeProject, dispose } =
      await buildStrictServer();
    putScopedReadToken(engagementStore);
    const engagement = { token: READ_TOKEN, folder: 'src', principalId: 'agent-a' };
    try {
      const projectTarget = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
          intent: 'orient_project',
          targets: [{ kind: 'project' }],
          engagement,
        },
      });
      expect(projectTarget.statusCode).toBe(403);
      expect(JSON.parse(projectTarget.body).error.kind).toBe('strict_file_policy');
      expect(seeCodebase).not.toHaveBeenCalled();

      const describe = await server.inject({
        method: 'POST',
        url: '/describeProject',
        payload: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
          engagement,
        },
      });
      expect(describe.statusCode).toBe(403);
      expect(JSON.parse(describe.body).error.kind).toBe('strict_file_policy');
      expect(describeProject).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('requires explicit in-folder files for non-root strict symbol search', async () => {
    const { server, engagementStore, searchSymbols, dispose } =
      await buildStrictServer();
    putScopedReadToken(engagementStore);
    const engagement = { token: READ_TOKEN, folder: 'src', principalId: 'agent-a' };
    try {
      const unbounded = await server.inject({
        method: 'POST',
        url: '/searchSymbols',
        payload: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
          namePattern: 'foo',
          engagement,
        },
      });
      expect(unbounded.statusCode).toBe(403);
      expect(JSON.parse(unbounded.body).error.kind).toBe('strict_file_policy');
      expect(searchSymbols).not.toHaveBeenCalled();

      const bounded = await server.inject({
        method: 'POST',
        url: '/searchSymbols',
        payload: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORR_ID,
          namePattern: 'foo',
          files: ['src/foo.ts'],
          engagement,
        },
      });
      expect(bounded.statusCode).toBe(200);
      expect(searchSymbols).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });
});
