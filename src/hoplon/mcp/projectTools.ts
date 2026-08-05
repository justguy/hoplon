/**
 * mcp/projectTools.ts — packaged MCP tools for the t-083 project/folder
 * handshake lane.
 *
 * Handshake and lifecycle tools share the launcher project registry and
 * engagement store; tokens stay opaque and errors use typed JSON envelopes.
 *
 * **T-146:** the `projects_handshake` tool now lives in
 * `projectsHandshakeMcpTool.ts` and routes through the
 * `AuthorizationAdapter` seam. Default adapter is
 * `StaticAuthorizationAdapter`; OPA is never the default.
 */
import { HandshakeError } from '../launcher/handshake.js';
import type { AuthorizationAdapter } from '../authorization/authorizationAdapter.js';
import { openEngagementStore } from '../launcher/engagementStore.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import { buildProjectsReport } from '../launcher/projectsReport.js';
import {
  buildProjectPolicySurfaceGuidance,
  buildProjectResolutionGuidance,
} from '../util/projectGuidance.js';
import {
  createNoopPolicyAuditSink,
  type PolicyAuditContext,
  type PolicyAuditSink,
} from '../transport/policyAuditSink.js';
import { buildProjectLifecycleTools } from './projectLifecycleTools.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import { buildPolicyAuditQueryTool } from './projectPolicyAuditTool.js';
import {
  buildHandshakeMcpTool,
  type ProjectToolDefinition,
} from './projectsHandshakeMcpTool.js';
import { toMcpErrorResult } from './projectToolErrors.js';

export type { ProjectToolDefinition } from './projectsHandshakeMcpTool.js';
export type { ToolCallResult } from './projectToolErrors.js';

export interface BuildProjectToolRegistryOptions {
  /** Launcher root used to resolve the shared project registry + engagement store. */
  launcherRoot: string;
  /** Optional engagement-store override (shared with HTTP / CLI by default). */
  engagementStore?: EngagementStore;
  /**
   * Optional t-088 policy audit sink. When provided, every `projects_*`
   * tool call that resolves a handshake / lifecycle outcome emits a
   * durable `hoplon_audit_log` row. When omitted, a no-op sink keeps
   * pre-t-088 behavior.
   */
  policyAuditSink?: PolicyAuditSink;
  /**
   * Optional resolver for policy-audit context metadata. MCP transports
   * can supply tool-scoped runId / correlationId pairs; absent → the
   * tool call re-uses the tool invocation args (projectId when present)
   * and synthesizes a deterministic fallback.
   */
  resolvePolicyAuditContext?: (
    args: Record<string, unknown>,
  ) => PolicyAuditContext;
  /**
   * t-089 — snapshot store backing the bounded `projects_policy_audit`
   * retrieval tool. When omitted, the tool is NOT registered. The MCP
   * surface stays at its pre-t-089 shape so a missing store does not
   * silently degrade to "always empty".
   */
  snapshotStore?: SnapshotStore;
  /**
   * T-146 — optional `AuthorizationAdapter` override. When omitted, the
   * `projects_handshake` tool falls back to the default
   * `StaticAuthorizationAdapter` constructed from the project's folder
   * policy on each request. **OPA is never the default** (T-142 review).
   */
  authorizationAdapter?: AuthorizationAdapter;
}

export function buildProjectToolRegistry(
  opts: BuildProjectToolRegistryOptions,
): ProjectToolDefinition[] {
  const launcherRoot = opts.launcherRoot;
  const engagementStore =
    opts.engagementStore ?? openEngagementStore(launcherRoot);
  const policyAuditSink = opts.policyAuditSink ?? createNoopPolicyAuditSink();
  const resolveAuditContext =
    opts.resolvePolicyAuditContext ?? defaultMcpAuditContext;

  return [
    buildHandshakeMcpTool({
      launcherRoot,
      engagementStore,
      policyAuditSink,
      resolveAuditContext,
      ...(opts.authorizationAdapter !== undefined
        ? { authorizationAdapter: opts.authorizationAdapter }
        : {}),
    }),
    {
      name: 'projects_policy_summary',
      description:
        't-086 operator-visible policy summary for one registered project. ' +
        'Returns a content-safe envelope with the folder-policy shape ' +
        '(default access, rule + principal counts, engagement-token TTL) ' +
        'and the runtime engagement state (active counts, soonest expiry). ' +
        'Never exposes folder paths, principal labels, or token bytes. ' +
        'Read-only inspection only: agents must use projects_handshake for ' +
        'tokens. MCP cannot mutate registration or folder policy; a trusted ' +
        'local agent with host-shell authority may use the launcher CLI from ' +
        'the same launcher root: hoplon project register --project-id <id> ' +
        '--fs-root <dir> --folder-policy-file <policy.json>. An MCP-only ' +
        'agent must ask the host/operator or admin HTTP surface.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: {
          projectId: {
            type: 'string',
            minLength: 1,
            description: 'Registered project id to summarize.',
          },
        },
      },
      async handler(args) {
        const rawProjectId = args['projectId'];
        if (typeof rawProjectId !== 'string' || rawProjectId.length === 0) {
          return toMcpErrorResult(
            new HandshakeError(
              'invalid_request',
              "projects_policy_summary: missing or empty 'projectId' argument",
            ),
          );
        }
        const report = buildProjectsReport(launcherRoot, { engagementStore });
        const entry = report.registered.find(
          (p) => p.projectId === rawProjectId,
        );
        if (!entry) {
          const registeredProjectIds = report.registered.map(
            (p) => p.projectId,
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  kind: 'unknown_project',
                  message: 'Hoplon error: unknown_project',
                  ...buildProjectResolutionGuidance({
                    kind: 'unknown_project',
                    requestedProjectId: rawProjectId,
                    registeredProjectIds,
                  }),
                  guidance: buildProjectPolicySurfaceGuidance({
                    hasFolderPolicy: false,
                  }),
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                projectId: entry.projectId,
                label: entry.label,
                registeredAtIso: entry.registeredAtIso,
                policy: entry.policy,
                engagementState: entry.engagementState,
                guidance: buildProjectPolicySurfaceGuidance({
                  hasFolderPolicy: entry.policy.folderPolicy !== undefined,
                }),
              }),
            },
          ],
        };
      },
    },
    ...buildProjectLifecycleTools({
      launcherRoot,
      engagementStore,
      policyAuditSink,
      resolveAuditContext,
    }),
    ...(opts.snapshotStore !== undefined
      ? [buildPolicyAuditQueryTool(launcherRoot, opts.snapshotStore)]
      : []),
  ];
}

function defaultMcpAuditContext(
  args: Record<string, unknown>,
): PolicyAuditContext {
  const projectId =
    typeof args['projectId'] === 'string' && (args['projectId'] as string).length > 0
      ? (args['projectId'] as string)
      : 'unknown';
  const correlationId =
    typeof args['correlationId'] === 'string' &&
    (args['correlationId'] as string).length > 0
      ? (args['correlationId'] as string)
      : 'mcp';
  const runId =
    typeof args['runId'] === 'string' && (args['runId'] as string).length > 0
      ? (args['runId'] as string)
      : correlationId;
  return { projectId, runId, correlationId };
}
