/**
 * transport/http/projectsLifecycleRoutes.ts — HTTP routes for the
 * engagement-token lifecycle (t-084): renewal, revocation, and
 * expired-token cleanup.
 *
 * Routes live in their own file so `projectsRoutes.ts` stays under the
 * 300-line cap. They share the launcher-root-scoped engagement store
 * with the `/projects/handshake` route; every transport operates on
 * the same bindings rather than maintaining per-transport caches.
 *
 * Transport contract:
 *   - `POST /projects/renew  { token }` → 200 with renewal envelope,
 *     or 401 with typed `reauth_required` reason.
 *   - `POST /projects/revoke { token }` → 200 on revoke, 404 when the
 *     token is not known (idempotent observable).
 *   - `POST /projects/prune`           → 200 with `{ removed }` count.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { openLauncherProjects } from '../../launcher/projects.js';
import {
  pruneExpiredTokens,
  renewEngagementToken,
  revokeEngagementToken,
} from '../../launcher/engagementLifecycle.js';
import type { EngagementStore } from '../../launcher/engagementStore.js';
import {
  createNoopPolicyAuditSink,
  type PolicyAuditContext,
  type PolicyAuditSink,
} from '../policyAuditSink.js';
import {
  defaultPolicyAuditContext,
  fallbackAuditContext,
} from './policyAuditContext.js';

export interface RegisterProjectsLifecycleRoutesOptions {
  server: FastifyInstance;
  launcherRoot: string;
  store: EngagementStore;
  /** t-088 policy audit sink — noop by default. */
  policyAuditSink?: PolicyAuditSink;
  /** Request → audit context resolver (default: projectId-derived). */
  policyAuditContext?: (req: FastifyRequest) => PolicyAuditContext;
}

export function registerProjectsLifecycleHttpRoutes(
  opts: RegisterProjectsLifecycleRoutesOptions,
): void {
  const { server, launcherRoot, store } = opts;
  const policyAuditSink = opts.policyAuditSink ?? createNoopPolicyAuditSink();
  const resolveAuditContext =
    opts.policyAuditContext ?? defaultPolicyAuditContext;

  server.post(
    '/projects/renew',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const startMs = Date.now();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = body['token'];
      if (typeof token !== 'string' || token.length === 0) {
        await reply.status(400).send(errorBody('invalid_request', 'Missing or invalid token'));
        return;
      }
      const manager = openLauncherProjects(launcherRoot);
      const outcome = renewEngagementToken(store, token, {
        registry: manager.registry,
        store,
      });
      const ctx =
        outcome.kind === 'renewed'
          ? resolveAuditContext(req)
          : fallbackAuditContext(req, 'unknown');
      const ctxForAudit: PolicyAuditContext =
        outcome.kind === 'renewed'
          ? { ...ctx, projectId: outcome.binding.projectId }
          : ctx;
      await policyAuditSink.recordRenew(ctxForAudit, outcome, Date.now() - startMs);
      if (outcome.kind === 'renewed') {
        await reply.status(200).send({
          kind: 'renewed',
          previousToken: outcome.previousToken,
          result: outcome.result,
        });
        return;
      }
      await reply
        .status(statusForReauthReason(outcome.reason))
        .send(errorBody('reauth_required', `renew rejected: ${outcome.reason}`, outcome.reason));
    },
  );

  server.post(
    '/projects/revoke',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const startMs = Date.now();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = body['token'];
      if (typeof token !== 'string' || token.length === 0) {
        await reply.status(400).send(errorBody('invalid_request', 'Missing or invalid token'));
        return;
      }
      const outcome = revokeEngagementToken(store, token);
      const fallbackCtx = fallbackAuditContext(req, 'unknown');
      const ctx =
        outcome.kind === 'revoked'
          ? { ...fallbackCtx, projectId: outcome.binding.projectId }
          : fallbackCtx;
      await policyAuditSink.recordRevoke(ctx, outcome, Date.now() - startMs);
      if (outcome.kind === 'revoked') {
        await reply.status(200).send({ kind: 'revoked' });
        return;
      }
      await reply
        .status(404)
        .send(errorBody('missing_token', 'No live binding for the supplied token'));
    },
  );

  server.post(
    '/projects/prune',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const report = pruneExpiredTokens(store, new Date());
      await reply.status(200).send({ kind: 'pruned', ...report });
    },
  );
}

function statusForReauthReason(reason: string): number {
  if (reason === 'invalid_request') return 400;
  if (reason === 'missing' || reason === 'expired') return 401;
  if (reason === 'unknown_project' || reason === 'no_folder_policy') return 409;
  if (reason === 'invalid_folder' || reason === 'unknown_principal') return 400;
  if (reason === 'policy_denied') return 403;
  return 401;
}

function errorBody(
  kind: string,
  message: string,
  reason?: string,
): {
  error: { class: string; kind: string; message: string; reason?: string };
} {
  const body: { class: string; kind: string; message: string; reason?: string } = {
    class: 'EngagementLifecycleError',
    kind,
    message,
  };
  if (reason !== undefined) body.reason = reason;
  return { error: body };
}
