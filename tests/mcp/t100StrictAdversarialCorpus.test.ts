/**
 * t-100 strict-agent adversarial MCP corpus.
 *
 * Exercises the packaged MCP tool surface an agent would actually call.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createSessionRegistry, type SessionRegistry } from '../../src/hoplon/session/registry.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import {
  BLOCK_AUDIT,
  MANIFEST,
  makeMockEngine,
  SNAPSHOT_RESULT,
} from '../session/helpers.js';

const TOKEN = 'strict-mcp-write-token-t100';
const ENGAGEMENT = { token: TOKEN, folder: 'src', principalId: 'agent-a' };
const CHANGE = { file: 'src/foo.ts', content: 'export const value = 2;\n' };

interface StrictMcp {
  readonly client: Client;
  readonly server: Server;
  readonly registry: SessionRegistry;
  readonly store: SnapshotStore;
  readonly engagementStore: EngagementStore;
  readonly createSnapshot: ReturnType<typeof vi.fn>;
  readonly dispose: () => Promise<void>;
}

function putWriteToken(store: EngagementStore): void {
  store.put(TOKEN, {
    projectId: MANIFEST.projectId,
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-04-28T00:00:00.000Z',
    expiresAtIso: '2099-01-01T00:00:00.000Z',
    nonce: 'strict-mcp-write-token-t100-nonce',
  });
}

async function buildStrictMcp(): Promise<StrictMcp> {
  const store = await createIsolatedTestStore();
  const engagementStore = createInMemoryEngagementStore();
  const fs = createMemFsAdapter();
  await fs.write('src/foo.ts', new TextEncoder().encode('export const value = 1;\n'));
  const createSnapshot = vi.fn(async () => SNAPSHOT_RESULT);
  const engine = makeMockEngine({
    createSnapshot,
    auditDiff: async () => BLOCK_AUDIT,
  });
  const registry = createSessionRegistry({ engine, fs });
  const server = createHoplonMcpServer({
    engine,
    sessionRegistry: registry,
    agentToolProfile: 'strict_agent',
    engagementStore,
    policyAuditSink: createPolicyAuditSink({ store, engineId: 'mcp-t100' }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 't100-strict-mcp', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    server,
    registry,
    store,
    engagementStore,
    createSnapshot,
    dispose: async () => {
      await client.close();
      await server.close();
      registry.dispose();
    },
  };
}

function parseTool(res: unknown): {
  readonly isError?: boolean;
  readonly body: Record<string, unknown>;
} {
  const tool = res as { isError?: boolean; content: Array<{ text: string }> };
  return {
    isError: tool.isError,
    body: JSON.parse(tool.content[0]!.text) as Record<string, unknown>,
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return parseTool(await client.callTool({ name, arguments: args }));
}

function withEngagement(sessionId: string): { sessionId: string; engagement: typeof ENGAGEMENT } {
  return { sessionId, engagement: ENGAGEMENT };
}

describe('t-100 strict-agent MCP adversarial corpus', () => {
  it('denies raw primitives and host-write bypass tools before handler dispatch', async () => {
    const { client, createSnapshot, dispose } = await buildStrictMcp();
    try {
      const hiddenTools = [
        'pack_context',
        'query_structure',
        'extract_structural_template',
        'create_snapshot',
        'audit_diff',
        'revert_uncontracted',
        'dry_run',
        'preflight',
        'compute_minimal_patch',
        'session_mark_edited',
        'session_quick_edit',
      ];
      for (const name of hiddenTools) {
        const result = await call(client, name, {
          manifest: MANIFEST,
          editMode: 'markEdited',
          markEditedFiles: ['src/foo.ts'],
        });
        expect(result.isError).toBe(true);
        expect(result.body).toMatchObject({
          error: {
            class: 'StrictAgentFallbackError',
            kind: 'strict_agent_unsupported_tool',
            details: {
              agentFallbackAllowed: false,
              surface: name,
            },
          },
        });
        expect(
          ((result.body.error as { message: string }).message),
        ).not.toMatch(/cat|rg|filesystem|IDE/i);
      }
      expect(createSnapshot).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('runs strict write, review, BLOCK repair, and repair-context packaging without markEdited', async () => {
    const { client, engagementStore, dispose } = await buildStrictMcp();
    putWriteToken(engagementStore);
    try {
      const start = await call(client, 'start_edit_session', {
        manifest: MANIFEST,
        engagement: ENGAGEMENT,
      });
      const sessionId = (start.body.session as { sessionId: string }).sessionId;

      await call(client, 'session_preflight', withEngagement(sessionId));
      await call(client, 'session_create_snapshot', withEngagement(sessionId));
      await call(client, 'session_dry_run', {
        ...withEngagement(sessionId),
        proposedChanges: [CHANGE],
      });
      await call(client, 'session_apply_edits', {
        ...withEngagement(sessionId),
        proposedChanges: [CHANGE],
      });

      const review = await call(client, 'session_review', withEngagement(sessionId));
      const reviewData = (review.body.data as {
        review: { changedFiles: string[]; changeKindCounts: unknown; notes: string[] };
      }).review;
      expect(reviewData.changedFiles).toEqual(['src/foo.ts']);
      expect(reviewData.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });
      expect(reviewData.notes).not.toContain('markEdited_before_bytes_unavailable');

      const audit = await call(client, 'session_audit', withEngagement(sessionId));
      expect(audit.body.state).toBe('audited_block');
      await call(client, 'session_revert', withEngagement(sessionId));
      await call(client, 'session_extract_rollback_template', withEngagement(sessionId));
      const repair = await call(client, 'session_get_repair_context', withEngagement(sessionId));
      const repairContext = (repair.body.data as {
        repairContext: {
          auditResult: { status: string };
          priorSessionHistory: Array<{ op: string }>;
        };
      }).repairContext;
      expect(repairContext.auditResult.status).toBe('BLOCK');
      expect(repairContext.priorSessionHistory.map((h) => h.op)).toContain('applyEdits');
      expect(repairContext.priorSessionHistory.map((h) => h.op)).not.toContain('markEdited');
    } finally {
      await dispose();
    }
  });
});
