/**
 * tests/mcp/strictEngagementGate.test.ts — t-096 MCP strict-agent proof.
 *
 * Covers the MCP-specific handler path for strict read and edit-session
 * entry points. HTTP has separate route proof; this file keeps the MCP
 * wrapper from silently drifting to helper-only coverage.
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
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import type { SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { MANIFEST, makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const FOLDER = 'src';
const WRITE_TOKEN = 'mcp-write-token-t096';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface StrictMcp {
  client: Client;
  server: Server;
  registry: SessionRegistry;
  store: SnapshotStore;
  engagementStore: EngagementStore;
  seeCodebase: ReturnType<typeof vi.fn>;
  findSyntaxNode: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

async function buildStrictMcp(): Promise<StrictMcp> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const seeCodebase = vi.fn(async () => ({ ok: true, data: { results: [] } }));
  const findSyntaxNode = vi.fn(async () => ({
    correlationId: CORR_ID,
    advisory: true,
    status: 'FOUND',
    file: 'src/foo.ts',
    node: null,
    ancestors: [],
    parserStatus: {
      advisory: true,
      status: 'OK',
      language: 'typescript',
      grammarVersion: '15',
      hasError: false,
      errorNodes: [],
      missingNodes: [],
      degradationReason: null,
    },
    failureReason: null,
  }));
  const engine = makeMockEngine({
    seeCodebase,
    findSyntaxNode,
  } as Partial<HoplonEngine>);
  const registry = createSessionRegistry({ engine });
  const server = createHoplonMcpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'mcp-test' }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'strict-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    server,
    registry,
    store,
    engagementStore,
    seeCodebase,
    findSyntaxNode,
    dispose: async () => {
      await client.close();
      await server.close();
      registry.dispose();
    },
  };
}

function putWriteToken(store: EngagementStore, folder = FOLDER): void {
  store.put(WRITE_TOKEN, {
    projectId: PROJECT_ID,
    folder,
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-27T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: 'mcp-write-token-nonce',
  });
}

async function rows(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

function parseTool(res: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const tool = res as ToolResponse;
  return {
    isError: tool.isError,
    body: JSON.parse(tool.content[0]!.text) as Record<string, unknown>,
  };
}

describe('MCP strict-agent engagement gate (t-096)', () => {
  it('blocks strict read before engine dispatch and allows token-scoped edit start', async () => {
    const { client, store, engagementStore, seeCodebase, registry, dispose } =
      await buildStrictMcp();
    putWriteToken(engagementStore);
    try {
      const blockedRead = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            intent: 'read_exact_text',
            targets: [{ kind: 'file', path: 'src/foo.ts' }],
          },
        }),
      );
      expect(blockedRead.isError).toBe(true);
      expect(blockedRead.body.kind).toBe('engagement_missing_or_revoked');
      expect(seeCodebase).not.toHaveBeenCalled();

      const start = parseTool(
        await client.callTool({
          name: 'start_edit_session',
          arguments: {
            manifest: MANIFEST,
            engagement: {
              token: WRITE_TOKEN,
              folder: FOLDER,
              principalId: 'agent-a',
            },
          },
        }),
      );
      expect(start.isError).toBeFalsy();
      expect(registry.list()).toHaveLength(1);

      const auditRows = await rows(store);
      expect(auditRows.map((row) => row.policyEvent?.reasonCode)).toEqual([
        'access_missing_token',
        'access_granted',
      ]);
      expect(auditRows.map((row) => row.policyEvent?.requestedAction)).toEqual([
        'read',
        'edit',
      ]);
    } finally {
      await dispose();
    }
  });

  it('allows strict code-adjacent reads with a matching engagement token', async () => {
    const { client, engagementStore, seeCodebase, dispose } = await buildStrictMcp();
    putWriteToken(engagementStore, '');
    try {
      const allowed = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            intent: 'read_exact_text',
            targets: [{ kind: 'file', path: 'package.json' }],
            engagement: {
              token: WRITE_TOKEN,
              folder: '',
              principalId: 'agent-a',
            },
          },
        }),
      );
      expect(allowed.isError).toBeFalsy();
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });

  it('fails closed for strict env reads before engine dispatch', async () => {
    const { client, engagementStore, seeCodebase, dispose } = await buildStrictMcp();
    putWriteToken(engagementStore, '');
    try {
      const denied = parseTool(
        await client.callTool({
          name: 'see_codebase',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            intent: 'read_exact_text',
            targets: [{ kind: 'file', path: '.env' }],
            engagement: {
              token: WRITE_TOKEN,
              folder: '',
              principalId: 'agent-a',
            },
          },
        }),
      );
      expect(denied.isError).toBe(true);
      expect(denied.body.kind).toBe('strict_file_policy');
      expect(seeCodebase).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('gates strict syntax-node reads before engine dispatch', async () => {
    const { client, store, engagementStore, findSyntaxNode, dispose } =
      await buildStrictMcp();
    putWriteToken(engagementStore);
    const syntaxArgs = {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: CORR_ID,
      file: 'src/foo.ts',
      target: { type: 'byte_offset', byteOffset: 0 },
    };
    try {
      const blocked = parseTool(
        await client.callTool({ name: 'find_syntax_node', arguments: syntaxArgs }),
      );
      expect(blocked.isError).toBe(true);
      expect(blocked.body.kind).toBe('engagement_missing_or_revoked');
      expect(findSyntaxNode).not.toHaveBeenCalled();

      const allowed = parseTool(
        await client.callTool({
          name: 'find_syntax_node',
          arguments: {
            ...syntaxArgs,
            engagement: { token: WRITE_TOKEN, folder: FOLDER, principalId: 'agent-a' },
          },
        }),
      );
      expect(allowed.isError).toBeFalsy();
      expect(findSyntaxNode).toHaveBeenCalledOnce();

      const outOfScope = parseTool(
        await client.callTool({
          name: 'find_syntax_node',
          arguments: {
            ...syntaxArgs,
            file: 'test/foo.ts',
            engagement: { token: WRITE_TOKEN, folder: FOLDER, principalId: 'agent-a' },
          },
        }),
      );
      expect(outOfScope.isError).toBe(true);
      expect(outOfScope.body.kind).toBe('strict_file_policy');
      expect(findSyntaxNode).toHaveBeenCalledOnce();

      const auditRows = await rows(store);
      expect(auditRows.map((row) => row.policyEvent?.requestedAction)).toEqual([
        'read',
        'read',
        'read',
      ]);
      expect(auditRows.map((row) => row.policyEvent?.reasonCode)).toEqual([
        'access_missing_token',
        'access_granted',
        'access_granted',
      ]);
    } finally {
      await dispose();
    }
  });
});
