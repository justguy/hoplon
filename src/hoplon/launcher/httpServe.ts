/**
 * launcher/httpServe.ts — `hoplon http serve` implementation.
 *
 * Boots the Phase 1 default engine against the resolved workspace and
 * mounts the existing Hoplon HTTP surface (createHoplonHttpServer) on a
 * configurable host+port. Returns a lifecycle handle so callers can
 * shut down cleanly.
 *
 * This module is a thin wiring layer. It owns no policy.
 */

import type { LauncherWorkspaceInput } from './config.js';
import { bootstrapEngineWithSnapshotStore } from './snapshotStoreBootstrap.js';
import { createHoplonHttpServer } from '../transport/http/server.js';
import { createSessionRegistry } from '../session/registry.js';
import { createNodeFsAdapter } from '../adapters/fs/node.js';
import { createTreeSitterIntelligence } from '../adapters/codeIntelligence/treeSitter.js';
import { createAsyncMutexLockProvider } from '../adapters/lock-async-mutex.js';
import { createHoplonEngineRouter } from '../concurrency/index.js';
import { buildEngineForRegisteredProject } from './engineBootstrap.js';
import { openLauncherProjects } from './projects.js';
import { createProjectAwareSessionRegistry } from './projectAwareSessionRegistry.js';
import { assertHostAuthPolicy } from '../transport/http/serverAuth.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { FastifyInstance } from 'fastify';
import type { AgentToolProfile } from '../transport/agentToolProfile.js';
import type { AuthRegistry } from '../transport/http/auth.js';

export interface HttpServeOptions extends LauncherWorkspaceInput {
  host?: string;
  port?: number;
  /** When true, the returned handle does not call .listen — suitable for tests. */
  listen?: boolean;
  /**
   * Optional host-owned behavior test runner (t-067). When supplied, the
   * packaged session transport exposes `session.verifyBehavior()` via the
   * injected runner; otherwise `verifyBehavior` surfaces the honest
   * `UNAVAILABLE / no_runner` response. The launcher never constructs a
   * runner itself — test execution stays host-owned.
   */
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  /** Optional agent-facing HTTP route profile. Defaults to full compatibility. */
  agentToolProfile?: AgentToolProfile;
  /**
   * Optional host-supplied semantic runtime binding for the default and
   * per-project engines. Native packages are passed in here by the host.
   */
  semanticRuntime?: SemanticRuntimeAdapters;
  /** Optional host-supplied structure-only event emitter for engine/session telemetry. */
  emitter?: HoplonEmitter;
  /**
   * Optional auth registry (hcr-003). When provided, it is threaded into the
   * HTTP server so `runAuth()` gates every request. Required for a safe
   * non-loopback bind; the CLI cannot construct token verifiers from flags, so
   * programmatic embedders supply this.
   */
  authRegistry?: AuthRegistry;
  /**
   * Explicit, unsafe override (hcr-003). When true, a non-loopback bind with no
   * auth is permitted instead of failing the startup guard. Defaults to false.
   */
  allowUnauthenticated?: boolean;
}

export interface HttpServeHandle {
  fastify: FastifyInstance;
  host: string | null;
  port: number | null;
  close(): Promise<void>;
}

/**
 * Boot the Hoplon HTTP surface against the current workspace.
 *
 * Listens on host:port when `listen !== false`; otherwise the caller is
 * responsible for calling `fastify.listen()` or using `fastify.inject()`
 * directly (that path is how the launcher is proved under test).
 */
export async function runHttpServe(
  opts: HttpServeOptions = {},
): Promise<HttpServeHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;

  // hcr-010 P4 — evaluate the non-loopback-without-auth startup guard BEFORE
  // bootstrapping the engine/snapshot store. createHoplonHttpServer runs the
  // same assertHostAuthPolicy check, but by then the sqlite snapshot store
  // handle is already open; a refused public-bind misconfig would leak it.
  // Failing fast here throws the identical typed EngineError(config_invalid)
  // and constructs nothing. Loopback / auth-configured / override paths pass
  // this check unchanged and proceed to bootstrap exactly as before.
  assertHostAuthPolicy({
    host,
    authConfigured: opts.authRegistry !== undefined,
    allowUnauthenticated: opts.allowUnauthenticated === true,
  });

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

  const fastify = await createHoplonHttpServer({
    engine,
    sessionRegistry,
    projectRouter,
    launcherRoot: workspace.root,
    snapshotStore,
    emitter,
    // hcr-003 — thread the bind host so the startup guard is reachable, plus
    // the auth/override options that let a non-loopback bind proceed safely.
    host,
    ...(opts.authRegistry !== undefined
      ? { authRegistry: opts.authRegistry }
      : {}),
    ...(opts.allowUnauthenticated !== undefined
      ? { allowUnauthenticated: opts.allowUnauthenticated }
      : {}),
    ...(opts.agentToolProfile !== undefined
      ? { agentToolProfile: opts.agentToolProfile }
      : {}),
  });

  const close = async () => {
    await fastify.close();
    await projectRouter.dispose();
    sessionRegistry.dispose();
  };

  if (opts.listen === false) {
    return {
      fastify,
      host: null,
      port: null,
      close,
    };
  }

  await fastify.listen({ host, port });
  return {
    fastify,
    host,
    port,
    close,
  };
}
