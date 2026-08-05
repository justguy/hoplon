/**
 * tests/transport/http.seeCodebase.test.ts — seeCodebase HTTP round-trip.
 *
 * t-062 flipped the deferred remote stub on the HTTP + gRPC clients
 * (previously `EngineError { kind: 'remote_not_supported' }`). This test
 * proves the HTTP dispatcher now routes `seeCodebase` through the engine
 * facade by running an engine-bound request through fastify.inject() and
 * checking that the engine method was invoked with the parsed payload and
 * that its response round-trips verbatim.
 */

import { describe, it, expect, vi } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type {
  SeeCodebaseEnvelope,
  SeeCodebaseRequest,
} from '../../src/hoplon/contracts/seeCodebase.js';

function buildEngine(envelope: SeeCodebaseEnvelope): {
  engine: HoplonEngine;
  seeCodebase: ReturnType<typeof vi.fn>;
} {
  const seeCodebase = vi.fn(async (_req, _signal) => envelope);
  return {
    engine: { seeCodebase } as unknown as HoplonEngine,
    seeCodebase,
  };
}

describe('HTTP /seeCodebase route (t-062 remote flip)', () => {
  it('routes to engine.seeCodebase and returns the envelope verbatim', async () => {
    const envelope: SeeCodebaseEnvelope = {
      ok: true,
      data: {
        results: [
          {
            kind: 'raw_file',
            path: 'src/foo.ts',
            bytes: 42,
            content: 'export const foo = 1;\n',
            truncated: false,
            readProvenance: {
              kind: 'live_filesystem',
              workspaceRoot: '/repo',
              filePath: 'src/foo.ts',
              readAtIso: '2026-04-22T00:00:00.000Z',
            },
          },
        ],
      },
      provenance: {
        selectedPath: 'raw',
        routingReason: 'read_exact_text → raw',
        routingFactors: {
          intent: 'read_exact_text',
          fileKindSupport: 'not_applicable',
          modeRequested: 'raw',
          strict: false,
        },
        primitivesUsed: ['rawFileRead'],
        fallbackOccurred: false,
        fallbackBlockedByStrict: false,
        truncated: false,
        metrics: { latencyMs: 1, bytesReturned: 42 },
        correlationId: 'corr-see-1',
        engineId: 'mock-engine',
      },
    };
    const { engine, seeCodebase } = buildEngine(envelope);
    const server = await createHoplonHttpServer({ engine });
    try {
      const request: SeeCodebaseRequest = {
        projectId: 'proj-see',
        runId: 'run-see',
        correlationId: 'corr-see-1',
        intent: 'read_exact_text',
        targets: [{ kind: 'file', path: 'src/foo.ts' }],
        mode: 'raw',
      };
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(envelope);
      expect(seeCodebase).toHaveBeenCalledOnce();
      const [calledRequest] = seeCodebase.mock.calls[0];
      expect((calledRequest as SeeCodebaseRequest).intent).toBe('read_exact_text');
      expect((calledRequest as SeeCodebaseRequest).targets[0]).toEqual({
        kind: 'file',
        path: 'src/foo.ts',
      });
      // t-078: the new per-result readProvenance field flows end-to-end
      // through the HTTP transport without being dropped or coerced.
      const body = JSON.parse(response.body) as SeeCodebaseEnvelope;
      if (!body.ok) throw new Error('expected ok envelope');
      const firstResult = body.data.results[0];
      if (!firstResult || firstResult.kind !== 'raw_file') {
        throw new Error('expected raw_file result');
      }
      expect(firstResult.readProvenance).toEqual({
        kind: 'live_filesystem',
        workspaceRoot: '/repo',
        filePath: 'src/foo.ts',
        readAtIso: '2026-04-22T00:00:00.000Z',
      });
    } finally {
      await server.close();
    }
  });

  it('t-078: HTTP response schema rejects raw_file result missing readProvenance', async () => {
    // The wire contract is authoritative. A mock engine that forgets the new
    // field must not round-trip through the shared schema — proving the
    // provenance widening is load-bearing, not a documentation-only change.
    const brokenEnvelope = {
      ok: true,
      data: {
        results: [
          {
            kind: 'raw_file',
            path: 'src/foo.ts',
            bytes: 42,
            content: 'export const foo = 1;\n',
            truncated: false,
          },
        ],
      },
    };
    const { SeeCodebaseEnvelopeSchema } = await import(
      '../../src/hoplon/contracts/seeCodebase.js'
    );
    const result = SeeCodebaseEnvelopeSchema.safeParse(brokenEnvelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((i) => i.path.join('.'));
      expect(issuePaths.some((p) => p.includes('readProvenance'))).toBe(true);
    }
  });

  it('invalid request body → 400 ValidationError envelope', async () => {
    const { engine } = buildEngine({
      ok: false,
      error: {
        kind: 'INVALID_REQUEST',
        message: 'n/a',
        requestedPath: 'raw',
      },
    });
    const server = await createHoplonHttpServer({ engine });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: { intent: 'read_exact_text' }, // missing required fields
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { error: { class: string } };
      expect(body.error.class).toBe('ValidationError');
    } finally {
      await server.close();
    }
  });

  // Regression for a defect discovered while preparing the t-064 paired live
  // benchmark: `makeRequestSignal` previously listened to `req.raw`'s own
  // 'close' event, which fires when the request body stream drains — not
  // when the client disconnects. Over a real TCP socket that aborted the
  // engine call ~1ms in, so `see_codebase` (and every other engine-RPC
  // route) returned `INTERNAL: This operation was aborted` instead of a
  // real result. The fix listens to the socket's close event and gates the
  // abort on `reply.raw.writableEnded`, so the signal only trips on a true
  // client disconnect. fastify.inject (used by the tests above) never
  // exposed this path, so the regression is exercised against a listening
  // server.
  it('completes a real-socket /seeCodebase call without client-disconnect abort', async () => {
    let capturedSignalAborted: boolean | undefined;
    const envelope: SeeCodebaseEnvelope = {
      ok: true,
      data: {
        results: [
          {
            kind: 'raw_file',
            path: 'src/foo.ts',
            bytes: 42,
            content: 'export const foo = 1;\n',
            truncated: false,
            readProvenance: {
              kind: 'live_filesystem',
              workspaceRoot: '/repo',
              filePath: 'src/foo.ts',
              readAtIso: '2026-04-22T00:00:00.000Z',
            },
          },
        ],
      },
    };
    const engine = {
      seeCodebase: vi.fn(async (_req, signal) => {
        await new Promise((r) => setTimeout(r, 25));
        capturedSignalAborted = signal?.aborted ?? false;
        return envelope;
      }),
    } as unknown as HoplonEngine;

    const server = await createHoplonHttpServer({ engine });
    await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const addr = server.server.address();
      if (addr === null || typeof addr !== 'object') throw new Error('no address');
      const url = `http://127.0.0.1:${addr.port}/seeCodebase`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-see',
          runId: 'run-see',
          correlationId: 'corr-see-live',
          intent: 'read_exact_text',
          targets: [{ kind: 'file', path: 'src/foo.ts' }],
          mode: 'raw',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SeeCodebaseEnvelope;
      expect(body.ok).toBe(true);
      expect(capturedSignalAborted).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('cleans up the per-request socket close listener after a successful response', async () => {
    let capturedSocket: import('node:net').Socket | undefined;
    let baselineCloseListeners = -1;
    let inFlightCloseListeners = -1;
    const envelope: SeeCodebaseEnvelope = {
      ok: true,
      data: {
        results: [
          {
            kind: 'raw_file',
            path: 'src/foo.ts',
            bytes: 42,
            content: 'export const foo = 1;\n',
            truncated: false,
            readProvenance: {
              kind: 'live_filesystem',
              workspaceRoot: '/repo',
              filePath: 'src/foo.ts',
              readAtIso: '2026-04-22T00:00:00.000Z',
            },
          },
        ],
      },
    };
    const engine = {
      seeCodebase: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 25));
        inFlightCloseListeners = capturedSocket?.listenerCount('close') ?? -1;
        return envelope;
      }),
    } as unknown as HoplonEngine;

    const server = await createHoplonHttpServer({ engine });
    server.server.once('connection', (socket) => {
      capturedSocket = socket;
      baselineCloseListeners = socket.listenerCount('close');
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const addr = server.server.address();
      if (addr === null || typeof addr !== 'object') throw new Error('no address');
      const url = `http://127.0.0.1:${addr.port}/seeCodebase`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-see',
          runId: 'run-see',
          correlationId: 'corr-see-cleanup',
          intent: 'read_exact_text',
          targets: [{ kind: 'file', path: 'src/foo.ts' }],
          mode: 'raw',
        }),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      await new Promise((r) => setTimeout(r, 10));
      expect(capturedSocket).toBeDefined();
      expect(inFlightCloseListeners).toBeGreaterThan(baselineCloseListeners);
      expect(capturedSocket?.listenerCount('close')).toBe(baselineCloseListeners);
    } finally {
      await server.close();
    }
  });
});
