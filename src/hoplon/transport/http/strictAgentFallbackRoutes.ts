/**
 * strictAgentFallbackRoutes.ts - HTTP fail-closed handling for hidden
 * strict-agent compatibility routes.
 */

import type { FastifyInstance } from 'fastify';

import {
  strictAgentFallbackHttpResponse,
  strictAgentHiddenHttpSurface,
} from '../strictAgentFallback.js';

export function registerStrictAgentFallbackNotFound(
  server: FastifyInstance,
): void {
  server.setNotFoundHandler(async (req, reply) => {
    const surface = strictAgentHiddenHttpSurface({
      method: req.method,
      url: req.url,
    });
    if (surface !== null) {
      const { status, body } = strictAgentFallbackHttpResponse({
        kind: 'strict_agent_unsupported_route',
        correlationId: 'http-server',
        surface,
      });
      await reply.status(status).send(body);
      return;
    }
    await reply.status(404).send({
      error: {
        class: 'RouteNotFound',
        kind: 'route_not_found',
        message: 'Route not found',
        correlationId: 'http-server',
      },
    });
  });
}
