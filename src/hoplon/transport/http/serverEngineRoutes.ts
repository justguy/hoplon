import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { EngineDispatcher } from '../dispatcher.js';
import {
  isHttpEngineMethodAllowedForAgentProfile,
} from '../agentToolProfile.js';
import type { AgentToolProfile } from '../agentToolProfile.js';
import {
  assertStrictSemanticEngineContext,
  strictEngineCheckFromBody,
} from '../strictEngagementCheck.js';
import {
  verifyStrictEngagementAccess,
} from '../strictEngagementGate.js';
import type { StrictEngagementGateDeps } from '../strictEngagementGate.js';
import { assertStrictAgentFilePolicy } from '../strictAgentFilePolicy.js';
import { toHttpErrorEnvelope } from './serverErrors.js';

interface EngineRouteOptions {
  server: FastifyInstance;
  dispatcher: EngineDispatcher;
  agentToolProfile?: AgentToolProfile;
  strictEngagementGate?: StrictEngagementGateDeps;
}

export function registerEngineHttpRoutes(opts: EngineRouteOptions): void {
  const { server, dispatcher } = opts;
  if (isHttpEngineMethodAllowedForAgentProfile(opts.agentToolProfile, 'health')) {
    registerBodylessRoute(server, dispatcher, 'GET', 'health');
  }
  if (isHttpEngineMethodAllowedForAgentProfile(opts.agentToolProfile, 'reconcile')) {
    registerBodylessRoute(server, dispatcher, 'POST', 'reconcile');
  }

  for (const op of dispatcher.operations) {
    if (!op.hasRequestBody) continue;
    const method = op.method;
    if (!isHttpEngineMethodAllowedForAgentProfile(opts.agentToolProfile, method)) {
      continue;
    }
    server.post(`/${method}`, async (req, reply) => {
      await handlePost(dispatcher, method, req, reply, opts.strictEngagementGate);
    });
  }
}

function registerBodylessRoute(
  server: FastifyInstance,
  dispatcher: EngineDispatcher,
  verb: 'GET' | 'POST',
  method: 'health' | 'reconcile',
): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await dispatcher.invoke({
        method,
        signal: makeRequestSignal(req, reply),
        engineId: 'http-server',
        correlationId: 'parse',
      });
      await reply.status(200).send(result);
    } catch (err) {
      const { status, body } = toHttpErrorEnvelope(err);
      await reply.status(status).send(body);
    }
  };
  if (verb === 'GET') server.get(`/${method}`, handler);
  else server.post(`/${method}`, handler);
}

function makeRequestSignal(
  req: FastifyRequest,
  reply: FastifyReply,
): AbortSignal {
  const controller = new AbortController();
  const socket = req.raw.socket;
  if (!socket) return controller.signal;
  const cleanup = () => {
    socket.off('close', onClose);
    reply.raw.off('finish', cleanup);
  };
  const onClose = () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
      return;
    }
    cleanup();
  };
  socket.on('close', onClose);
  reply.raw.once('finish', cleanup);
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
}

async function handlePost(
  dispatcher: EngineDispatcher,
  method: string,
  req: FastifyRequest,
  reply: FastifyReply,
  strictEngagementGate?: StrictEngagementGateDeps,
): Promise<void> {
  const signal = makeRequestSignal(req, reply);
  try {
    const strictCheck = strictEngineCheckFromBody(method, req.body);
    if (strictCheck && strictEngagementGate) {
      await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
      assertStrictAgentFilePolicy(method, req.body);
    } else if (strictEngagementGate) {
      assertStrictSemanticEngineContext(method, req.body);
    }
    const result = await dispatcher.invoke({
      method,
      body: req.body,
      signal,
      engineId: 'http-server',
      correlationId: 'parse',
    });
    await reply.status(200).send(result);
  } catch (err) {
    const { status, body } = toHttpErrorEnvelope(err);
    await reply.status(status).send(body);
  }
}
