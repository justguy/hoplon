/**
 * tests/transport/http.liveSession.test.ts — live HTTP session smoke.
 *
 * Proves one real listening-socket PASS branch over `/session/*` so the
 * packaged HTTP session surface is not only exercised via fastify.inject().
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createRemoteHoplonSessionClient } from '../../src/hoplon/transport/http/sessionClient.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import {
  MANIFEST,
  PASS_AUDIT,
  makeMockEngine,
} from '../session/helpers.js';

async function postJson<T>(
  baseUrl: string,
  pathname: string,
  payload: unknown,
): Promise<{ statusCode: number; body: T }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return {
    statusCode: response.status,
    body: (await response.json()) as T,
  };
}

describe('HTTP live session smoke (t-069)', () => {
  it('completes a real-socket PASS loop over /session/*', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({
      auditDiff: async () => PASS_AUDIT,
    });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    await server.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const content = 'export const live_http_session = true;\n';

      const start = await postJson<{ session: { sessionId: string }; state: string }>(
        baseUrl,
        '/session/start',
        { manifest: JSON.stringify(MANIFEST) },
      );
      expect(start.statusCode).toBe(200);
      expect(start.body.state).toBe('created');
      const sessionId = start.body.session.sessionId;

      const preflight = await postJson<{ state: string }>(
        baseUrl,
        '/session/preflight',
        { sessionId },
      );
      expect(preflight.statusCode).toBe(200);
      expect(preflight.body.state).toBe('preflighted_pass');

      const snapshot = await postJson<{
        state: string;
        data: { snapshotRef: { id: string } };
      }>(baseUrl, '/session/createSnapshot', { sessionId });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.body.state).toBe('snapshotted');
      expect(snapshot.body.data.snapshotRef.id).toMatch(/^sha256:/);

      const applied = await postJson<{
        state: string;
        data: { changedFiles: string[]; bytesWritten: number };
      }>(baseUrl, '/session/applyEdits', {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content }],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/foo.ts']);
      expect(applied.body.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(content);

      const audit = await postJson<{
        state: string;
        data: { result: { status: string } };
      }>(baseUrl, '/session/audit', { sessionId });
      expect(audit.statusCode).toBe(200);
      expect(audit.body.state).toBe('audited_pass');
      expect(audit.body.data.result.status).toBe('PASS');

      const closed = await postJson<{ state: string; data: { closed: boolean } }>(
        baseUrl,
        '/session/close',
        { sessionId },
      );
      expect(closed.statusCode).toBe(200);
      expect(closed.body.state).toBe('closed');
      expect(closed.body.data.closed).toBe(true);
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);

  it('returns a typed SessionError envelope over a real socket when a patch anchor is stale', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const live = true;\n'));
    const engine = makeMockEngine({
      auditDiff: async () => PASS_AUDIT,
    });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    await server.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const start = await postJson<{ session: { sessionId: string }; state: string }>(
        baseUrl,
        '/session/start',
        { manifest: JSON.stringify(MANIFEST) },
      );
      const sessionId = start.body.session.sessionId;

      await postJson(baseUrl, '/session/preflight', { sessionId });
      await postJson(baseUrl, '/session/createSnapshot', { sessionId });

      const failed = await postJson<{
        error: {
          class: string;
          kind: string;
          message: string;
          correlationId: string;
          details: {
            recoveryClass: string;
            file: string;
            changeKind: string;
            failedChangeIndex: number;
            failedHunkIndex: number;
          };
        };
      }>(baseUrl, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'patch',
            file: 'src/foo.ts',
            hunks: [{ search: 'export const missing = true;', replace: 'export const live = false;' }],
          },
        ],
      });
      expect(failed.statusCode).toBe(409);
      expect(failed.body.error.class).toBe('SessionError');
      expect(failed.body.error.kind).toBe('patch_not_applicable');
      expect(failed.body.error.correlationId).toBe(sessionId);
      expect(failed.body.error.details.recoveryClass).toBe('refresh_and_recompute');
      expect(failed.body.error.details.file).toBe('src/foo.ts');
      expect(failed.body.error.details.changeKind).toBe('patch');
      expect(failed.body.error.details.failedChangeIndex).toBe(0);
      expect(failed.body.error.details.failedHunkIndex).toBe(0);
      expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
        'export const live = true;\n',
      );
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);

  it('stages a >1 MiB non-binary body in chunks and applies it over a real socket (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    await server.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const client = createRemoteHoplonSessionClient({ baseUrl });

      const start = await client.start({ manifest: MANIFEST });
      const sessionId = start.session.sessionId;
      await client.preflight({ sessionId });
      await client.createSnapshot({ sessionId });

      // Build a body well past the 1 MiB Fastify default so the legacy
      // single-request path would have failed without the stageContent seam.
      const CHUNK_BYTES = 512 * 1024; // 512 KiB per chunk
      const TOTAL_BYTES = 1_500_000; // ~1.43 MiB — over the default 1 MiB ceiling
      let body = 'export const staged = [\n';
      while (body.length < TOTAL_BYTES) {
        body += '  ' + 'x'.repeat(256) + ',\n';
      }
      body += '];\n';
      const bodyBytes = new TextEncoder().encode(body);
      const sha = createHash('sha256').update(bodyBytes).digest('hex');

      let seq = 0;
      for (let offset = 0; offset < bodyBytes.byteLength; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, bodyBytes.byteLength);
        const isFinal = end === bodyBytes.byteLength;
        const chunkBase64 = Buffer.from(
          bodyBytes.slice(offset, end),
        ).toString('base64');
        const req: Parameters<typeof client.stageContent>[0] = {
          sessionId,
          stagingKey: 'big-live',
          seq,
          chunk: chunkBase64,
          isFinal,
        };
        if (isFinal) {
          req.expectedTotalSha256 = sha;
          req.expectedTotalByteLength = bodyBytes.byteLength;
        }
        const r = await client.stageContent(req);
        expect(r.data.stagingKey).toBe('big-live');
        if (isFinal) {
          expect(r.data.complete).toBe(true);
          expect(r.data.sha256).toBe(sha);
        } else {
          expect(r.data.complete).toBe(false);
        }
        seq += 1;
      }

      const applied = await client.applyEdits({
        sessionId,
        proposedChanges: [
          {
            kind: 'full_file',
            file: 'src/big.ts',
            stagedContent: {
              stagingKey: 'big-live',
              expectedSha256: sha,
              expectedByteLength: bodyBytes.byteLength,
            },
          },
        ],
      });
      expect(applied.state).toBe('edited');
      expect(applied.data.changedFiles).toEqual(['src/big.ts']);
      expect(applied.data.bytesWritten).toBe(bodyBytes.byteLength);
      expect(applied.data.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });
      expect(new TextDecoder().decode(await fs.read('src/big.ts'))).toBe(body);

      const audit = await client.audit({ sessionId });
      expect(audit.state).toBe('audited_pass');
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);

  it('still caps /session/applyEdits at the default Fastify body limit when stagedContent is not used (t-076 honest narrowing)', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ auditDiff: async () => PASS_AUDIT });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const start = await postJson<{ session: { sessionId: string } }>(
        baseUrl,
        '/session/start',
        { manifest: JSON.stringify(MANIFEST) },
      );
      const sessionId = start.body.session.sessionId;
      await postJson(baseUrl, '/session/preflight', { sessionId });
      await postJson(baseUrl, '/session/createSnapshot', { sessionId });

      // Inline content well past the default 1 MiB body cap. The bounded
      // slice deliberately does not widen `/session/applyEdits`; only the
      // stageContent route has a raised bodyLimit. A single 1.5 MiB inline
      // applyEdits must be rejected at the Fastify body parser.
      const huge = 'x'.repeat(1_500_000);
      const response = await fetch(`${baseUrl}/session/applyEdits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          proposedChanges: [
            { kind: 'full_file', file: 'src/huge.ts', content: huge },
          ],
        }),
      });
      // Fastify returns 413 (Payload Too Large) when the body exceeds the
      // per-route bodyLimit (default 1 MiB).
      expect(response.status).toBe(413);
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);

  it('drives the packaged session loop through createRemoteHoplonSessionClient over a real socket', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({
      auditDiff: async () => PASS_AUDIT,
    });
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    await server.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const client = createRemoteHoplonSessionClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
      });

      const start = await client.start({ manifest: MANIFEST });
      expect(start.state).toBe('created');
      const sessionId = start.session.sessionId;

      const preflight = await client.preflight({ sessionId });
      expect(preflight.state).toBe('preflighted_pass');

      const snapshot = await client.createSnapshot({ sessionId });
      expect(snapshot.state).toBe('snapshotted');

      const applied = await client.applyEdits({
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const client = true;\n' }],
      });
      expect(applied.state).toBe('edited');
      expect(applied.data.changeKindCounts).toEqual({
        full_file: 1,
        patch: 0,
        structural: 0,
      });

      const audit = await client.audit({ sessionId });
      expect(audit.state).toBe('audited_pass');

      const list = await client.list();
      expect(list.sessions.map((entry) => entry.sessionId)).toContain(sessionId);
    } finally {
      await server.close();
      registry.dispose();
    }
  }, 30_000);
});
