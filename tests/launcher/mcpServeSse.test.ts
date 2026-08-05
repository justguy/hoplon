import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runMcpServe } from '../../src/hoplon/launcher/mcpServe.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

interface SseClient {
  readonly sessionId: string;
  readonly response: http.IncomingMessage;
  readonly messages: Array<Record<string, unknown>>;
  waitForId(id: number): Promise<Record<string, unknown>>;
}

function openSse(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const waiters = new Map<number, (message: Record<string, unknown>) => void>();
    const request = http.get(`http://127.0.0.1:${port}/sse`, (response) => {
      let buffer = '';
      let client: SseClient | undefined;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === 'endpoint' && data !== undefined && client === undefined) {
            const sessionId = new URL(data, `http://127.0.0.1:${port}`).searchParams.get(
              'sessionId',
            );
            if (sessionId === null) return reject(new Error('missing sessionId'));
            client = {
              sessionId,
              response,
              messages,
              waitForId(id) {
                const existing = messages.find((message) => message['id'] === id);
                if (existing !== undefined) return Promise.resolve(existing);
                return new Promise((done) => waiters.set(id, done));
              },
            };
            resolve(client);
          }
          if (event === 'message' && data !== undefined) {
            const message = JSON.parse(data) as Record<string, unknown>;
            messages.push(message);
            if (typeof message['id'] === 'number') {
              waiters.get(message['id'])?.(message);
              waiters.delete(message['id']);
            }
          }
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function post(
  port: number,
  sessionId: string,
  body: string,
): Promise<{ status: number; body: Record<string, unknown> | string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/message?sessionId=${encodeURIComponent(sessionId)}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let received = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (received += chunk));
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(received) as Record<string, unknown>,
            });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: received });
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

const ping = (id: number, pad = ''): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { pad } });

describe('runMcpServe SSE session isolation', () => {
  it('uses one SDK server per client and cleans up closed, unknown, and oversized posts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-sse-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      transport: 'sse',
      port: 0,
      sseHost: '127.0.0.1',
      sseMaxMessageBytes: 128,
    });

    try {
      if (handle.port === null) throw new Error('SSE launcher did not bind a port');
      const port = handle.port;
      const clientA = await openSse(port);
      const clientB = await openSse(port);

      const [acceptedA, acceptedB] = await Promise.all([
        post(port, clientA.sessionId, ping(101)),
        post(port, clientB.sessionId, ping(202)),
      ]);
      expect(acceptedA.status).toBe(202);
      expect(acceptedB.status).toBe(202);
      await Promise.all([clientA.waitForId(101), clientB.waitForId(202)]);
      expect(clientA.messages.map((message) => message['id'])).toEqual([101]);
      expect(clientB.messages.map((message) => message['id'])).toEqual([202]);

      const oversized = await post(port, clientB.sessionId, ping(303, 'x'.repeat(500)));
      expect(oversized).toMatchObject({
        status: 413,
        body: { error: { kind: 'request_too_large', maxBytes: 128 } },
      });
      const unknown = await post(port, 'unknown-session', ping(404));
      expect(unknown).toMatchObject({
        status: 404,
        body: { error: { kind: 'unknown_session' } },
      });

      const serverClosed = handle.waitForSseSessionClose?.(clientA.sessionId);
      if (serverClosed === undefined) {
        throw new Error('SSE lifecycle acknowledgement is unavailable');
      }
      const clientClosed = once(clientA.response, 'close');
      clientA.response.destroy();
      await Promise.all([clientClosed, serverClosed]);
      const afterClose = await post(port, clientA.sessionId, ping(505));
      expect(afterClose).toMatchObject({
        status: 404,
        body: { error: { kind: 'unknown_session' } },
      });
      clientB.response.destroy();
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
