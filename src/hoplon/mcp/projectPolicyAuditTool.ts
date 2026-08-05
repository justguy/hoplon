/**
 * mcp/projectPolicyAuditTool.ts — t-089 bounded policy audit query tool.
 *
 * The tool mirrors `GET /projects/policy/audit`: it validates transport
 * arguments into the shared query contract, delegates to the launcher
 * `queryPolicyAudit` function, and never returns raw audit rows.
 */

import { openLauncherProjects } from '../launcher/projects.js';
import {
  queryPolicyAudit,
  PolicyAuditQueryError,
} from '../launcher/policyAuditQuery.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { PolicyAuditPrincipalFilter } from '../contracts/policyAuditQuery.js';
import type { ProjectToolDefinition } from './projectTools.js';

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function buildPolicyAuditQueryTool(
  launcherRoot: string,
  snapshotStore: SnapshotStore,
): ProjectToolDefinition {
  return {
    name: 'projects_policy_audit',
    description:
      't-089 bounded retrieval of t-088 policy audit evidence for a ' +
      'registered project. Read-only; returns at most `limit` entries ' +
      '(default 50, hard max 200) in reverse-chronological order. ' +
      'Drops the server-private engagement nonce; never carries raw ' +
      'engagement tokens, secret patterns, or full rule bodies. MCP cannot ' +
      'mutate registration or folder policy; trusted host-shell onboarding ' +
      'uses hoplon project register --project-id <id> --fs-root <dir> ' +
      '--folder-policy-file <policy.json>, or host/admin HTTP.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: {
        projectId: { type: 'string', minLength: 1 },
        folder: { type: 'string', minLength: 1 },
        principalFilter: { type: 'string', enum: ['any', 'none', 'exact'] },
        principalId: { type: 'string', minLength: 1 },
        outcome: {
          type: 'string',
          enum: ['GRANTED', 'DENIED', 'REAUTH_REQUIRED', 'REVOKED'],
        },
        reasonCode: { type: 'string', minLength: 1 },
        since: { type: 'string', minLength: 1 },
        until: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    async handler(args) {
      try {
        const projectId = requirePolicyAuditStringArg(args, 'projectId');
        const manager = openLauncherProjects(launcherRoot);
        const known = manager.list().some((p) => p.projectId === projectId);
        if (!known) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  kind: 'unknown_project',
                  message: `No project registered with id '${projectId}'`,
                }),
              },
            ],
            isError: true,
          };
        }

        const request: Record<string, unknown> = {
          projectId,
          principal: parseMcpPrincipalFilter(args),
        };
        const folder = optionalPolicyAuditStringArg(args, 'folder');
        if (folder !== undefined) request['folder'] = folder;
        const outcome = optionalPolicyAuditStringArg(args, 'outcome');
        if (outcome !== undefined) request['outcome'] = outcome;
        const reasonCode = optionalPolicyAuditStringArg(args, 'reasonCode');
        if (reasonCode !== undefined) request['reasonCode'] = reasonCode;
        const since = optionalPolicyAuditStringArg(args, 'since');
        if (since !== undefined) request['since'] = since;
        const until = optionalPolicyAuditStringArg(args, 'until');
        if (until !== undefined) request['until'] = until;
        const limit = args['limit'];
        if (typeof limit === 'number' && Number.isInteger(limit)) {
          request['limit'] = limit;
        } else if (limit !== undefined) {
          throw new PolicyAuditQueryError(
            'invalid_request',
            "projects_policy_audit: 'limit' must be an integer",
          );
        }

        const response = await queryPolicyAudit({
          store: snapshotStore,
          request,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      } catch (err) {
        return toPolicyAuditMcpErrorResult(err);
      }
    },
  };
}

function parseMcpPrincipalFilter(
  args: Record<string, unknown>,
): PolicyAuditPrincipalFilter {
  const filter = optionalPolicyAuditStringArg(args, 'principalFilter');
  const principalId = optionalPolicyAuditStringArg(args, 'principalId');
  if (filter === undefined) {
    if (principalId !== undefined) return { kind: 'exact', principalId };
    return { kind: 'any' };
  }
  switch (filter) {
    case 'any':
      if (principalId !== undefined) {
        throw new PolicyAuditQueryError(
          'invalid_request',
          "projects_policy_audit: 'principalFilter=any' cannot be combined with 'principalId'",
        );
      }
      return { kind: 'any' };
    case 'none':
      if (principalId !== undefined) {
        throw new PolicyAuditQueryError(
          'invalid_request',
          "projects_policy_audit: 'principalFilter=none' cannot be combined with 'principalId'",
        );
      }
      return { kind: 'none' };
    case 'exact':
      if (principalId === undefined) {
        throw new PolicyAuditQueryError(
          'invalid_request',
          "projects_policy_audit: 'principalFilter=exact' requires 'principalId'",
        );
      }
      return { kind: 'exact', principalId };
    default:
      throw new PolicyAuditQueryError(
        'invalid_request',
        `projects_policy_audit: unknown 'principalFilter' value: '${filter}'`,
      );
  }
}

function requirePolicyAuditStringArg(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PolicyAuditQueryError(
      'invalid_request',
      `projects_policy_audit: missing or empty '${key}' argument`,
    );
  }
  return value;
}

function optionalPolicyAuditStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, key)) return undefined;
  return requirePolicyAuditStringArg(args, key);
}

function toPolicyAuditMcpErrorResult(err: unknown): ToolCallResult {
  if (err instanceof PolicyAuditQueryError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: true,
            kind: err.kind,
            message: err.message,
          }),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : 'unknown_error';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          kind: 'internal_error',
          message: `Hoplon error: ${message}`,
        }),
      },
    ],
    isError: true,
  };
}
