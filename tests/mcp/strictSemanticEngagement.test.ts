/**
 * tests/mcp/strictSemanticEngagement.test.ts — strict-agent engagement
 * gating for the four semantic MCP tools (critical review: "Strict
 * semantic operations bypass engagement/file-policy checks").
 *
 * Covers the MCP-specific handler path: semantic_search /
 * index_semantic_corpus / refresh_semantic_overlay / clear_semantic_overlay
 * are denied without a verified engagement (same typed error + audit row
 * family as strict reads), allowed with one, and unchanged in the default
 * profile. HTTP has separate route proof in
 * tests/transport/http.strictSemanticEngagement.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-semantic-mcp-1';
const CORR_ID = 'corr-semantic-mcp-1';
const SESSION_ID = 'sess-semantic-mcp-1';
const ROOT_TOKEN = 'mcp-semantic-root-token';
const FOLDER_TOKEN = 'mcp-semantic-src-token';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
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

/** MCP tool name → baseline arguments (no strict context). */
const SEMANTIC_TOOLS: ReadonlyArray<{
  tool: string;
  spy: keyof SemanticSpies;
  args: () => Record<string, unknown>;
}> = [
  {
    tool: 'semantic_search',
    spy: 'semanticSearch',
    args: () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      query: 'auth flow',
      topK: 5,
    }),
  },
  {
    tool: 'index_semantic_corpus',
    spy: 'indexSemanticCorpus',
    args: () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      documents: [{ id: 'doc-1', text: 'export const a = 1;' }],
    }),
  },
  {
    tool: 'refresh_semantic_overlay',
    spy: 'refreshSemanticOverlay',
    args: () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      mode: 'dry_run',
      inputSource: 'proposed_changes',
      touchedFiles: ['src/foo.ts'],
    }),
  },
  {
    tool: 'clear_semantic_overlay',
    spy: 'clearSemanticOverlay',
    args: () => ({
      correlationId: CORR_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    }),
  },
];

function engagement(token: string, folder: string) {
  return { token, folder, principalId: 'agent-a' };
}

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

function parseTool(res: unknown): {
  isError: boolean | undefined;
  body: Record<string, unknown>;
} {
  const tool = res as ToolResponse;
  return {
    isError: tool.isError,
    body: JSON.parse(tool.content[0]!.text) as Record<string, unknown>,
  };
}

interface McpHarness {
  client: Client;
  server: Server;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  spies: SemanticSpies;
  dispose: () => Promise<void>;
}

async function buildMcp(profile: 'default' | 'strict_agent'): Promise<McpHarness> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const spies = makeSemanticSpies();
  const engine = makeMockEngine(spies as unknown as Partial<HoplonEngine>);
  const server = createHoplonMcpServer({
    engine,
    ...(profile === 'strict_agent'
      ? {
          agentToolProfile: profile,
          engagementStore,
          policyAuditSink: createPolicyAuditSink({ store, engineId: 'mcp-test' }),
        }
      : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'strict-semantic-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    server,
    store,
    engagementStore,
    spies,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function rows(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

describe('MCP strict-agent semantic engagement gate', () => {
  it('keeps default-profile semantic tools unchanged and treats new fields as inert', async () => {
    const { client, spies, dispose } = await buildMcp('default');
    try {
      for (const { tool, spy, args } of SEMANTIC_TOOLS) {
        const plain = parseTool(await client.callTool({ name: tool, arguments: args() }));
        expect(plain.isError).toBeFalsy();
        expect(spies[spy]).toHaveBeenCalledTimes(1);

        // Additive optional fields are accepted and inert without the gate.
        const withFields = parseTool(
          await client.callTool({
            name: tool,
            arguments: {
              ...args(),
              runId: RUN_ID,
              engagement: engagement('unknown-token', ''),
            },
          }),
        );
        expect(withFields.isError).toBeFalsy();
        expect(spies[spy]).toHaveBeenCalledTimes(2);
      }
    } finally {
      await dispose();
    }
  });

  it('blocks each strict semantic tool without engagement before engine dispatch', async () => {
    const { client, store, spies, dispose } = await buildMcp('strict_agent');
    try {
      for (const { tool, spy, args } of SEMANTIC_TOOLS) {
        const blocked = parseTool(
          await client.callTool({
            name: tool,
            arguments: { ...args(), runId: RUN_ID },
          }),
        );
        expect(blocked.isError).toBe(true);
        expect(blocked.body.kind).toBe('engagement_missing_or_revoked');
        expect(spies[spy]).not.toHaveBeenCalled();
      }

      const auditRows = await rows(store);
      expect(auditRows.map((row) => row.policyEvent?.reasonCode)).toEqual([
        'access_missing_token',
        'access_missing_token',
        'access_missing_token',
        'access_missing_token',
      ]);
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

  it('fails closed when a strict semantic tool omits the strict context entirely', async () => {
    const { client, spies, dispose } = await buildMcp('strict_agent');
    try {
      for (const { tool, spy, args } of SEMANTIC_TOOLS) {
        // No runId and no engagement — schema-valid for default-profile
        // compatibility, so the strict wrapper must deny instead of
        // dispatching ungated.
        const denied = parseTool(await client.callTool({ name: tool, arguments: args() }));
        expect(denied.isError).toBe(true);
        expect(denied.body.kind).toBe('engagement_invalid_context');
        expect(spies[spy]).not.toHaveBeenCalled();
      }
    } finally {
      await dispose();
    }
  });

  it('allows each strict semantic tool with a verified root engagement', async () => {
    const { client, store, engagementStore, spies, dispose } = await buildMcp('strict_agent');
    putToken(engagementStore, ROOT_TOKEN, '');
    try {
      for (const { tool, spy, args } of SEMANTIC_TOOLS) {
        const allowed = parseTool(
          await client.callTool({
            name: tool,
            arguments: {
              ...args(),
              runId: RUN_ID,
              engagement: engagement(ROOT_TOKEN, ''),
            },
          }),
        );
        expect(allowed.isError).toBeFalsy();
        expect(spies[spy]).toHaveBeenCalledOnce();
      }

      const auditRows = await rows(store);
      expect(auditRows.map((row) => row.policyEvent?.reasonCode)).toEqual([
        'access_granted',
        'access_granted',
        'access_granted',
        'access_granted',
      ]);
    } finally {
      await dispose();
    }
  });

  it('applies strict file policy to overlay touched files and corpus-wide scans', async () => {
    const { client, engagementStore, spies, dispose } = await buildMcp('strict_agent');
    putToken(engagementStore, FOLDER_TOKEN, 'src');
    try {
      // Folder-scoped engagement cannot run a corpus-wide semantic search.
      const scan = parseTool(
        await client.callTool({
          name: 'semantic_search',
          arguments: {
            ...SEMANTIC_TOOLS[0]!.args(),
            runId: RUN_ID,
            engagement: engagement(FOLDER_TOKEN, 'src'),
          },
        }),
      );
      expect(scan.isError).toBe(true);
      expect(scan.body.kind).toBe('strict_file_policy');
      expect(spies.semanticSearch).not.toHaveBeenCalled();

      // Overlay refresh is allowed inside the engagement folder…
      const inFolder = parseTool(
        await client.callTool({
          name: 'refresh_semantic_overlay',
          arguments: {
            ...SEMANTIC_TOOLS[2]!.args(),
            runId: RUN_ID,
            engagement: engagement(FOLDER_TOKEN, 'src'),
          },
        }),
      );
      expect(inFolder.isError).toBeFalsy();
      expect(spies.refreshSemanticOverlay).toHaveBeenCalledOnce();

      // …and denied for touched files outside it.
      const outOfFolder = parseTool(
        await client.callTool({
          name: 'refresh_semantic_overlay',
          arguments: {
            ...SEMANTIC_TOOLS[2]!.args(),
            touchedFiles: ['test/other.ts'],
            runId: RUN_ID,
            engagement: engagement(FOLDER_TOKEN, 'src'),
          },
        }),
      );
      expect(outOfFolder.isError).toBe(true);
      expect(outOfFolder.body.kind).toBe('strict_file_policy');
      expect(spies.refreshSemanticOverlay).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });
});
