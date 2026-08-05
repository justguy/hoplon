/**
 * transport/http/projectsPolicyAuditRoute.ts — `GET /projects/policy/audit`
 * route for the t-089 bounded policy audit retrieval surface.
 *
 * Read-only. Returns at most `limit` (default 50, hard max 200)
 * `PolicyAuditEntry` rows for the requested project, narrowed by the
 * optional folder / principal / outcome / reasonCode / since / until
 * query parameters. Always reverse-chronological
 * (`createdAt DESC, id DESC`).
 *
 * The route is wired only when the projects router is constructed with
 * a `snapshotStore`. When no store is wired, the route is omitted and
 * callers see a 404 — operators do not get a half-functional retrieval
 * surface that returns `[]` for everything.
 *
 * The handler is a thin transport adapter: it parses HTTP query
 * parameters into the discriminated `PolicyAuditQueryRequest` shape and
 * delegates to `queryPolicyAudit`. All bound enforcement, content-
 * safety projection, and ordering live in the launcher fn + adapter.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import {
  queryPolicyAudit,
  PolicyAuditQueryError,
} from '../../launcher/policyAuditQuery.js';
import type { PolicyAuditPrincipalFilter } from '../../contracts/policyAuditQuery.js';
import { openLauncherProjects } from '../../launcher/projects.js';
import type { SnapshotStore } from '../../adapters/snapshotStore.js';

export interface RegisterProjectsPolicyAuditRouteOptions {
  server: FastifyInstance;
  launcherRoot: string;
  snapshotStore: SnapshotStore;
}

interface RawQuery {
  projectId?: unknown;
  folder?: unknown;
  principalFilter?: unknown;
  principalId?: unknown;
  outcome?: unknown;
  reasonCode?: unknown;
  since?: unknown;
  until?: unknown;
  limit?: unknown;
}

class QueryParseError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'QueryParseError';
  }
}

export function registerProjectsPolicyAuditHttpRoute(
  opts: RegisterProjectsPolicyAuditRouteOptions,
): void {
  const { server, launcherRoot, snapshotStore } = opts;

  server.get(
    '/projects/policy/audit',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.query ?? {}) as RawQuery;
      let request: ReturnType<typeof normalizeQuery>;
      try {
        request = normalizeQuery(raw);
      } catch (err) {
        const status = err instanceof QueryParseError ? err.status : 400;
        await reply.status(status).send({
          error: {
            class: 'PolicyAuditQueryError',
            kind: 'invalid_request',
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }

      // Guard: the requested project must be registered. Returning 404
      // here keeps the surface honest — an empty `entries[]` for an
      // unknown project would otherwise be indistinguishable from "no
      // audit rows yet" and is a known operator-confusion mode.
      const manager = openLauncherProjects(launcherRoot);
      const list = manager.list();
      const found = list.find((p) => p.projectId === request.projectId);
      if (!found) {
        await reply.status(404).send({
          error: {
            class: 'PolicyAuditQueryError',
            kind: 'unknown_project',
            message: `No project registered with id '${request.projectId}'`,
          },
        });
        return;
      }

      try {
        const response = await queryPolicyAudit({
          store: snapshotStore,
          request,
        });
        await reply.status(200).send(response);
      } catch (err) {
        if (err instanceof PolicyAuditQueryError) {
          const status = err.kind === 'invalid_request' ? 400 : 500;
          await reply.status(status).send({
            error: {
              class: 'PolicyAuditQueryError',
              kind: err.kind,
              message: err.message,
            },
          });
          return;
        }
        await reply.status(500).send({
          error: {
            class: 'PolicyAuditQueryError',
            kind: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
  );
}

function normalizeQuery(raw: RawQuery): {
  projectId: string;
  folder?: string;
  principal: PolicyAuditPrincipalFilter;
  outcome?: string;
  reasonCode?: string;
  since?: string;
  until?: string;
  limit?: number;
} {
  const projectId = readNonEmptyString(raw.projectId, 'projectId');
  if (projectId === undefined) {
    throw new QueryParseError("missing or invalid 'projectId' query parameter");
  }

  const folder = readNonEmptyString(raw.folder, 'folder');
  const outcome = readNonEmptyString(raw.outcome, 'outcome');
  const reasonCode = readNonEmptyString(raw.reasonCode, 'reasonCode');
  const since = readNonEmptyString(raw.since, 'since');
  const until = readNonEmptyString(raw.until, 'until');

  const principal = parsePrincipalFilter(raw);
  const limit = parseLimit(raw.limit);

  const out: {
    projectId: string;
    folder?: string;
    principal: PolicyAuditPrincipalFilter;
    outcome?: string;
    reasonCode?: string;
    since?: string;
    until?: string;
    limit?: number;
  } = { projectId, principal };
  if (folder !== undefined) out.folder = folder;
  if (outcome !== undefined) out.outcome = outcome;
  if (reasonCode !== undefined) out.reasonCode = reasonCode;
  if (since !== undefined) out.since = since;
  if (until !== undefined) out.until = until;
  if (limit !== undefined) out.limit = limit;
  return out;
}

function readNonEmptyString(
  v: unknown,
  name: string,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new QueryParseError(`'${name}' must be a string`);
  }
  if (v.length === 0) return undefined;
  return v;
}

/**
 * Discriminated principal-filter parsing.
 *
 *   - omitted (or `principalFilter=any`) → `{ kind:'any' }`
 *   - `principalFilter=none`             → `{ kind:'none' }`
 *   - `principalFilter=exact` + `principalId=<id>` (or `principalId=<id>`
 *     alone)                             → `{ kind:'exact', principalId }`
 *
 * Reject combinations that mix "agnostic" with an explicit id, or
 * "exact" without an id, so the launcher fn cannot receive an
 * ambiguous filter.
 */
function parsePrincipalFilter(raw: RawQuery): PolicyAuditPrincipalFilter {
  const filter = readNonEmptyString(raw.principalFilter, 'principalFilter');
  const principalId = readNonEmptyString(raw.principalId, 'principalId');

  if (filter === undefined) {
    if (principalId !== undefined) {
      return { kind: 'exact', principalId };
    }
    return { kind: 'any' };
  }
  switch (filter) {
    case 'any':
      if (principalId !== undefined) {
        throw new QueryParseError(
          "'principalFilter=any' cannot be combined with 'principalId'",
        );
      }
      return { kind: 'any' };
    case 'none':
      if (principalId !== undefined) {
        throw new QueryParseError(
          "'principalFilter=none' cannot be combined with 'principalId'",
        );
      }
      return { kind: 'none' };
    case 'exact':
      if (principalId === undefined) {
        throw new QueryParseError(
          "'principalFilter=exact' requires a non-empty 'principalId'",
        );
      }
      return { kind: 'exact', principalId };
    default:
      throw new QueryParseError(
        `unknown 'principalFilter' value: '${filter}'. Use 'any', 'none', or 'exact'.`,
      );
  }
}

function parseLimit(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    if (v.length === 0) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new QueryParseError("'limit' must be an integer");
    }
    return n;
  }
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  throw new QueryParseError("'limit' must be an integer");
}
