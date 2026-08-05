/**
 * tests/transport/t117PayloadStagingCeilings.test.ts — transport proof for
 * t-117 payload/staging ceilings and typed recovery metadata.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import {
  STAGE_MAX_CHUNK_BYTES,
} from '../../src/hoplon/session/stagingStore.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import {
  SESSION_STAGE_CONTENT_BODY_LIMIT,
} from '../../src/hoplon/transport/http/sessionRoutes.js';
import { MANIFEST, PASS_AUDIT, makeMockEngine } from '../session/helpers.js';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function post<T>(
  server: FastifyInstance,
  url: string,
  payload: unknown,
): Promise<{ statusCode: number; body: T }> {
  const response = await server.inject({ method: 'POST', url, payload });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as T };
}

async function startSnapshottedSession(server: FastifyInstance): Promise<string> {
  const start = await post<{ session: { sessionId: string } }>(
    server,
    '/session/start',
    { manifest: MANIFEST },
  );
  const sessionId = start.body.session.sessionId;
  await post(server, '/session/preflight', { sessionId });
  await post(server, '/session/createSnapshot', { sessionId });
  return sessionId;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('payload and staging ceilings (t-117)', () => {
  it('keeps HTTP inline applyEdits and stageContent body ceilings bounded', async () => {
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const sessionId = await startSnapshottedSession(server);

      const inlineTooLarge = await server.inject({
        method: 'POST',
        url: '/session/applyEdits',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          sessionId,
          proposedChanges: [
            { kind: 'full_file', file: 'src/inline-too-large.ts', content: 'x'.repeat(1_500_000) },
          ],
        }),
      });
      expect(inlineTooLarge.statusCode).toBe(413);

      const stagedBodyTooLarge = await server.inject({
        method: 'POST',
        url: '/session/stageContent',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          sessionId,
          stagingKey: 'stage-body-too-large',
          seq: 0,
          chunk: 'A'.repeat(SESSION_STAGE_CONTENT_BODY_LIMIT),
          isFinal: false,
        }),
      });
      expect(stagedBodyTooLarge.statusCode).toBe(413);
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);

  it('returns HTTP SessionError recovery metadata for non-UTF-8 staged bytes', async () => {
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const sessionId = await startSnapshottedSession(server);
      const invalidUtf8 = new Uint8Array([0xff]);

      const res = await post<{
        error: {
          class: string;
          kind: string;
          details: { recoveryClass: string; prerequisite: string };
        };
      }>(server, '/session/stageContent', {
        sessionId,
        stagingKey: 'binary-http',
        seq: 0,
        chunk: Buffer.from(invalidUtf8).toString('base64'),
        isFinal: true,
        expectedTotalSha256: sha256(invalidUtf8),
        expectedTotalByteLength: invalidUtf8.byteLength,
      });

      expect(res.statusCode).toBe(409);
      expect(res.body.error.class).toBe('SessionError');
      expect(res.body.error.kind).toBe('stage_integrity_mismatch');
      expect(res.body.error.details.recoveryClass).toBe('refresh_and_recompute');
      expect(res.body.error.details.prerequisite).toBe('utf8_text');
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('returns MCP SessionError recovery metadata for stageContent chunk overflow', async () => {
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine });
    const server = createHoplonMcpServer({ engine, sessionRegistry: registry });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 't117-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('session_stage_content');
      const start = await client.callTool({
        name: 'start_edit_session',
        arguments: { manifest: MANIFEST },
      });
      const startBody = JSON.parse((start as ToolResponse).content[0].text) as {
        session: { sessionId: string };
      };
      const sessionId = startBody.session.sessionId;
      await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
      await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });

      const oversizedChunk = Buffer.from(
        new Uint8Array(STAGE_MAX_CHUNK_BYTES + 1),
      ).toString('base64');
      const res = (await client.callTool({
        name: 'session_stage_content',
        arguments: {
          sessionId,
          stagingKey: 'mcp-too-large',
          seq: 0,
          chunk: oversizedChunk,
          isFinal: false,
        },
      })) as ToolResponse;
      const body = JSON.parse(res.content[0].text) as {
        class: string;
        kind: string;
        sessionId: string;
        details: { recoveryClass: string; prerequisite: string };
      };

      expect(res.isError).toBe(true);
      expect(body.class).toBe('SessionError');
      expect(body.kind).toBe('stage_integrity_mismatch');
      expect(body.sessionId).toBe(sessionId);
      expect(body.details.recoveryClass).toBe('refresh_and_recompute');
      expect(body.details.prerequisite).toBe('chunkSize');
    } finally {
      registry.dispose();
    }
  }, 30_000);

  it('round-trips a large generated text file through stagedContent without truncation', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const sessionId = await startSnapshottedSession(server);
      let body = 'export const generated = [\n';
      while (Buffer.byteLength(body, 'utf8') < 1_200_000) {
        body += `  "${'generated-text-'.repeat(12)}",\n`;
      }
      body += '];\n';
      const bodyBytes = new TextEncoder().encode(body);
      const digest = sha256(bodyBytes);
      const chunkSize = 512 * 1024;
      let seq = 0;
      for (let offset = 0; offset < bodyBytes.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bodyBytes.byteLength);
        const isFinal = end === bodyBytes.byteLength;
        await post(server, '/session/stageContent', {
          sessionId,
          stagingKey: 'large-generated',
          seq,
          chunk: Buffer.from(bodyBytes.subarray(offset, end)).toString('base64'),
          isFinal,
          ...(isFinal
            ? {
                expectedTotalSha256: digest,
                expectedTotalByteLength: bodyBytes.byteLength,
              }
            : {}),
        });
        seq += 1;
      }

      const applied = await post<{
        state: string;
        data: { changedFiles: string[]; bytesWritten: number };
      }>(server, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/generated/large.generated.ts',
            stagedContent: {
              stagingKey: 'large-generated',
              expectedSha256: digest,
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });

      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/generated/large.generated.ts']);
      expect(applied.body.data.bytesWritten).toBe(bodyBytes.byteLength);
      expect(new TextDecoder().decode(await fs.read('src/generated/large.generated.ts'))).toBe(body);
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);
});
