/** MCP server composition and request dispatch. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { openEngagementStore } from '../launcher/engagementStore.js';
import {
  filterMcpToolsForAgentProfile,
  normalizeAgentToolProfile,
  strictAgentFallbackEnvelope,
  STRICT_AGENT_TOOL_PROFILE,
} from '../transport/agentToolProfile.js';
import {
  createPolicyAuditSink,
  type PolicyAuditSink,
} from '../transport/policyAuditSink.js';
import type { StrictEngagementGateDeps } from '../transport/strictEngagementGate.js';
import { buildEngineToolRegistry } from './engineTools.js';
import { buildProjectToolRegistry } from './projectTools.js';
import type { McpServerOptions } from './serverOptions.js';
import { buildSessionToolRegistry } from './sessionTools.js';
import { buildTraceToolRegistry } from './traceTools.js';

export type { McpServerOptions } from './serverOptions.js';

/**
 * Create and configure an MCP Server wrapping the given HoplonEngine.
 *
 * The returned server is not connected to a transport. Call `connect` with
 * the stdio or SSE transport supplied by `transports.ts`.
 */
export function createHoplonMcpServer(opts: McpServerOptions): Server {
  const strictProfile =
    normalizeAgentToolProfile(opts.agentToolProfile) === STRICT_AGENT_TOOL_PROFILE;
  const engagementStore =
    opts.engagementStore ??
    (opts.launcherRoot ? openEngagementStore(opts.launcherRoot) : undefined);
  const policyAuditSink: PolicyAuditSink | undefined =
    opts.policyAuditSink ??
    (strictProfile && opts.snapshotStore
      ? createPolicyAuditSink({ store: opts.snapshotStore, engineId: 'mcp' })
      : undefined);
  const strictEngagementGate: StrictEngagementGateDeps | undefined = strictProfile
    ? {
        ...(engagementStore !== undefined ? { store: engagementStore } : {}),
        ...(policyAuditSink !== undefined ? { sink: policyAuditSink } : {}),
        ...(opts.capabilityGate !== undefined
          ? { capability: opts.capabilityGate }
          : {}),
        engineId: 'mcp',
      }
    : undefined;

  const engineTools = buildEngineToolRegistry(opts.engine, strictEngagementGate);
  const sessionTools = opts.sessionRegistry
    ? buildSessionToolRegistry({
        registry: opts.sessionRegistry,
        ...(strictEngagementGate !== undefined
          ? { strictEngagementGate }
          : {}),
      })
    : [];
  const traceTools = opts.traceStore
    ? buildTraceToolRegistry({
        traceStore: opts.traceStore,
        ...(opts.proofAccess !== undefined
          ? { enterpriseAccess: opts.proofAccess }
          : {}),
      })
    : [];
  const projectTools = opts.launcherRoot
    ? buildProjectToolRegistry({
        launcherRoot: opts.launcherRoot,
        ...(engagementStore !== undefined ? { engagementStore } : {}),
        ...(policyAuditSink !== undefined ? { policyAuditSink } : {}),
        ...(opts.snapshotStore !== undefined
          ? { snapshotStore: opts.snapshotStore }
          : {}),
        ...(opts.authorizationAdapter !== undefined
          ? { authorizationAdapter: opts.authorizationAdapter }
          : {}),
      })
    : [];
  const allTools = [...engineTools, ...sessionTools, ...traceTools, ...projectTools];
  const allToolNames = new Set(allTools.map((tool) => tool.name));
  const tools = filterMcpToolsForAgentProfile(allTools, opts.agentToolProfile);

  const server = new Server(
    { name: 'hoplon', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    const tool = tools.find((candidate) => candidate.name === name);

    if (!tool) {
      if (strictProfile && allToolNames.has(name)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                strictAgentFallbackEnvelope({
                  kind: 'strict_agent_unsupported_tool',
                  correlationId: 'mcp',
                  surface: name,
                }),
              ),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              kind: 'tool_not_found',
              message: `Hoplon error: tool_not_found`,
            }),
          },
        ],
        isError: true,
      };
    }

    return tool.handler((toolArgs ?? {}) as Record<string, unknown>);
  });

  return server;
}
