import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { SemanticSearchResult } from '../../src/hoplon/contracts/semanticSearch.js';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('MCP semantic_search tool', () => {
  it('routes valid semantic_search requests through the engine handler', async () => {
    const response: SemanticSearchResult = {
      correlationId: 'corr-mcp-semantic',
      projectId: 'proj-a',
      advisory: true,
      status: 'UNAVAILABLE',
      providerStatus: 'AVAILABLE',
      providerAvailable: true,
      resultCount: 0,
      freshness: 'unavailable',
      degradationReasons: ['overlay_never_created'],
      topK: 3,
      matches: [],
      suggestions: [
        {
          kind: 'live_session_overlay_missing',
          message:
            'Run refresh_semantic_overlay for this session, then retry with sessionId.',
          provenance: 'deterministic',
        },
      ],
    };
    const semanticSearch = vi.fn().mockResolvedValue(response);
    const engine = { semanticSearch } as unknown as HoplonEngine;
    const server = createHoplonMcpServer({ engine });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: 'semantic-tool-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('semantic_search');

      const result = (await client.callTool({
        name: 'semantic_search',
        arguments: {
          correlationId: 'corr-mcp-semantic',
          projectId: 'proj-a',
          query: 'overlay-only query',
          topK: 3,
          freshness: 'live_session',
        },
      })) as ToolResponse;

      expect(result.isError).not.toBe(true);
      expect(semanticSearch).toHaveBeenCalledWith({
        correlationId: 'corr-mcp-semantic',
        projectId: 'proj-a',
        query: 'overlay-only query',
        topK: 3,
        freshness: 'live_session',
      });
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
        advisory: true,
        status: 'UNAVAILABLE',
        degradationReasons: ['overlay_never_created'],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
