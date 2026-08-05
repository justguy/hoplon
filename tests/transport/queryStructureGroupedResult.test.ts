import { describe, it, expect, vi } from 'vitest';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { QueryStructureResult } from '../../src/hoplon/contracts/queryStructure.js';

const GROUPED_RESULT: QueryStructureResult = {
  matches: [
    {
      queryId: 'find-function',
      path: 'src/foo.ts',
      captureName: 'name',
      text: 'foo',
      byteRange: [9, 12],
      nodeKind: 'identifier',
      matchId: 'src/foo.ts#find-function#0#0',
      patternIndex: 0,
      captureIndex: 0,
      fieldName: 'name',
      fieldPath: ['name'],
    },
  ],
  matchGroups: [
    {
      matchId: 'src/foo.ts#find-function#0#0',
      queryId: 'find-function',
      path: 'src/foo.ts',
      patternIndex: 0,
      captures: [
        {
          queryId: 'find-function',
          path: 'src/foo.ts',
          captureName: 'name',
          text: 'foo',
          byteRange: [9, 12],
          nodeKind: 'identifier',
          matchId: 'src/foo.ts#find-function#0#0',
          patternIndex: 0,
          captureIndex: 0,
          fieldName: 'name',
          fieldPath: ['name'],
        },
      ],
    },
  ],
  failures: [],
};

const QUERY_REQUEST = {
  projectId: 'proj-transport',
  runId: 'run-transport',
  correlationId: 'corr-transport',
  files: ['src/foo.ts'],
  queries: [
    {
      id: 'find-function',
      language: 'typescript' as const,
      pattern: '(function_declaration name: (identifier) @name)',
    },
  ],
};

describe('queryStructure grouped result transport parity', () => {
  it('HTTP client accepts grouped queryStructure result schema', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(GROUPED_RESULT)),
    } as unknown as Response);
    const engine = createRemoteHoplonEngine({
      baseUrl: 'http://localhost:3000',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    const result = await engine.queryStructure(QUERY_REQUEST);

    expect(result.matchGroups?.[0]?.captures[0]?.fieldName).toBe('name');
    expect(result.matches[0]?.matchId).toBe(result.matchGroups?.[0]?.matchId);
  });

  it('HTTP route returns grouped queryStructure result unchanged', async () => {
    const engine = {
      queryStructure: vi.fn().mockResolvedValue(GROUPED_RESULT),
    } as unknown as HoplonEngine;
    const server = await createHoplonHttpServer({ engine });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/queryStructure',
        payload: QUERY_REQUEST,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<QueryStructureResult>();
      expect(body.matchGroups?.[0]?.captures[0]?.fieldPath).toEqual(['name']);
      expect(engine.queryStructure).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
