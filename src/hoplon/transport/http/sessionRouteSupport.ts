import type { FastifyInstance, FastifyReply } from 'fastify';

import { SessionError, toSessionErrorTransportDetails } from '../../session/errors.js';
import type { SessionErrorTransportDetails } from '../../session/errors.js';
import type { SessionRegistry } from '../../session/registry.js';
import { SessionTransportError } from '../../session/transport.js';
import type { AgentToolProfile, HttpSessionOp } from '../agentToolProfile.js';
import type { StrictEngagementGateDeps } from '../strictEngagementGate.js';
import { enforceStrictSessionEngagement } from '../strictSessionEngagement.js';

export interface SessionHttpRoutesOptions {
  server: FastifyInstance;
  registry: SessionRegistry;
  toEngineErrorEnvelope: (err: unknown) => {
    status: number;
    body: {
      error: {
        class: string;
        kind: string;
        message: string;
        correlationId: string;
      };
    };
  };
  agentToolProfile?: AgentToolProfile;
  strictEngagementGate?: StrictEngagementGateDeps;
}

export function sessionTransportEnvelope(err: SessionTransportError): {
  status: number;
  body: {
    error: {
      class: string;
      kind: string;
      message: string;
      correlationId: string;
      guidance?: string;
    };
  };
} {
  const error: {
    class: string;
    kind: string;
    message: string;
    correlationId: string;
    guidance?: string;
  } = {
    class: 'SessionTransportError',
    kind: err.kind,
    message: err.message,
    correlationId: err.sessionId ?? 'unknown',
  };
  if (err.guidance !== undefined) error.guidance = err.guidance;
  return {
    status: err.kind === 'session_not_found' ? 404 : 400,
    body: { error },
  };
}

function readSessionId(rawBody: unknown): string | null {
  if (typeof rawBody !== 'object' || rawBody === null || !('sessionId' in rawBody)) {
    return null;
  }
  const { sessionId } = rawBody as { sessionId?: unknown };
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function sessionErrorEnvelope(err: SessionError, rawBody: unknown): {
  status: number;
  body: {
    error: {
      class: string;
      kind: string;
      message: string;
      correlationId: string;
      details: SessionErrorTransportDetails;
    };
  };
} {
  return {
    status: err.kind === 'session_closed' ? 410 : 409,
    body: {
      error: {
        class: 'SessionError',
        kind: err.kind,
        message: err.message,
        correlationId: err.correlationId ?? readSessionId(rawBody) ?? 'unknown',
        details: toSessionErrorTransportDetails(err),
      },
    },
  };
}

export async function runSessionRouteOp<T>(
  rawBody: unknown,
  reply: FastifyReply,
  opts: SessionHttpRoutesOptions,
  sessionOp: HttpSessionOp,
  op: () => Promise<T>,
): Promise<void> {
  try {
    await enforceStrictSessionEngagement({
      registry: opts.registry,
      op: sessionOp,
      rawBody,
      ...(opts.strictEngagementGate !== undefined
        ? { gate: opts.strictEngagementGate }
        : {}),
    });
    const result = await op();
    await reply.status(200).send(result);
  } catch (err) {
    if (err instanceof SessionTransportError) {
      const { status, body } = sessionTransportEnvelope(err);
      await reply.status(status).send(body);
      return;
    }
    if (err instanceof SessionError) {
      const { status, body } = sessionErrorEnvelope(err, rawBody);
      await reply.status(status).send(body);
      return;
    }
    const { status, body } = opts.toEngineErrorEnvelope(err);
    await reply.status(status).send(body);
  }
}
