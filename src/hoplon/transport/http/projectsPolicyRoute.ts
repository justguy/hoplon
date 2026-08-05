/**
 * transport/http/projectsPolicyRoute.ts — `GET /projects/policy/summary`
 * route for the t-086 operator-visible policy lane.
 *
 * Read-only. Returns a content-safe summary of one registered project's
 * folder-policy shape (default access, rule + principal counts, TTL)
 * and the runtime engagement state (active counts, soonest expiry).
 * Never exposes folder paths, principal labels, or token bytes; never
 * widens any agent-facing access path.
 *
 * Wired in from `projectsRoutes.ts` so the HTTP server picks it up only
 * when a launcher root is supplied (same opt-in posture as `/projects`).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import {
  buildProjectsReport,
  type LauncherEngagementStateSummary,
  type LauncherProjectPolicySummary,
} from '../../launcher/projectsReport.js';
import type { EngagementStore } from '../../launcher/engagementStore.js';
import {
  buildProjectPolicySurfaceGuidance,
  buildProjectResolutionGuidance,
  type ProjectPolicySurfaceGuidance,
} from '../../util/projectGuidance.js';

export interface ProjectPolicySummaryHttpResponse {
  projectId: string;
  label: string;
  registeredAtIso: string;
  policy: LauncherProjectPolicySummary;
  engagementState: LauncherEngagementStateSummary;
  guidance: ProjectPolicySurfaceGuidance;
}

export interface RegisterPolicyRouteOptions {
  server: FastifyInstance;
  launcherRoot: string;
  engagementStore: EngagementStore;
}

export function registerProjectsPolicyHttpRoute(
  opts: RegisterPolicyRouteOptions,
): void {
  const { server, launcherRoot, engagementStore } = opts;

  server.get(
    '/projects/policy/summary',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const projectId = readProjectIdFromQuery(req);
      if (!projectId) {
        await reply.status(400).send({
          error: {
            class: 'PolicySummaryError',
            kind: 'invalid_request',
            message: "missing or invalid 'projectId' query parameter",
          },
        });
        return;
      }
      try {
        const report = buildProjectsReport(launcherRoot, { engagementStore });
        const entry = report.registered.find((p) => p.projectId === projectId);
        if (!entry) {
          const registeredProjectIds = report.registered.map(
            (p) => p.projectId,
          );
          await reply.status(404).send({
            error: {
              class: 'PolicySummaryError',
              kind: 'unknown_project',
              message: `No project registered with id '${projectId}'`,
              ...buildProjectResolutionGuidance({
                kind: 'unknown_project',
                requestedProjectId: projectId,
                registeredProjectIds,
              }),
              guidance: buildProjectPolicySurfaceGuidance({
                hasFolderPolicy: false,
              }),
            },
          });
          return;
        }
        const body: ProjectPolicySummaryHttpResponse = {
          projectId: entry.projectId,
          label: entry.label,
          registeredAtIso: entry.registeredAtIso,
          policy: entry.policy,
          engagementState: entry.engagementState,
          guidance: buildProjectPolicySurfaceGuidance({
            hasFolderPolicy: entry.policy.folderPolicy !== undefined,
          }),
        };
        await reply.status(200).send(body);
      } catch (err) {
        await reply.status(500).send({
          error: {
            class: 'PolicySummaryError',
            kind: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
  );
}

function readProjectIdFromQuery(req: FastifyRequest): string | null {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const v = query['projectId'];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}
