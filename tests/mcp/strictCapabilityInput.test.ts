/**
 * tests/mcp/strictCapabilityInput.test.ts — t-170 proof that MCP strict
 * tools enforce explicit capability operation specs when the host opts in.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { createNoopPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import type { CapabilityGateDeps } from '../../src/hoplon/transport/capabilityEngagementGate.js';
import { makeMockEngine } from '../session/helpers.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const FUTURE = new Date('2099-05-04T12:00:00.000Z');
const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const FOLDER = 'src';
const TOKEN = 'opaque-capability-token-t170-mcp';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface StrictMcp {
  client: Client;
  server: Server;
  engagementStore: EngagementStore;
  claimsStore: CapabilityClaimsStore;
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
    nonce: 'nonce-t170-mcp',
  });
}

function seedClaims(
  store: CapabilityClaimsStore,
  astNodeIds?: readonly string[],
): void {
  const token: CapabilityEngagementToken = Object.freeze({
    token: TOKEN,
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    tokenId: 'token-id-t170-mcp',
    subject: 'agent-a',
    sessionId: 'session-t170',
    capabilities: {
      read: {
        paths: ['src/**'],
        branches: ['main'],
        ...(astNodeIds !== undefined ? { astNodeIds: [...astNodeIds] } : {}),
      },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'decision-t170-mcp',
      policyVersion: 'v1',
    },
  });
  store.put(TOKEN, token);
}

function enforceCapabilityGate(
  claimsStore: CapabilityClaimsStore,
  resolveBranch?: CapabilityGateDeps['resolveBranch'],
): CapabilityGateDeps {
  return {
    claimsStore,
    mode: 'enforce',
    clock: () => NOW,
    ...(resolveBranch !== undefined ? { resolveBranch } : {}),
  };
}

async function buildStrictMcp(
  opts: {
    enforceCapability?: boolean;
    astNodeIds?: readonly string[];
    resolveBranch?: CapabilityGateDeps['resolveBranch'];
  } = {},
): Promise<StrictMcp> {
  const engagementStore = createInMemoryEngagementStore();
  const claimsStore = createInMemoryCapabilityClaimsStore();
  seedEngagement(engagementStore);
  seedClaims(claimsStore, opts.astNodeIds);
  const seeCodebase = vi.fn(async () => ({ ok: true, data: { results: [] } }));
  const engine = makeMockEngine({ seeCodebase } as Partial<HoplonEngine>);
  const server = createHoplonMcpServer({
    engine,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createNoopPolicyAuditSink(),
    ...(opts.enforceCapability
      ? {
          capabilityGate: enforceCapabilityGate(
            claimsStore,
            opts.resolveBranch,
          ),
        }
      : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'strict-capability-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    server,
    engagementStore,
    claimsStore,
    seeCodebase,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

function readArgs(): Record<string, unknown> {
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

function parseTool(res: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const tool = res as ToolResponse;
  return {
    isError: tool.isError,
    body: JSON.parse(tool.content[0]!.text) as Record<string, unknown>,
  };
}

describe('MCP strict capability operation specs (t-170)', () => {
  it('allows branch/AST-constrained tokens from server and dispatch target facts', async () => {
    const { client, seeCodebase, dispose } = await buildStrictMcp({
      enforceCapability: true,
      astNodeIds: ['node-foo'],
      resolveBranch: () => 'main',
    });
    try {
      const allowed = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: {
            ...readArgs(),
            targets: [
              {
                kind: 'ast_node',
                file: 'src/foo.ts',
                selector: { kind: 'symbol', name: 'foo' },
                expectedIdentity: { stableId: 'node-foo' },
              },
            ],
          },
        }),
      );
      expect(allowed.isError).not.toBe(true);
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });

  it('enforces derived capability facts regardless of the supplied spec', async () => {
    const { client, seeCodebase, dispose } = await buildStrictMcp({
      enforceCapability: true,
    });
    try {
      const denied = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: {
            ...readArgs(),
            capability: {
              key: 'read',
              branch: 'feature/x',
              path: 'src/foo.ts',
            },
          },
        }),
      );

      // hcr-004 finding 5: the caller-described branch is never load-bearing.
      // Enforcement runs over server-derived facts (no derivable branch), so
      // the branch-constrained token fails closed with a typed reauth.
      expect(denied.isError).toBe(true);
      expect(denied.body.kind).toBe('reauth_required');
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('fails closed when the host opts in and no capability spec is supplied', async () => {
    const { client, seeCodebase, dispose } = await buildStrictMcp({
      enforceCapability: true,
    });
    try {
      const denied = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: readArgs(),
        }),
      );

      // hcr-004 finding 5: omitting the capability object must not bypass
      // enforce mode — the derived facts are checked and the constrained
      // token is denied with a typed reason.
      expect(denied.isError).toBe(true);
      expect(denied.body.kind).toBe('reauth_required');
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });
});
