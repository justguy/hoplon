import type { z } from 'zod';

import { SessionError } from '../../session/errors.js';
import type { SessionErrorDetails } from '../../session/errors.js';
import { SessionTransportError } from '../../session/transport.js';
import { AnySessionErrorEnvelopeSchema } from '../../session/transportContracts.js';
import { deserializeResponse, serializeRequest, TransportError } from '../types.js';
import type { TransportErrorKind } from '../types.js';
import type { FetchFn } from './clientDispatch.js';
import { HttpErrorEnvelopeSchema, translateHoplonServerError } from './errorEnvelope.js';
import type { RemoteHoplonSessionClientOptions } from './sessionClientTypes.js';

export interface ResolvedSessionClientOptions {
  baseUrl: string;
  authToken: string | undefined;
  fetchImpl: FetchFn | undefined;
  engineId: string;
}

export function resolveSessionClientOptions(
  opts: RemoteHoplonSessionClientOptions,
): ResolvedSessionClientOptions {
  return {
    baseUrl: opts.baseUrl.replace(/\/+$/, ''),
    authToken: opts.authToken,
    fetchImpl: opts.fetchImpl,
    engineId: opts.engineId ?? 'remote-session-client',
  };
}

function buildHeaders(opts: ResolvedSessionClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (opts.authToken !== undefined) {
    headers['Authorization'] = `Bearer ${opts.authToken}`;
  }
  return headers;
}

function translateNetworkError(
  op: string,
  cause: unknown,
  signal: AbortSignal | undefined,
  opts: ResolvedSessionClientOptions,
  correlationId: string,
): never {
  const kind: TransportErrorKind =
    cause instanceof Error && (cause.name === 'AbortError' || signal?.aborted === true)
      ? 'timeout'
      : 'connection_refused';
  throw new TransportError(
    { kind, engineId: opts.engineId, correlationId, cause },
    kind === 'timeout'
      ? `Request to session ${op} aborted`
      : `Connection refused reaching ${opts.baseUrl}/session/${op}`,
  );
}

function translateSessionServerError(
  parsed: { error: { class: string; kind: string; message: string; correlationId: string; details?: unknown } },
  opts: ResolvedSessionClientOptions,
): never {
  if (parsed.error.class === 'SessionTransportError') {
    throw new SessionTransportError(
      parsed.error.kind as 'invalid_request' | 'session_not_found',
      parsed.error.message,
      parsed.error.correlationId === 'unknown' ? undefined : parsed.error.correlationId,
    );
  }
  const details = parsed.error.details;
  if (details === undefined || typeof details !== 'object' || details === null) {
    throw new TransportError(
      {
        kind: 'malformed_response',
        engineId: opts.engineId,
        correlationId: parsed.error.correlationId,
      },
      'SessionError envelope missing details payload',
    );
  }
  const { from, attempted, detail, ...rest } = details as Record<string, unknown>;
  throw new SessionError(
    {
      kind: parsed.error.kind as SessionError['kind'],
      from: typeof from === 'string' ? from : 'unknown',
      attempted: typeof attempted === 'string' ? attempted : 'unknown',
      ...(typeof detail === 'string' ? { detail } : {}),
      details: rest as SessionErrorDetails,
      correlationId: parsed.error.correlationId,
    },
    parsed.error.message,
  );
}

export async function dispatchSessionRequest<TReq, TRes>(
  method: 'GET' | 'POST',
  op: string,
  req: TReq,
  reqSchema: z.ZodTypeAny | null,
  resSchema: z.ZodTypeAny,
  opts: ResolvedSessionClientOptions,
  signal: AbortSignal | undefined,
  correlationId: string,
): Promise<TRes> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const requestInit: RequestInit = {
    method,
    headers: buildHeaders(opts),
    signal: signal ?? null,
  };
  if (method === 'POST') {
    requestInit.body = serializeRequest(
      reqSchema as z.ZodType<TReq>,
      req,
      { correlationId, engineId: opts.engineId },
    );
  }

  let response: Response;
  try {
    response = await fetchFn(`${opts.baseUrl}/session/${op}`, requestInit);
  } catch (cause) {
    translateNetworkError(op, cause, signal, opts, correlationId);
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (cause) {
    throw new TransportError(
      {
        kind: 'stream_interrupted',
        engineId: opts.engineId,
        correlationId,
        cause,
      },
      `Response body read failed for session ${op}`,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TransportError(
        { kind: 'auth_failed', engineId: opts.engineId, correlationId },
        `HTTP ${response.status} from session ${op}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new TransportError(
        { kind: 'malformed_response', engineId: opts.engineId, correlationId },
        `HTTP ${response.status} from session ${op}: non-JSON error body`,
      );
    }
    const sessionEnvelope = AnySessionErrorEnvelopeSchema.safeParse(parsed);
    if (sessionEnvelope.success) translateSessionServerError(sessionEnvelope.data, opts);
    const hoplonEnvelope = HttpErrorEnvelopeSchema.safeParse(parsed);
    if (hoplonEnvelope.success) {
      throw translateHoplonServerError(hoplonEnvelope.data.error);
    }
    throw new TransportError(
      { kind: 'malformed_response', engineId: opts.engineId, correlationId },
      `HTTP ${response.status} from session ${op}: unrecognized error envelope`,
    );
  }

  return deserializeResponse(resSchema, rawBody, {
    correlationId,
    engineId: opts.engineId,
  });
}
