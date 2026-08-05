/**
 * mcp/transports.ts — Transport factory helpers for HoplonMcpServer.
 *
 * Provides two factory functions that return concrete MCP Transport instances:
 *
 *   createStdioTransport()              — binds to process.stdin / process.stdout.
 *                                         Use for CLI / subprocess deployments.
 *
 *   createHttpSseTransport({ port })    — creates a minimal HTTP server that
 *                                         serves MCP SSE sessions on GET /sse and
 *                                         accepts POST /message for each session.
 *                                         Use for network / IDE deployments.
 *
 * The caller passes the returned transport to `server.connect(transport)`.
 *
 * Design constraints (H2):
 *   - These factories are pure wiring; no engine logic lives here.
 *   - All I/O is via the MCP SDK Transport abstractions.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import * as http from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createSseSessionLifecycle } from './httpSseSessionLifecycle.js';
import type { HttpSseTransportCleanup } from './httpSseSessionLifecycle.js';

export type { HttpSseTransportCleanup } from './httpSseSessionLifecycle.js';

// ---------------------------------------------------------------------------
// createStdioTransport
// ---------------------------------------------------------------------------

/**
 * Create a stdio-based MCP transport that reads JSON-RPC messages from
 * `process.stdin` and writes responses to `process.stdout`.
 *
 * Pass the returned transport to `server.connect(transport)`.
 */
export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}

// ---------------------------------------------------------------------------
// HttpSseServer — lifecycle handle returned by createHttpSseTransport
// ---------------------------------------------------------------------------

export interface HttpSseServer {
  /** The underlying Node.js HTTP server (for graceful shutdown in tests). */
  httpServer: http.Server;
  /** Resolves with the actual bound port (including when port 0 is requested). */
  ready: Promise<number>;
  /** Resolve after server-side removal and per-session cleanup complete. */
  waitForSessionClose(sessionId: string): Promise<void>;
  /** Close the HTTP server and all active SSE connections. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createHttpSseTransport
// ---------------------------------------------------------------------------

/** Default ceiling for a single POST /message body: 16 MiB. Generous enough
 * for large JSON-RPC payloads (e.g. staged content / corpus documents) while
 * bounding per-request memory. Configurable via `maxMessageBytes`. */
export const DEFAULT_SSE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Create a minimal HTTP/SSE transport that wraps an MCP Server.
 *
 * The HTTP server exposes two routes:
 *   GET  /sse     — establishes an SSE stream; the MCP server connects to this transport
 *   POST /message — relays a JSON-RPC message into the SSE session identified by
 *                   the `?sessionId=` query param the SDK advertises to the client
 *
 * Multi-session: each SSE connection gets its own SSEServerTransport, tracked by
 * its session id, so concurrent clients neither evict one another nor receive
 * each other's traffic. POST bodies are bounded by a configurable size ceiling;
 * an oversize body is rejected with a typed 413 envelope.
 *
 * @param opts.port            - TCP port to listen on (default: 3000)
 * @param opts.onTransport     - callback invoked with each new SSEServerTransport.
 *                               It owns starting the transport (normally through
 *                               server.connect) and may return a session cleanup.
 * @param opts.maxMessageBytes - max bytes for one POST /message body
 *                               (default: DEFAULT_SSE_MAX_MESSAGE_BYTES).
 *
 * Returns the HTTP server handle so tests can close it cleanly.
 */
export function createHttpSseTransport(opts: {
  port?: number;
  host?: string;
  onTransport: (
    transport: Transport,
  ) =>
    | void
    | HttpSseTransportCleanup
    | Promise<void | HttpSseTransportCleanup>;
  maxMessageBytes?: number;
}): HttpSseServer {
  const port = opts.port ?? 3000;
  const maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_SSE_MAX_MESSAGE_BYTES;

  const lifecycle = createSseSessionLifecycle();

  const sendUnknownSession = (res: http.ServerResponse): void => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          kind: 'unknown_session',
          message: 'No active SSE session for the given sessionId',
        },
      }),
    );
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      // Establish a per-client SSE stream. The message endpoint is /message; the
      // SDK appends this transport's sessionId so POSTs route back here.
      const transport = new SSEServerTransport('/message', res);
      const active = lifecycle.register(transport, res);
      res.once('close', () => lifecycle.close(transport.sessionId, active));
      try {
        const cleanup = await opts.onTransport(transport);
        lifecycle.attach(
          active,
          typeof cleanup === 'function' ? cleanup : undefined,
        );
      } catch {
        lifecycle.attachmentFailed(active);
        lifecycle.close(transport.sessionId, active);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                kind: 'transport_connection_failed',
                message: 'The MCP server could not attach to the SSE transport',
              },
            }),
          );
        } else {
          res.end();
        }
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId');
      const active = sessionId ? lifecycle.getOpen(sessionId) : undefined;
      if (!active) {
        sendUnknownSession(res);
        return;
      }

      // Relay the POST body into this session, bounded by the size ceiling.
      let received = 0;
      let rejected = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        received += chunk.length;
        if (received > maxMessageBytes) {
          rejected = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                kind: 'request_too_large',
                message: `SSE message body exceeds the ${maxMessageBytes}-byte ceiling`,
                maxBytes: maxMessageBytes,
              },
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (rejected) return;
        if (
          sessionId === null ||
          lifecycle.getOpen(sessionId) !== active
        ) {
          sendUnknownSession(res);
          return;
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        await active.transport.handlePostMessage(req, res, parsed);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const ready = new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.once('listening', () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
  if (opts.host !== undefined) httpServer.listen(port, opts.host);
  else httpServer.listen(port);

  return {
    httpServer,
    ready,
    waitForSessionClose(sessionId: string): Promise<void> {
      return lifecycle.waitForClose(sessionId);
    },
    async close(): Promise<void> {
      const cleanupErrors = await lifecycle.closeAll();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'SSE session cleanup failed');
      }
    },
  };
}
