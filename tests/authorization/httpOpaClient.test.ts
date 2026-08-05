import { describe, expect, it, vi } from 'vitest';

import { HttpOpaClient } from '../../src/hoplon/authorization/httpOpaClient.js';

type MockFetch = ReturnType<typeof vi.fn>;

const BASE_URL = 'http://127.0.0.1:8181';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeClient(fetchMock: MockFetch): HttpOpaClient {
  return new HttpOpaClient({
    baseUrl: BASE_URL,
    authorization: 'Bearer opa-token',
    headers: { 'x-trace-id': 'trace-hopauth-011' },
    fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
  });
}

describe('HttpOpaClient', () => {
  it('posts OPA data-api input and returns the result payload', async () => {
    const decision = {
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { read: { paths: ['**'], branches: ['**'] } },
      expiresInSeconds: 900,
      decisionId: 'opa_decision_001',
      policyVersion: 'hoplon_policy_bundle_2026_05_03',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: decision }));
    const client = makeClient(fetchMock);
    const input = {
      principal: { id: 'agent:swe_frontend' },
      activeGrants: [],
    };

    const result = await client.evaluate('/v1/data/hoplon/authz/decision', input);

    expect(result).toEqual({ kind: 'ok', raw: decision });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${BASE_URL}/v1/data/hoplon/authz/decision`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer opa-token',
      'Content-Type': 'application/json',
      'x-trace-id': 'trace-hopauth-011',
    });
    expect(JSON.parse(init.body as string)).toEqual({ input });
  });

  it('returns an error envelope for non-2xx OPA responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 'internal_error', message: 'bundle failed' }, 500),
    );
    const client = makeClient(fetchMock);

    const result = await client.evaluate('/v1/data/hoplon/authz/decision', {});

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('http_500');
      expect(result.reason).toContain('bundle failed');
    }
  });

  it('returns an error when OPA omits the result field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ decision: 'wrong' }));
    const client = makeClient(fetchMock);

    const result = await client.evaluate('/v1/data/hoplon/authz/decision', {});

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('malformed_response');
    }
  });

  it('returns an error instead of throwing on network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient(fetchMock);

    const result = await client.evaluate('/v1/data/hoplon/authz/decision', {});

    expect(result).toEqual({
      kind: 'error',
      reason: 'network_error: ECONNREFUSED',
    });
  });
});
