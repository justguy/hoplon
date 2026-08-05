/**
 * tests/mcp/httpSseTransport.test.ts — GAP G4 regression.
 *
 * The packaged MCP SSE transport previously kept a single global activeTransport
 * (concurrent clients evicted each other and could receive each other's traffic)
 * and read POST bodies with no size ceiling. This suite exercises the real HTTP
 * server: two concurrent SSE clients stay isolated, and an oversize POST body is
 * rejected with a typed 413 envelope.
 */

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createHttpSseTransport } from '../../src/hoplon/mcp/transports.js';

interface SseClient {
  sessionId: string;
  request: http.ClientRequest;
}

/** Open a GET /sse stream and resolve once the endpoint event yields a sessionId. */
function openSse(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/sse', method: 'GET' },
      (res) => {
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const match = buffer.match(/sessionId=([0-9a-fA-F-]+)/);
          const sessionId = match?.[1];
          if (sessionId !== undefined) resolve({ sessionId, request });
        });
        res.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** POST a raw body to /message?sessionId=... and resolve with status + parsed json. */
function postMessage(
  port: number,
  sessionId: string,
  body: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/message?sessionId=${encodeURIComponent(sessionId)}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (c: string) => (buf += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = buf ? JSON.parse(buf) : null;
          } catch {
            json = buf;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function rpc(id: number): string {
  const msg: JSONRPCMessage = { jsonrpc: '2.0', id, method: 'ping' } as JSONRPCMessage;
  return JSON.stringify(msg);
}

describe('GAP G4 — HTTP SSE transport isolation + size ceiling', () => {
  it('routes concurrent clients to their own transport (no eviction, no cross-talk)', async () => {
    const received: Array<{ sessionId: string; id: unknown }> = [];
    const seen: Transport[] = [];
    const sse = createHttpSseTransport({
      port: 0,
      host: '127.0.0.1',
      onTransport: async (t) => {
        seen.push(t);
        t.onmessage = (msg) => {
          received.push({
            sessionId: (t as unknown as { sessionId: string }).sessionId,
            id: (msg as { id?: unknown }).id,
          });
        };
        await t.start();
      },
    });
    const port = await sse.ready;

    try {
      const clientA = await openSse(port);
      const clientB = await openSse(port);

      // Distinct sessions, both still registered (neither evicted the other).
      expect(clientA.sessionId).not.toBe(clientB.sessionId);
      expect(seen).toHaveLength(2);

      const resA = await postMessage(port, clientA.sessionId, rpc(101));
      const resB = await postMessage(port, clientB.sessionId, rpc(202));
      expect(resA.status).toBe(202);
      expect(resB.status).toBe(202);

      // Each transport received only its own message.
      const forA = received.filter((r) => r.sessionId === clientA.sessionId);
      const forB = received.filter((r) => r.sessionId === clientB.sessionId);
      expect(forA).toEqual([{ sessionId: clientA.sessionId, id: 101 }]);
      expect(forB).toEqual([{ sessionId: clientB.sessionId, id: 202 }]);

      clientA.request.destroy();
      clientB.request.destroy();
    } finally {
      await sse.close();
    }
  });

  it('rejects an oversize POST body with a typed 413 envelope', async () => {
    const sse = createHttpSseTransport({
      port: 0,
      host: '127.0.0.1',
      maxMessageBytes: 64,
      onTransport: async (transport) => {
        await transport.start();
      },
    });
    const port = await sse.ready;

    try {
      const client = await openSse(port);
      const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(500) } });
      expect(Buffer.byteLength(huge)).toBeGreaterThan(64);

      const res = await postMessage(port, client.sessionId, huge);
      expect(res.status).toBe(413);
      expect(res.json).toMatchObject({
        error: { kind: 'request_too_large', maxBytes: 64 },
      });

      client.request.destroy();
    } finally {
      await sse.close();
    }
  });

  it('removes closed sessions and returns the same typed 404 as unknown ids', async () => {
    let cleaned!: () => void;
    const cleanupObserved = new Promise<void>((resolve) => {
      cleaned = resolve;
    });
    const sse = createHttpSseTransport({
      port: 0,
      host: '127.0.0.1',
      onTransport: async (transport) => {
        await transport.start();
        return cleaned;
      },
    });
    const port = await sse.ready;
    try {
      const res = await postMessage(port, 'does-not-exist', rpc(1));
      expect(res.status).toBe(404);
      expect(res.json).toMatchObject({ error: { kind: 'unknown_session' } });

      const client = await openSse(port);
      const serverClosed = sse.waitForSessionClose(client.sessionId);
      client.request.destroy();
      await Promise.all([cleanupObserved, serverClosed]);
      const closed = await postMessage(port, client.sessionId, rpc(2));
      expect(closed.status).toBe(404);
      expect(closed.json).toMatchObject({ error: { kind: 'unknown_session' } });
    } finally {
      await sse.close();
    }
  });
});
