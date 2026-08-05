/**
 * transport/http/projectsRoutes.ts — HTTP routes for t-080 multi-project
 * registration management.
 *
 * The engine-RPC and session HTTP routes are unchanged: they continue to
 * resolve an incoming body's `projectId` through the optional
 * `projectRouter` on the server. This file adds a small *management*
 * surface (list / register / unregister / select / show) so remote hosts
 * can administer the same registered-project catalog that the CLI
 * exposes via `hoplon project ...`.
 *
 * Routes are registered under `/projects` and are opt-in: the HTTP server
 * mounts them only when a launcher root is supplied (so the server knows
 * which `.hoplon/projects.json` to read). When omitted, the HTTP server
 * behaves identically to pre-t-080.
 *
 * Safety posture:
 *   - Registration validates that fsRoot exists and is a directory.
 *   - Unregistration never deletes the target project's own `.hoplon/`
 *     state on disk — the operator decides cleanup.
 *   - These routes do NOT accept arbitrary paths from the network as
 *     read/write targets; they only mutate the registry. Reads / edits
 *     still go through the engine-RPC dispatcher and are routed by
 *     registered projectId — there is no path-escape hatch.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  openLauncherProjects,
  LauncherProjectsError,
} from '../../launcher/projects.js';
import { buildProjectsReport } from '../../launcher/projectsReport.js';
import { openEngagementStore } from '../../launcher/engagementStore.js';
import type { EngagementStore } from '../../launcher/engagementStore.js';
import { registerProjectsLifecycleHttpRoutes } from './projectsLifecycleRoutes.js';
import {
  createNoopPolicyAuditSink,
  type PolicyAuditContext,
  type PolicyAuditSink,
} from '../policyAuditSink.js';
import { defaultPolicyAuditContext } from './policyAuditContext.js';
import { registerHandshakeHttpRoute } from './projectsHandshakeRoute.js';
import { registerProjectsPolicyHttpRoute } from './projectsPolicyRoute.js';
import { registerProjectsPolicyAuditHttpRoute } from './projectsPolicyAuditRoute.js';
import type { SnapshotStore } from '../../adapters/snapshotStore.js';
import {
  isHttpProjectOpAllowedForAgentProfile,
  type AgentToolProfile,
  type HttpProjectOp,
} from '../agentToolProfile.js';
import {
  statusForProjectRouteError,
  toProjectRouteError,
} from './projectsRouteErrors.js';

export interface RegisterProjectsRoutesOptions {
  server: FastifyInstance;
  /** Launcher root whose `.hoplon/projects.json` is served. */
  launcherRoot: string;
  /**
   * Optional engagement-token store override. When omitted, the route uses
   * the launcher-root-scoped in-memory default so HTTP/MCP/CLI handshakes
   * against the same launcher share one set of issued bindings. t-084 adds
   * revocation and cleanup over this store; durable storage remains a
   * future adapter concern.
   */
  engagementStore?: EngagementStore;
  /**
   * Optional t-088 policy-audit sink. When supplied, every handshake
   * attempt (grant or deny) emits a durable `POLICY_HANDSHAKE` row on
   * `hoplon_audit_log` via the shared sink. Lifecycle audit rows ride
   * on the same sink when `projectsLifecycleRoutes` is wired with it.
   * Absent → no policy audit is written (pre-t-088 behavior).
   */
  policyAuditSink?: PolicyAuditSink;
  /**
   * Context resolver for each handshake request. Called once per request
   * to produce the `{ projectId, runId, correlationId, snapshotId? }`
   * tuple that scopes the emitted audit row. When omitted, the route
   * derives the tuple from the request body's `projectId` plus generated
   * runId/correlationId so operators can still search by project — but
   * callers are expected to provide a resolver when they already have
   * caller-correlated ids upstream.
   */
  policyAuditContext?: (req: FastifyRequest) => PolicyAuditContext;
  /**
   * t-089 — snapshot store backing the bounded policy audit retrieval
   * route (`GET /projects/policy/audit`). When omitted, the retrieval
   * route is NOT registered (so a missing store cannot silently degrade
   * to "always empty" for operators). Reads only — never participates
   * in any access-control decision.
   */
  snapshotStore?: SnapshotStore;
  agentToolProfile?: AgentToolProfile;
  /**
   * T-146 — optional `AuthorizationAdapter` override forwarded to the
   * `/projects/handshake` route. When omitted, the route falls back to
   * the default `StaticAuthorizationAdapter` built from the project's
   * folder policy on each request. **OPA is never the default**.
   */
  authorizationAdapter?: import('../../authorization/authorizationAdapter.js').AuthorizationAdapter;
}

export function registerProjectsHttpRoutes(
  opts: RegisterProjectsRoutesOptions,
): void {
  const { server, launcherRoot } = opts;
  const engagementStore =
    opts.engagementStore ?? openEngagementStore(launcherRoot);
  const policyAuditSink = opts.policyAuditSink ?? createNoopPolicyAuditSink();
  const resolveAuditContext =
    opts.policyAuditContext ?? defaultPolicyAuditContext;
  const allow = (op: HttpProjectOp) =>
    isHttpProjectOpAllowedForAgentProfile(opts.agentToolProfile, op);

  if (allow('list')) {
    server.get('/projects', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const report = buildProjectsReport(launcherRoot, { engagementStore });
        await reply.status(200).send(report);
      } catch (err) {
        await reply.status(500).send(toProjectRouteError(err));
      }
    });
  }

  if (allow('register')) {
    server.post(
      '/projects/register',
      async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const manager = openLauncherProjects(launcherRoot);
          const body = req.body as Record<string, unknown>;
          const projectId = requireString(body, 'projectId');
          const fsRoot = requireString(body, 'fsRoot');
          const input: Parameters<typeof manager.register>[0] = {
            projectId,
            fsRoot,
          };
          if (typeof body['label'] === 'string') input.label = body['label'];
          if (typeof body['engineId'] === 'string')
            input.engineId = body['engineId'];
          if (typeof body['gitRepoDir'] === 'string')
            input.gitRepoDir = body['gitRepoDir'];
          if (typeof body['grammarsDir'] === 'string')
            input.grammarsDir = body['grammarsDir'];
          if (typeof body['dbPath'] === 'string') input.dbPath = body['dbPath'];
          const record = manager.register(input);
          await reply.status(200).send(record);
        } catch (err) {
          await reply.status(statusForProjectRouteError(err)).send(toProjectRouteError(err));
        }
      },
    );
  }

  if (allow('unregister')) {
    server.post(
      '/projects/unregister',
      async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const manager = openLauncherProjects(launcherRoot);
          const body = req.body as Record<string, unknown>;
          const projectId = requireString(body, 'projectId');
          manager.unregister(projectId);
          await reply.status(200).send({ unregistered: projectId });
        } catch (err) {
          await reply.status(statusForProjectRouteError(err)).send(toProjectRouteError(err));
        }
      },
    );
  }

  if (allow('select')) {
    server.post(
      '/projects/select',
      async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const manager = openLauncherProjects(launcherRoot);
          const body = req.body as Record<string, unknown>;
          const projectId = requireString(body, 'projectId');
          manager.setActive(projectId);
          await reply.status(200).send({ active: projectId });
        } catch (err) {
          await reply.status(statusForProjectRouteError(err)).send(toProjectRouteError(err));
        }
      },
    );
  }

  if (allow('clearActive')) {
    server.post(
      '/projects/clear-active',
      async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
          const manager = openLauncherProjects(launcherRoot);
          manager.clearActive();
          await reply.status(200).send({ cleared: true });
        } catch (err) {
          await reply.status(statusForProjectRouteError(err)).send(toProjectRouteError(err));
        }
      },
    );
  }

  if (allow('renew') || allow('revoke') || allow('prune')) {
    registerProjectsLifecycleHttpRoutes({
      server,
      launcherRoot,
      store: engagementStore,
      policyAuditSink,
      policyAuditContext: resolveAuditContext,
    });
  }

  if (allow('handshake')) {
    registerHandshakeHttpRoute({
      server,
      launcherRoot,
      engagementStore,
      policyAuditSink,
      policyAuditContext: resolveAuditContext,
      toError: toProjectRouteError,
      statusForError: statusForProjectRouteError,
      ...(opts.authorizationAdapter !== undefined
        ? { authorizationAdapter: opts.authorizationAdapter }
        : {}),
    });
  }

  if (allow('policySummary')) {
    registerProjectsPolicyHttpRoute({ server, launcherRoot, engagementStore });
  }

  if (opts.snapshotStore !== undefined && allow('policyAudit')) {
    registerProjectsPolicyAuditHttpRoute({
      server,
      launcherRoot,
      snapshotStore: opts.snapshotStore,
    });
  }
}

function requireString(
  body: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = body?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new LauncherProjectsError(
      'registry_error',
      `Missing or invalid '${key}' in request body`,
    );
  }
  return v;
}
