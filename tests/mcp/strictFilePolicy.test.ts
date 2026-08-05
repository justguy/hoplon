import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { makeMockEngine } from '../session/helpers.js';

const PROJECT_ID = 'proj-session';
const RUN_ID = 'run-session-1';
const CORR_ID = 'corr-session-1';
const FOLDER = 'src';
const READ_TOKEN = 'mcp-read-token-t085';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface StrictMcp {
  client: Client;
  server: Server;
  engagementStore: EngagementStore;
  searchSymbols: ReturnType<typeof vi.fn>;
  describeProject: ReturnType<typeof vi.fn>;
  getRelevantTests: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

async function buildStrictMcp(): Promise<StrictMcp> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
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
  const getRelevantTests = vi.fn(async () => ({
    relevantTests: [],
    coverageConfidence: 'exact',
    unusedModifiedFiles: [],
  }));
  const engine = makeMockEngine({
    searchSymbols,
    describeProject,
    getRelevantTests,
  } as Partial<HoplonEngine>);
  const server = createHoplonMcpServer({
    engine,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'mcp-test' }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'strict-policy-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    server,
    engagementStore,
    searchSymbols,
    describeProject,
    getRelevantTests,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

function putReadToken(store: EngagementStore): void {
  store.put(READ_TOKEN, {
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_only',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-27T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: `${READ_TOKEN}-nonce`,
  });
}

function parseTool(res: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const tool = res as ToolResponse;
  return {
    isError: tool.isError,
    body: JSON.parse(tool.content[0]!.text) as Record<string, unknown>,
  };
}

describe('MCP strict-agent file policy (t-085)', () => {
  it('requires explicit in-folder files for scoped symbol search', async () => {
    const { client, engagementStore, searchSymbols, dispose } = await buildStrictMcp();
    putReadToken(engagementStore);
    const engagement = { token: READ_TOKEN, folder: FOLDER, principalId: 'agent-a' };
    try {
      const unbounded = parseTool(
        await client.callTool({
          name: 'search_symbols',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            namePattern: 'foo',
            engagement,
          },
        }),
      );
      expect(unbounded.isError).toBe(true);
      expect(unbounded.body.kind).toBe('strict_file_policy');
      expect(searchSymbols).not.toHaveBeenCalled();

      const bounded = parseTool(
        await client.callTool({
          name: 'search_symbols',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            namePattern: 'foo',
            files: ['src/foo.ts'],
            engagement,
          },
        }),
      );
      expect(bounded.isError).toBeFalsy();
      expect(searchSymbols).toHaveBeenCalledOnce();
    } finally {
      await dispose();
    }
  });

  it('blocks scoped project orientation and test-oracle scans before dispatch', async () => {
    const {
      client,
      engagementStore,
      describeProject,
      getRelevantTests,
      dispose,
    } = await buildStrictMcp();
    putReadToken(engagementStore);
    const engagement = { token: READ_TOKEN, folder: FOLDER, principalId: 'agent-a' };
    try {
      const describe = parseTool(
        await client.callTool({
          name: 'describe_project',
          arguments: { projectId: PROJECT_ID, runId: RUN_ID, correlationId: CORR_ID, engagement },
        }),
      );
      expect(describe.isError).toBe(true);
      expect(describe.body.kind).toBe('strict_file_policy');
      expect(describeProject).not.toHaveBeenCalled();

      const tests = parseTool(
        await client.callTool({
          name: 'get_relevant_tests',
          arguments: {
            projectId: PROJECT_ID,
            runId: RUN_ID,
            correlationId: CORR_ID,
            modifiedFiles: ['src/foo.ts'],
            engagement,
          },
        }),
      );
      expect(tests.isError).toBe(true);
      expect(tests.body.kind).toBe('strict_file_policy');
      expect(getRelevantTests).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });
});
