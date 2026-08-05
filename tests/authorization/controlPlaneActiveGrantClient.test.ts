import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneActiveGrantClient } from '../../src/hoplon/authorization/controlPlaneActiveGrantClient.js';
import type { ActiveGrant } from '../../src/hoplon/authorization/activeGrantClient.js';

type MockFetch = ReturnType<typeof vi.fn>;

const BASE_URL = 'https://control-plane.example.test';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function activeGrant(overrides: Partial<ActiveGrant> = {}): ActiveGrant {
  return {
    grantId: 'grant_789',
    escalationRequestId: 'esc_123',
    status: 'active',
    principalId: 'agent:swe_frontend',
    taskId: 'task_123',
    projectId: 'project-b',
    scope: {
      write: {
        paths: ['src/frontend/LoginForm.tsx'],
        branches: ['feature/login-fix'],
      },
      lock: {
        paths: ['src/frontend/LoginForm.tsx'],
        branches: ['feature/login-fix'],
      },
    },
    expiresAt: '2026-05-03T22:00:00.000Z',
    ...overrides,
  };
}

function makeClient(fetchMock: MockFetch): ControlPlaneActiveGrantClient {
  return new ControlPlaneActiveGrantClient({
    baseUrl: BASE_URL,
    authorization: 'Bearer s2s-token',
    serviceId: 'service:hoplon',
    traceId: () => 'trace-hopauth-011',
    fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
  });
}

describe('ControlPlaneActiveGrantClient', () => {
  it('fetches active grants with the trusted S2S header contract', async () => {
    const grant = activeGrant();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { activeGrants: [grant] },
        traceId: 'trace-hopauth-011',
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listActiveGrants({
      principalId: 'agent:swe_frontend',
      taskId: 'task_123',
      projectId: 'project-b',
    });

    expect(result).toEqual({ kind: 'ok', grants: [grant] });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/control-plane/escalation-grants/active');
    expect(url.searchParams.get('principalId')).toBe('agent:swe_frontend');
    expect(url.searchParams.get('taskId')).toBe('task_123');
    expect(url.searchParams.get('projectId')).toBe('project-b');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer s2s-token',
      'x-hoplon-service-id': 'service:hoplon',
      'x-trace-id': 'trace-hopauth-011',
    });
  });

  it('returns unavailable for a Control Plane error envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'not a trusted service' },
          traceId: 'trace-hopauth-011',
        },
        403,
      ),
    );
    const client = makeClient(fetchMock);

    const result = await client.listActiveGrants({
      principalId: 'agent:swe_frontend',
      taskId: 'task_123',
      projectId: 'project-b',
    });

    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('control_plane_error:403:not a trusted service');
    }
  });

  it('returns unavailable when the active-grant response is malformed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          activeGrants: [
            {
              ...activeGrant(),
              scope: { write: { paths: [], branches: ['feature/login-fix'] } },
            },
          ],
        },
        traceId: 'trace-hopauth-011',
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listActiveGrants({
      principalId: 'agent:swe_frontend',
      taskId: 'task_123',
      projectId: 'project-b',
    });

    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('malformed_response');
    }
  });

  it('returns unavailable instead of throwing on network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient(fetchMock);

    const result = await client.listActiveGrants({
      principalId: 'agent:swe_frontend',
      taskId: 'task_123',
      projectId: 'project-b',
    });

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'network_error: ECONNREFUSED',
    });
  });
});
