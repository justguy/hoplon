/**
 * transport/http/serverAuth.ts — wiring for the HTTP transport's pluggable
 * auth registry (Finding hcr-003 / the T4 integration seam that auth.ts
 * documents but the server previously never invoked).
 *
 * Two responsibilities, both opt-in and both fail-closed only when the operator
 * has asked for the safe posture:
 *
 *  1. `registerHttpAuthHook` mounts a single global `onRequest` hook that runs
 *     the configured `AuthRegistry.runAuth()` on EVERY request — engine RPC,
 *     session, trace, projects, and health — before routing reaches a handler.
 *     A null result → HTTP 401 with the transport's typed error envelope.
 *     The hook is content-free (headers + path only) and never parses the
 *     request body, preserving H13.
 *
 *  2. `assertHostAuthPolicy` is the startup guard: binding to a non-loopback
 *     host with no auth configured is refused unless the caller passes the
 *     explicit `allowUnauthenticated` override. Loopback binds — and the
 *     no-host default — are unaffected, so today's behavior is preserved.
 *
 * Detecting a "real" (non-noop) middleware is not possible through the opaque
 * registry seam; like the gRPC sibling transport, "auth configured" means "an
 * `authRegistry` option was supplied".
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { EngineError } from '../../contracts/errors.js';
import type { AuthRegistry, AuthRequest } from './auth.js';

/** The only hosts treated as loopback (per hcr-003 fix contract). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
]);

/**
 * Typed 401 envelope. Mirrors the transport's `{ error: { class, kind, message,
 * correlationId } }` shape and reuses the gRPC sibling's `auth_failed`
 * convention, so the packaged remote client translates it back into a
 * `TransportError({ kind: 'auth_failed' })`. Carries no caller content (H13).
 */
const AUTH_401_ENVELOPE = {
  error: {
    class: 'TransportError',
    kind: 'auth_failed',
    message: 'Unauthenticated: request rejected by auth middleware',
    correlationId: 'unknown',
  },
} as const;

/** True iff `host` is exactly one of the documented loopback names. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

/**
 * Build the content-free `AuthRequest` (headers + path only) from a Fastify
 * request. The body is never read — auth decisions must not observe content.
 */
function toAuthRequest(req: FastifyRequest): AuthRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }
  const url = req.url;
  const q = url.indexOf('?');
  return { headers, path: q === -1 ? url : url.slice(0, q) };
}

/**
 * Mount the global auth hook on `server`. On every request it runs
 * `registry.runAuth`; a null result short-circuits the lifecycle with a 401
 * (typed envelope) before any route handler runs. A populated context lets the
 * request proceed unchanged.
 */
export function registerHttpAuthHook(
  server: FastifyInstance,
  registry: AuthRegistry,
): void {
  server.addHook('onRequest', async (req, reply) => {
    const ctx = await registry.runAuth(toAuthRequest(req));
    if (ctx === null) {
      await reply.status(401).send(AUTH_401_ENVELOPE);
      return reply;
    }
    return undefined;
  });
}

/**
 * Startup guard. Throws `EngineError('config_invalid')` when the server would
 * bind to a non-loopback host with no auth configured and no explicit
 * `allowUnauthenticated` override. Loopback binds and the no-host default
 * return without throwing — today's behavior is preserved exactly.
 */
export function assertHostAuthPolicy(params: {
  host: string | undefined;
  authConfigured: boolean;
  allowUnauthenticated: boolean;
}): void {
  const { host, authConfigured, allowUnauthenticated } = params;
  if (host === undefined) return;
  if (isLoopbackHost(host)) return;
  if (authConfigured || allowUnauthenticated) return;
  throw new EngineError(
    { kind: 'config_invalid', engineId: 'http-server', correlationId: 'startup' },
    `Refusing to start Hoplon HTTP server: host '${host}' is not loopback and no auth ` +
      'registry is configured. Bound beyond loopback the server would accept ' +
      'unauthenticated requests and register any readable directory as a project. ' +
      "Configure authentication via the 'authRegistry' option (createAuthRegistry + " +
      "registerAuthMiddleware), or pass 'allowUnauthenticated: true' to bind without " +
      'authentication (unsafe).',
  );
}
