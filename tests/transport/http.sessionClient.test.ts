import { describe, it, expect, vi } from 'vitest';

import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { SessionError } from '../../src/hoplon/session/errors.js';
import type { SessionTransportError } from '../../src/hoplon/session/transport.js';
import { createRemoteHoplonSessionClient } from '../../src/hoplon/transport/http/sessionClient.js';

const BASE_URL = 'http://localhost:3900';

type MockFetch = ReturnType<typeof vi.fn>;

function mockJsonResponse(body: unknown, status = 200): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

describe('createRemoteHoplonSessionClient', () => {
  it('serializes start() and parses the typed session response', async () => {
    const fetchMock = mockJsonResponse({
      session: {
        sessionId: 'hoplon-session-1',
        projectId: 'proj-1',
        runId: 'run-1',
        correlationId: 'corr-1',
        createdAtMs: 1,
      },
      state: 'created',
      historyLength: 1,
      data: { engineId: 'local-0' },
    });
    const client = createRemoteHoplonSessionClient({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.start({
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-1',
        runId: 'run-1',
        correlationId: 'corr-1',
        entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
      },
    });

    expect(result.state).toBe('created');
    expect(result.data.engineId).toBe('local-0');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { manifest: { projectId: string } };
    expect(body.manifest.projectId).toBe('proj-1');
  });

  it('reconstructs SessionError with recovery details from packaged HTTP envelopes', async () => {
    const fetchMock = mockJsonResponse(
      {
        error: {
          class: 'SessionError',
          kind: 'patch_not_applicable',
          message:
            'Hoplon session: patch_not_applicable (attempted applyEdits from snapshotted; patch hunk 0 for "src/foo.ts": search anchor not found)',
          correlationId: 'hoplon-session-2',
          details: {
            from: 'snapshotted',
            attempted: 'applyEdits',
            detail: 'patch hunk 0 for "src/foo.ts": search anchor not found',
            recoveryClass: 'refresh_and_recompute',
            file: 'src/foo.ts',
            changeKind: 'patch',
            failedChangeIndex: 0,
            failedHunkIndex: 0,
          },
        },
      },
      409,
    );
    const client = createRemoteHoplonSessionClient({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.applyEdits({
        sessionId: 'hoplon-session-2',
        proposedChanges: [
          {
            kind: 'patch',
            file: 'src/foo.ts',
            hunks: [{ search: 'missing', replace: 'next' }],
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'SessionError',
      kind: 'patch_not_applicable',
      correlationId: 'hoplon-session-2',
      details: {
        recoveryClass: 'refresh_and_recompute',
        file: 'src/foo.ts',
        changeKind: 'patch',
        failedChangeIndex: 0,
        failedHunkIndex: 0,
      },
    } satisfies Partial<SessionError>);
  });

  it('reconstructs SessionTransportError from session_not_found envelopes', async () => {
    const fetchMock = mockJsonResponse(
      {
        error: {
          class: 'SessionTransportError',
          kind: 'session_not_found',
          message: 'session not found: ghost-session',
          correlationId: 'ghost-session',
        },
      },
      404,
    );
    const client = createRemoteHoplonSessionClient({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.audit({ sessionId: 'ghost-session' })).rejects.toMatchObject({
      name: 'SessionTransportError',
      kind: 'session_not_found',
      sessionId: 'ghost-session',
    } satisfies Partial<SessionTransportError>);
  });

  it('serializes stageContent() and parses the typed session response (t-076)', async () => {
    const fetchMock = mockJsonResponse({
      session: {
        sessionId: 'hoplon-session-stage',
        projectId: 'proj-1',
        runId: 'run-1',
        correlationId: 'corr-1',
        createdAtMs: 2,
      },
      state: 'snapshotted',
      historyLength: 3,
      data: {
        stagingKey: 'k-1',
        chunks: 1,
        bytesStaged: 9,
        complete: true,
        sha256: 'a'.repeat(64),
      },
    });
    const client = createRemoteHoplonSessionClient({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await client.stageContent({
      sessionId: 'hoplon-session-stage',
      stagingKey: 'k-1',
      seq: 0,
      chunk: 'cGF5bG9hZC4=',
      isFinal: true,
      expectedTotalSha256: 'a'.repeat(64),
      expectedTotalByteLength: 9,
    });

    expect(result.state).toBe('snapshotted');
    expect(result.data).toEqual({
      stagingKey: 'k-1',
      chunks: 1,
      bytesStaged: 9,
      complete: true,
      sha256: 'a'.repeat(64),
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/session/stageContent`);
    const body = JSON.parse(init.body as string) as {
      stagingKey: string;
      seq: number;
      chunk: string;
      isFinal: boolean;
      expectedTotalSha256: string;
    };
    expect(body.stagingKey).toBe('k-1');
    expect(body.seq).toBe(0);
    expect(body.isFinal).toBe(true);
    expect(body.chunk).toBe('cGF5bG9hZC4=');
    expect(body.expectedTotalSha256).toBe('a'.repeat(64));
  });

  it('still translates generic Hoplon error envelopes on session routes', async () => {
    const fetchMock = mockJsonResponse(
      {
        error: {
          class: 'AdapterError',
          kind: 'fs_write_failed',
          message: 'adapter write failed',
          engineId: 'remote',
          correlationId: 'hoplon-session-3',
        },
      },
      503,
    );
    const client = createRemoteHoplonSessionClient({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(client.revert({ sessionId: 'hoplon-session-3' })).rejects.toBeInstanceOf(
      AdapterError,
    );
  });
});
