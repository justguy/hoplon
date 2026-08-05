/**
 * launcher/mcpServe.ts — `hoplon mcp serve` implementation.
 *
 * Boots the Phase 1 default engine against the resolved workspace, wraps
 * it with createHoplonMcpServer, and connects the server to either stdio
 * (default) or HTTP-SSE (when a port is supplied). Returns a lifecycle
 * handle so callers (tests, long-lived processes) can shut down cleanly.
 *
 * This module is a thin wiring layer. It never forks core engine semantics
 * and never introduces host-owned retry or escalation policy (H4).
 */

import type { LauncherWorkspaceInput } from './config.js';
import { bootstrapEngineWithSnapshotStore } from './snapshotStoreBootstrap.js';
import { createHoplonMcpServer } from '../mcp/server.js';
import {
  createStdioTransport,
  createHttpSseTransport,
} from '../mcp/transports.js';
import { createSessionRegistry } from '../session/registry.js';
import { createNodeFsAdapter } from '../adapters/fs/node.js';
import { createTreeSitterIntelligence } from '../adapters/codeIntelligence/treeSitter.js';
import { createAsyncMutexLockProvider } from '../adapters/lock-async-mutex.js';
import { createHoplonEngineRouter } from '../concurrency/index.js';
import { buildEngineForRegisteredProject } from './engineBootstrap.js';
import { openLauncherProjects } from './projects.js';
import { createProjectAwareEngine } from './projectAwareEngine.js';
import { createProjectAwareSessionRegistry } from './projectAwareSessionRegistry.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AgentToolProfile } from '../transport/agentToolProfile.js';
import type { CapabilityGateDeps } from '../transport/capabilityEngagementGate.js';

export type McpTransportMode = 'stdio' | 'sse';

export interface McpServeOptions extends LauncherWorkspaceInput {
  /** Transport mode. Defaults to stdio. */
  transport?: McpTransportMode;
  /** Port for the SSE transport. Required when transport is 'sse'. */
  port?: number;
  /** Optional SSE bind host. Omitted preserves the existing all-interface bind. */
  sseHost?: string;
  /** Optional override for the existing SSE POST body ceiling. */
  sseMaxMessageBytes?: number;
  /**
   * Injection seam for tests: supply a Transport directly instead of
   * letting the launcher construct stdio/SSE. When provided, `transport`
   * and `port` are ignored.
   */
  injectTransport?: Transport;
  /**
   * Optional host-owned behavior test runner (t-067). When supplied, the
   * packaged session transport exposes `session.verifyBehavior()` via the
   * injected runner; otherwise `verifyBehavior` surfaces the honest
   * `UNAVAILABLE / no_runner` response. The launcher never constructs a
   * runner itself — test execution stays host-owned.
   */
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  /** Optional agent-facing MCP tool profile. Defaults to full compatibility. */
  agentToolProfile?: AgentToolProfile;
  /**
   * Optional host-supplied semantic runtime binding for the default and
   * per-project engines. Native packages are passed in here by the host.
   */
  semanticRuntime?: SemanticRuntimeAdapters;
  /** Optional host-supplied structure-only event emitter for engine/session telemetry. */
  emitter?: HoplonEmitter;
  /** Optional strict capability gate, including its server-owned branch resolver. */
  capabilityGate?: CapabilityGateDeps;
}

export interface McpServeHandle {
  server: McpServer;
  transport: McpTransportMode | 'injected';
  port: number | null;
  /** SSE-only server acknowledgement for one session's removal and cleanup. */
  waitForSseSessionClose?(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot an MCP-over-Hoplon server against the current workspace.
 *
 * Stdio mode is the default and matches how an MCP client (e.g. Claude
 * Code) launches its server subprocess. SSE mode is the packaged remote
 * surface — useful when a client connects to a long-running Hoplon.
 */
export async function runMcpServe(
  opts: McpServeOptions = {},
): Promise<McpServeHandle> {
  const { engine, snapshotStore, workspace, emitter } =
    await bootstrapEngineWithSnapshotStore(opts);
  const fs = createNodeFsAdapter({ root: workspace.root });
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: workspace.grammarsDir,
  });
  const sessionLockProvider = createAsyncMutexLockProvider();
  const rootSessionRegistry = createSessionRegistry({
    engine,
    fs,
    codeIntelligence,
    lockProvider: sessionLockProvider,
    projectRoot: workspace.root,
    emitter,
    engineId: workspace.engineId,
    // hcr-009 F8: thread the bootstrapped snapshot store and the engine's
    // gitRepoDir into every packaged session so session.audit() derives
    // coverage (post-snapshot discovery) instead of permanently falling
    // back to declared-only on launcher deployments.
    snapshotStore,
    gitRepoDir: workspace.gitRepoDir,
    ...(opts.behaviorTestRunner !== undefined
      ? { behaviorTestRunner: opts.behaviorTestRunner }
      : {}),
  });
  const projects = openLauncherProjects(workspace.root);
  const projectRouter = createHoplonEngineRouter({
    registry: projects.registry,
    buildEngine: (project) =>
      buildEngineForRegisteredProject(project, opts.semanticRuntime, emitter),
  });
  const sessionRegistry = createProjectAwareSessionRegistry({
    defaultRegistry: rootSessionRegistry,
    projectRegistry: projects.registry,
    router: projectRouter,
    ...(opts.behaviorTestRunner !== undefined
      ? { behaviorTestRunner: opts.behaviorTestRunner }
      : {}),
    emitter,
  });
  const routedEngine = createProjectAwareEngine({
    defaultEngine: engine,
    router: projectRouter,
    registry: projects.registry,
  });
  const createServer = (): McpServer =>
    createHoplonMcpServer({
      engine: routedEngine,
      sessionRegistry,
      launcherRoot: workspace.root,
      snapshotStore,
      ...(opts.agentToolProfile !== undefined
        ? { agentToolProfile: opts.agentToolProfile }
        : {}),
      ...(opts.capabilityGate !== undefined
        ? { capabilityGate: opts.capabilityGate }
        : {}),
    });
  const server = createServer();

  if (opts.injectTransport) {
    await server.connect(opts.injectTransport);
    return {
      server,
      transport: 'injected',
      port: null,
      close: async () => {
        await projectRouter.dispose();
        sessionRegistry.dispose();
        await server.close();
      },
    };
  }

  const mode: McpTransportMode = opts.transport ?? 'stdio';

  if (mode === 'stdio') {
    const transport = createStdioTransport();
    await server.connect(transport);
    return {
      server,
      transport: 'stdio',
      port: null,
      close: async () => {
        await projectRouter.dispose();
        sessionRegistry.dispose();
        await server.close();
      },
    };
  }

  const port = opts.port ?? 3001;
  const sessionServers = new Set<McpServer>();
  const sse = createHttpSseTransport({
    port,
    ...(opts.sseHost !== undefined ? { host: opts.sseHost } : {}),
    ...(opts.sseMaxMessageBytes !== undefined
      ? { maxMessageBytes: opts.sseMaxMessageBytes }
      : {}),
    onTransport: async (t) => {
      const sessionServer = createServer();
      sessionServers.add(sessionServer);
      try {
        await sessionServer.connect(t);
      } catch (error) {
        sessionServers.delete(sessionServer);
        await sessionServer.close();
        throw error;
      }
      return async () => {
        sessionServers.delete(sessionServer);
        await sessionServer.close();
      };
    },
  });
  const boundPort = await sse.ready;
  return {
    server,
    transport: 'sse',
    port: boundPort,
    waitForSseSessionClose: (sessionId: string) =>
      sse.waitForSessionClose(sessionId),
    close: async () => {
      await sse.close();
      await Promise.all([...sessionServers].map(async (active) => active.close()));
      sessionServers.clear();
      await projectRouter.dispose();
      sessionRegistry.dispose();
      await server.close();
    },
  };
}
