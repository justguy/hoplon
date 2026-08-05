/**
 * tests/transport/strictEngagementCapabilityInput.test.ts — t-170 proof
 * that explicit capability operation specs reach strict HTTP/session gates
 * only when a host opts into the capability gate.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import {
  createNoopPolicyAuditSink,
  createPolicyAuditSink,
} from '../../src/hoplon/transport/policyAuditSink.js';
import { StrictEngagementError } from '../../src/hoplon/transport/strictEngagementGate.js';
import { strictEngineCheckFromBody } from '../../src/hoplon/transport/strictEngagementCheck.js';
import type { CapabilityGateDeps } from '../../src/hoplon/transport/capabilityEngagementGate.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { MANIFEST, makeMockEngine } from '../session/helpers.js';
import { STRICT_CAPABILITY_DERIVED_CORPUS } from '../fixtures/strictCapabilityDerivedCorpus.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const FUTURE = new Date('2099-05-04T12:00:00.000Z');
const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const FOLDER = 'src';
const TOKEN = 'opaque-capability-token-t170';

interface StrictServer {
  server: FastifyInstance;
  registry: SessionRegistry;
  engagementStore: EngagementStore;
  claimsStore: CapabilityClaimsStore;
  auditStore: SnapshotStore;
  seeCodebase: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

function seedEngagement(store: EngagementStore): void {
  store.put(TOKEN, {
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    nonce: 'nonce-t170',
  });
}

function seedClaims(
  store: CapabilityClaimsStore,
  opts: {
    wildcard?: boolean;
    astNodeIds?: readonly string[];
    astSelectors?: readonly string[];
  } = {},
): void {
  const scope = opts.wildcard
    ? { paths: ['**'], branches: ['**'] }
    : { paths: ['src/**'], branches: ['main'] };
  const token: CapabilityEngagementToken = Object.freeze({
    token: TOKEN,
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    tokenId: 'token-id-t170',
    subject: 'agent-a',
    sessionId: 'session-t170',
    capabilities: {
      read: {
        ...scope,
        ...(opts.astNodeIds !== undefined ? { astNodeIds: [...opts.astNodeIds] } : {}),
        ...(opts.astSelectors !== undefined
          ? { astSelectors: [...opts.astSelectors] }
          : {}),
      },
      write: { ...scope },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'decision-t170',
      policyVersion: 'v1',
    },
  });
  store.put(TOKEN, token);
}

function readRequest(): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    correlationId: CORR_ID,
    intent: 'read_exact_text',
    targets: [{ kind: 'file', path: 'src/foo.ts' }],
    mode: 'raw',
    engagement: {
      token: TOKEN,
      folder: FOLDER,
      principalId: 'agent-a',
    },
  };
}

async function buildStrictServer(
  opts: {
    enforceCapability?: boolean;
    wildcardClaims?: boolean;
    astNodeIds?: readonly string[];
    astSelectors?: readonly string[];
    resolveBranch?: CapabilityGateDeps['resolveBranch'];
  } = {},
): Promise<StrictServer> {
  const engagementStore = createInMemoryEngagementStore();
  const claimsStore = createInMemoryCapabilityClaimsStore();
  const auditStore = await createIsolatedTestStore();
  seedEngagement(engagementStore);
  seedClaims(claimsStore, {
    wildcard: opts.wildcardClaims === true,
    ...(opts.astNodeIds !== undefined ? { astNodeIds: opts.astNodeIds } : {}),
    ...(opts.astSelectors !== undefined ? { astSelectors: opts.astSelectors } : {}),
  });
  const seeCodebase = vi.fn(async () => ({
    ok: true,
    data: { results: [] },
  }));
  const engine = makeMockEngine({ seeCodebase } as Partial<HoplonEngine>);
  const registry = createSessionRegistry({ engine });
  const capabilityGate = opts.enforceCapability
    ? enforceCapabilityGate(claimsStore, auditStore, opts.resolveBranch)
    : undefined;
  const server = await createHoplonHttpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createNoopPolicyAuditSink(),
    ...(capabilityGate !== undefined ? { capabilityGate } : {}),
  });
  return {
    server,
    registry,
    engagementStore,
    claimsStore,
    auditStore,
    seeCodebase,
    dispose: async () => {
      await server.close();
      registry.dispose();
    },
  };
}

function enforceCapabilityGate(
  claimsStore: CapabilityClaimsStore,
  auditStore: SnapshotStore,
  resolveBranch?: CapabilityGateDeps['resolveBranch'],
): CapabilityGateDeps {
  return {
    claimsStore,
    mode: 'enforce',
    clock: () => NOW,
    ...(resolveBranch !== undefined ? { resolveBranch } : {}),
    auditSink: createPolicyAuditSink({ store: auditStore, engineId: 't170' }),
    auditContext: {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: CORR_ID,
    },
  };
}

describe('strict capability operation specs (t-170)', () => {
  it('parses explicit engine capability specs without leaking into schemas', () => {
    const check = strictEngineCheckFromBody('seeCodebase', {
      ...readRequest(),
      capability: {
        key: 'read',
        branch: 'main',
        path: 'src/foo.ts',
        astNodeIds: ['node-1'],
        astSelectors: ['function:handler'],
        sessionId: 'session-t170',
        taskId: 't-170',
      },
    });

    expect(check?.capability).toEqual({
      key: 'read',
      branch: 'main',
      path: 'src/foo.ts',
      astNodeIds: ['node-1'],
      astSelectors: ['function:handler'],
      sessionId: 'session-t170',
      taskId: 't-170',
    });
  });

  it('rejects malformed supplied capability specs before dispatch', () => {
    expect(() =>
      strictEngineCheckFromBody('seeCodebase', {
        ...readRequest(),
        capability: {
          key: 'read',
          branch: 'main',
          path: 'src/foo.ts',
          astNodeIds: 'node-1',
        },
      }),
    ).toThrow(StrictEngagementError);
  });

  it('HTTP strict engine route never trusts a caller-described branch under enforce', async () => {
    const { server, seeCodebase, dispose } = await buildStrictServer({
      enforceCapability: true,
    });
    try {
      const denied = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: {
          ...readRequest(),
          capability: {
            key: 'read',
            branch: 'feature/x',
            path: 'src/foo.ts',
          },
        },
      });

      // The declared branch is never load-bearing: enforcement runs over the
      // server-derived facts (no derivable branch), so a token constrained to
      // 'main' fails closed with a typed reauth outcome.
      expect(denied.statusCode).toBe(401);
      expect(JSON.parse(denied.body)).toMatchObject({
        error: {
          class: 'CapabilityDeniedError',
          kind: 'reauth_required',
          correlationId: CORR_ID,
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('HTTP strict engine route denies a declared path that mismatches the derived targets', async () => {
    const { server, seeCodebase, dispose } = await buildStrictServer({
      enforceCapability: true,
      wildcardClaims: true,
    });
    try {
      const denied = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: {
          ...readRequest(),
          capability: {
            key: 'read',
            branch: 'main',
            path: 'src/other.ts',
          },
        },
      });

      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body)).toMatchObject({
        error: {
          class: 'CapabilityDeniedError',
          kind: 'policy_denied',
          correlationId: CORR_ID,
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('HTTP strict engine route fails closed when no capability spec is supplied under enforce', async () => {
    const { server, seeCodebase, auditStore, dispose } = await buildStrictServer({
      enforceCapability: true,
    });
    try {
      const denied = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest(),
      });

      expect(denied.statusCode).toBe(401);
      expect(JSON.parse(denied.body)).toMatchObject({
        error: {
          class: 'CapabilityDeniedError',
          kind: 'reauth_required',
          correlationId: CORR_ID,
          // Discoverable fail-closed reason: the branch-scoped token
          // (branches: ['main']) cannot be satisfied because the transport
          // derives no branch and no `resolveBranch` seam is wired. Operators
          // see the typed reason instead of an opaque denial.
          message: expect.stringContaining('missing_branch'),
        },
      });
      expect(seeCodebase).not.toHaveBeenCalled();

      const rows = await auditStore.findAuditLogByProjectAndRun(
        PROJECT_ID,
        RUN_ID,
      );
      const capabilityRows = rows.filter(
        (row) => row.operation === 'POLICY_CAPABILITY_CHECK',
      );
      expect(capabilityRows.length).toBeGreaterThan(0);
      expect(capabilityRows[0]?.result).toBe('REAUTH_REQUIRED');
    } finally {
      await dispose();
    }
  });

  it('HTTP strict engine route allows omitted capability specs only when the token truly permits the derived facts', async () => {
    const { server, seeCodebase, dispose } = await buildStrictServer({
      enforceCapability: true,
      wildcardClaims: true,
    });
    try {
      const allowed = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest(),
      });

      expect(allowed.statusCode).toBe(200);
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });

  it('makes a branch-scoped token usable under enforce when the server resolves the matching branch', async () => {
    // Default (non-wildcard) claims are branch-scoped: branches:['main'],
    // paths:['src/**']. With the server-owned `resolveBranch` seam wired to
    // the real branch, the token is usable — enforcement is honest and
    // server-derived, not caller-asserted. This is the mechanism that keeps
    // operators from disabling enforce to use branch-scoped tokens.
    const resolveBranch = vi.fn(() => 'main');
    const { server, seeCodebase, dispose } = await buildStrictServer({
      enforceCapability: true,
      resolveBranch,
    });
    try {
      const allowed = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: readRequest(),
      });

      expect(allowed.statusCode).toBe(200);
      expect(seeCodebase).toHaveBeenCalledOnce();
      expect(resolveBranch).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        runId: RUN_ID,
      });
    } finally {
      await dispose();
    }
  });

  it('enforces the repo-native server-derived branch/AST allow-deny corpus', async () => {
    for (const testCase of STRICT_CAPABILITY_DERIVED_CORPUS) {
      const resolveBranch = vi.fn(() => testCase.resolvedBranch);
      const { server, seeCodebase, dispose } = await buildStrictServer({
        enforceCapability: true,
        astNodeIds: testCase.claimAstNodeIds,
        astSelectors: testCase.claimAstSelectors,
        resolveBranch,
      });
      try {
        const response = await server.inject({
          method: 'POST',
          url: '/seeCodebase',
          payload: {
            ...readRequest(),
            targets: [testCase.target],
            ...(testCase.declaredCapability !== undefined
              ? { capability: testCase.declaredCapability }
              : {}),
          },
        });
        expect(response.statusCode, testCase.name).toBe(testCase.expectedStatus);
        expect(seeCodebase.mock.calls.length > 0, testCase.name).toBe(
          testCase.shouldDispatch,
        );
        expect(resolveBranch, testCase.name).toHaveBeenCalledWith({
          projectId: PROJECT_ID,
          runId: RUN_ID,
        });
      } finally {
        await dispose();
      }
    }
  });

  it('keeps null and throwing branch resolvers on the existing fail-closed path', async () => {
    const resolvers: Array<NonNullable<CapabilityGateDeps['resolveBranch']>> = [
      () => null,
      () => {
        throw new Error('branch provider unavailable');
      },
    ];
    for (const resolveBranch of resolvers) {
      const { server, seeCodebase, dispose } = await buildStrictServer({
        enforceCapability: true,
        resolveBranch,
      });
      try {
        const denied = await server.inject({
          method: 'POST',
          url: '/seeCodebase',
          payload: readRequest(),
        });
        expect(denied.statusCode).toBe(401);
        expect(seeCodebase).not.toHaveBeenCalled();
      } finally {
        await dispose();
      }
    }
  });

  it('HTTP session start enforces derived write facts regardless of the supplied spec', async () => {
    const { server, registry, dispose } = await buildStrictServer({
      enforceCapability: true,
    });
    try {
      const denied = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: {
          manifest: MANIFEST,
          engagement: {
            token: TOKEN,
            folder: FOLDER,
            principalId: 'agent-a',
          },
          capability: {
            key: 'write',
            branch: 'feature/x',
            path: 'src/foo.ts',
          },
        },
      });

      expect(denied.statusCode).toBe(401);
      expect(JSON.parse(denied.body).error.class).toBe('CapabilityDeniedError');
      expect(registry.list()).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
