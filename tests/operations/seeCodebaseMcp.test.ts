import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';

describe('seeCodebase MCP transport', () => {
  it('SC-10: see_codebase tool round-trips through the MCP server', async () => {
    const engine = {
      seeCodebase: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          results: [],
          partial: true,
          errors: [{
            kind: 'PATH_NOT_FOUND',
            message: 'missing a.txt',
            requestedPath: 'raw',
            targetPath: 'a.txt',
          }],
        },
        provenance: {
          selectedPath: 'raw',
          routingReason: 'test',
          routingFactors: {
            intent: 'read_exact_text',
            fileKindSupport: 'not_applicable',
            modeRequested: 'auto',
            strict: false,
          },
          primitivesUsed: [],
          fallbackOccurred: false,
          fallbackBlockedByStrict: false,
          truncated: false,
          metrics: { latencyMs: 1, bytesReturned: 0 },
          correlationId: 'mcp-corr',
          engineId: 'mcp-engine',
        },
      }),
    } as unknown as HoplonEngine;
    const server = createHoplonMcpServer({ engine });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'see_codebase',
      arguments: {
        projectId: 'p',
        runId: 'r',
        correlationId: 'mcp-corr',
        intent: 'read_exact_text',
        targets: [{ kind: 'file', path: 'a.txt' }],
      },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    if (content === undefined) throw new Error('missing MCP content');
    const parsed = JSON.parse(content.text) as {
      ok: boolean;
      data?: { partial?: boolean; errors?: Array<{ targetPath?: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.partial).toBe(true);
    expect(parsed.data?.errors?.[0]?.targetPath).toBe('a.txt');
    expect(engine.seeCodebase).toHaveBeenCalledTimes(1);
  });
});
