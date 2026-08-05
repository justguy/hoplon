/**
 * mcp/projectLifecycleTools.ts — `projects_renew` / `projects_revoke` /
 * `projects_prune` MCP tool builders extracted from `projectTools.ts`.
 *
 * The handshake tool stays in `projectTools.ts` alongside the registry
 * factory; the lifecycle tools live here so both files stay under the
 * 300-line architecture cap and lifecycle wiring is localized.
 *
 * Every tool forwards into the shared launcher engagement lifecycle
 * functions and emits policy-audit evidence via the shared sink.
 */

import { HandshakeError } from '../launcher/handshake.js';
import {
  pruneExpiredTokens,
  renewEngagementToken,
  revokeEngagementToken,
} from '../launcher/engagementLifecycle.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import { openLauncherProjects } from '../launcher/projects.js';
import type {
  PolicyAuditContext,
  PolicyAuditSink,
} from '../transport/policyAuditSink.js';
import {
  toMcpErrorResult,
  type ToolCallResult,
} from './projectToolErrors.js';

export interface ProjectLifecycleToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface BuildProjectLifecycleToolsOptions {
  launcherRoot: string;
  engagementStore: EngagementStore;
  policyAuditSink: PolicyAuditSink;
  resolveAuditContext: (args: Record<string, unknown>) => PolicyAuditContext;
}

export function buildProjectLifecycleTools(
  opts: BuildProjectLifecycleToolsOptions,
): ProjectLifecycleToolDefinition[] {
  const { launcherRoot, engagementStore, policyAuditSink, resolveAuditContext } = opts;

  return [
    {
      name: 'projects_renew',
      description:
        'Explicitly renew an engagement token for a registered project. ' +
        'Re-runs the folder-policy resolution against the stored binding, ' +
        'replaces the opaque token, and extends the expiry using the current ' +
        'folder-policy TTL. Returns reauth_required with a typed reason when ' +
        'the token is missing, expired, or the handshake can no longer be ' +
        'issued (policy changed). Token lifecycle only; does not mutate ' +
        'project registration or folder policy.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['token'],
        properties: {
          token: {
            type: 'string',
            minLength: 1,
            description: 'Opaque engagement token previously issued by handshake.',
          },
        },
      },
      async handler(args) {
        const startMs = Date.now();
        try {
          const token = requireStringArg(args, 'token');
          const manager = openLauncherProjects(launcherRoot);
          const outcome = renewEngagementToken(engagementStore, token, {
            registry: manager.registry,
            store: engagementStore,
          });
          const baseCtx = resolveAuditContext(args);
          const ctx: PolicyAuditContext =
            outcome.kind === 'renewed'
              ? { ...baseCtx, projectId: outcome.binding.projectId }
              : baseCtx;
          await policyAuditSink.recordRenew(ctx, outcome, Date.now() - startMs);
          if (outcome.kind === 'renewed') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    kind: 'renewed',
                    previousToken: outcome.previousToken,
                    result: outcome.result,
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  kind: 'reauth_required',
                  reason: outcome.reason,
                  message: `Hoplon error: reauth_required (${outcome.reason})`,
                }),
              },
            ],
            isError: true,
          };
        } catch (err) {
          return toMcpErrorResult(err);
        }
      },
    },
    {
      name: 'projects_revoke',
      description:
        'Revoke a live engagement token by dropping its binding. Subsequent ' +
        'lifecycle calls observe the token as missing. Does not touch ' +
        'session, snapshot, audit state, registration, or folder policy.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['token'],
        properties: {
          token: {
            type: 'string',
            minLength: 1,
            description: 'Opaque engagement token to revoke.',
          },
        },
      },
      async handler(args) {
        const startMs = Date.now();
        try {
          const token = requireStringArg(args, 'token');
          const outcome = revokeEngagementToken(engagementStore, token);
          const baseCtx = resolveAuditContext(args);
          const ctx: PolicyAuditContext =
            outcome.kind === 'revoked'
              ? { ...baseCtx, projectId: outcome.binding.projectId }
              : baseCtx;
          await policyAuditSink.recordRevoke(
            ctx,
            outcome,
            Date.now() - startMs,
          );
          if (outcome.kind === 'revoked') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ kind: 'revoked' }) }],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  kind: 'missing_token',
                  message: 'Hoplon error: missing_token',
                }),
              },
            ],
            isError: true,
          };
        } catch (err) {
          return toMcpErrorResult(err);
        }
      },
    },
    {
      name: 'projects_prune',
      description:
        'Prune every engagement-token binding whose TTL has passed. Returns ' +
        'the count of removed bindings. Only touches the engagement store; ' +
        'does not mutate registration or folder policy.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      async handler() {
        try {
          const report = pruneExpiredTokens(engagementStore, new Date());
          return {
            content: [
              { type: 'text', text: JSON.stringify({ kind: 'pruned', ...report }) },
            ],
          };
        } catch (err) {
          return toMcpErrorResult(err);
        }
      },
    },
  ];
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HandshakeError(
      'invalid_request',
      `project tool: missing or empty '${key}' argument`,
    );
  }
  return value;
}
