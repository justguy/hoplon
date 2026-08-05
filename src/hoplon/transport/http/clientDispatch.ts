import type { z } from 'zod';

import { deserializeResponse, serializeRequest, TransportError } from '../types.js';
import {
  HttpErrorEnvelopeSchema,
  translateHoplonServerError,
} from './errorEnvelope.js';

export type FetchFn = typeof globalThis.fetch;

export interface RemoteClientResolvedOptions {
  baseUrl: string;
  engineId: string;
  authToken: string | undefined;
  fetchImpl: FetchFn | undefined;
}

export interface RemoteClientContext {
  readonly resolved: RemoteClientResolvedOptions;
  post<T>(
    op: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reqSchema: z.ZodType<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resSchema: z.ZodType<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reqBody: any,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<T>;
  get<T>(
    op: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resSchema: z.ZodType<any>,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<T>;
}

async function readResponseBody(
  response: Response,
  op: string,
  opts: RemoteClientResolvedOptions,
  correlationId: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new TransportError(
      {
        kind: 'stream_interrupted',
        engineId: opts.engineId,
        correlationId,
        cause,
      },
      `Response body read failed for ${op}`,
    );
  }
}

function throwResponseError(
  response: Response,
  rawBody: string,
  op: string,
  opts: RemoteClientResolvedOptions,
  correlationId: string,
): never {
  if (response.status === 401 || response.status === 403) {
    throw new TransportError(
      { kind: 'auth_failed', engineId: opts.engineId, correlationId },
      `HTTP ${response.status} from ${op}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new TransportError(
      { kind: 'malformed_response', engineId: opts.engineId, correlationId },
      `HTTP ${response.status} from ${op}: non-JSON error body`,
    );
  }

  const envelopeResult = HttpErrorEnvelopeSchema.safeParse(parsed);
  if (envelopeResult.success) {
    throw translateHoplonServerError(envelopeResult.data.error);
  }
  throw new TransportError(
    { kind: 'malformed_response', engineId: opts.engineId, correlationId },
    `HTTP ${response.status} from ${op}: unrecognized error envelope`,
  );
}

async function fetchOrThrow(
  op: string,
  opts: RemoteClientResolvedOptions,
  init: RequestInit,
  signal: AbortSignal | undefined,
  correlationId: string,
): Promise<Response> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  try {
    return await fetchFn(`${opts.baseUrl}/${op}`, init);
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === 'AbortError' || signal?.aborted === true)
    ) {
      throw new TransportError(
        { kind: 'timeout', engineId: opts.engineId, correlationId, cause },
        `Request to ${op} aborted`,
      );
    }
    throw new TransportError(
      {
        kind: 'connection_refused',
        engineId: opts.engineId,
        correlationId,
        cause,
      },
      `Connection refused reaching ${opts.baseUrl}/${op}`,
    );
  }
}

export function createRemoteClientContext(
  resolved: RemoteClientResolvedOptions,
): RemoteClientContext {
  return {
    resolved,
    async post<T>(
      op: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reqSchema: z.ZodType<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resSchema: z.ZodType<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reqBody: any,
      signal: AbortSignal | undefined,
      correlationId: string,
    ) {
      const ctx = { correlationId, engineId: resolved.engineId };
      const wireBody = serializeRequest(reqSchema, reqBody, ctx);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (resolved.authToken !== undefined) {
        headers['Authorization'] = `Bearer ${resolved.authToken}`;
      }
      const response = await fetchOrThrow(
        op,
        resolved,
        { method: 'POST', headers, body: wireBody, signal: signal ?? null },
        signal,
        correlationId,
      );
      const rawBody = await readResponseBody(response, op, resolved, correlationId);
      if (!response.ok) throwResponseError(response, rawBody, op, resolved, correlationId);
      return deserializeResponse(resSchema, rawBody, ctx) as T;
    },
    async get<T>(
      op: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resSchema: z.ZodType<any>,
      signal: AbortSignal | undefined,
      correlationId: string,
    ) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (resolved.authToken !== undefined) {
        headers['Authorization'] = `Bearer ${resolved.authToken}`;
      }
      const response = await fetchOrThrow(
        op,
        resolved,
        { method: 'GET', headers, signal: signal ?? null },
        signal,
        correlationId,
      );
      const rawBody = await readResponseBody(response, op, resolved, correlationId);
      if (!response.ok) throwResponseError(response, rawBody, op, resolved, correlationId);
      return deserializeResponse(
        resSchema,
        rawBody,
        { correlationId, engineId: resolved.engineId },
      ) as T;
    },
  };
}
