/**
 * launcher/projectAwareSessionRegistry.ts — project-root-aware wrapper for
 * packaged edit sessions.
 *
 * The wrapper keeps the shipped SessionRegistry state machine intact. It only
 * chooses which registry owns a new session: empty project registry means the
 * launcher-root registry, while a populated project registry requires the
 * WritableManifest.projectId to name a registered project.
 */

import { createNodeFsAdapter } from '../adapters/fs/node.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import { createTreeSitterIntelligence } from '../adapters/codeIntelligence/treeSitter.js';
import { createAsyncMutexLockProvider } from '../adapters/lock-async-mutex.js';
import type { HoplonEngineRouter } from '../concurrency/engineRouter.js';
import { getHoplonEngineSnapshotStore } from '../engine/factory.js';
import type {
  ProjectRegistry,
  RegisteredProject,
} from '../concurrency/projectRegistry.js';
import {
  createSessionRegistry,
  type RegisteredSessionEntry,
  type RegisteredSessionInfo,
  type RegistryQuickEditOptions,
  type RegistryTargetFirstScopedEditOptions,
  type SessionId,
  type SessionRegistry,
  type StartSessionOptions,
} from '../session/registry.js';
import { SessionTransportError } from '../session/transport.js';

export interface ProjectAwareSessionRegistryOptions {
  defaultRegistry: SessionRegistry;
  projectRegistry: ProjectRegistry;
  router: HoplonEngineRouter;
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  emitter?: HoplonEmitter;
}

type Owner = string | null;

interface OwnerRegistry {
  owner: Owner;
  registry: SessionRegistry;
}

export function createProjectAwareSessionRegistry(
  opts: ProjectAwareSessionRegistryOptions,
): SessionRegistry {
  const registries = new Map<string, SessionRegistry>();
  const registryKeys = new Map<string, string>();
  const inFlight = new Map<string, Promise<SessionRegistry>>();
  const inFlightKeys = new Map<string, string>();
  const sessionOwners = new Map<SessionId, Owner>();

  function registeredIds(): string {
    return opts.projectRegistry
      .list()
      .map((project) => project.projectId)
      .join(', ');
  }

  function projectCacheKey(project: RegisteredProject): string {
    return [
      project.fsRoot,
      project.dbPath,
      project.gitRepoDir,
      project.grammarsDir,
      project.engineId,
    ].join('\0');
  }

  function unknownProject(projectId: string, opLabel: string): SessionTransportError {
    return new SessionTransportError(
      'invalid_request',
      `${opLabel}: manifest.projectId '${projectId}' is not registered. ` +
        `Registered projectIds: [${registeredIds()}]. Register the project ` +
        'first, or start the server with an empty project registry for ' +
        'single-root launcher compatibility.',
    );
  }

  function requireProject(projectId: string, opLabel: string): RegisteredProject {
    const project = opts.projectRegistry.get(projectId);
    if (!project) throw unknownProject(projectId, opLabel);
    return project;
  }

  async function buildProjectRegistry(
    project: RegisteredProject,
    key: string,
    opLabel: string,
  ): Promise<SessionRegistry> {
    const engine = await opts.router.acquire(project.projectId);
    const current = opts.projectRegistry.get(project.projectId);
    if (!current || projectCacheKey(current) !== key) {
      throw unknownProject(project.projectId, opLabel);
    }
    const snapshotStore = getHoplonEngineSnapshotStore(engine);
    const registryOpts: Parameters<typeof createSessionRegistry>[0] = {
      engine,
      fs: createNodeFsAdapter({ root: current.fsRoot }),
      codeIntelligence: await createTreeSitterIntelligence({
        grammarsDir: current.grammarsDir,
      }),
      lockProvider: createAsyncMutexLockProvider(),
      projectRoot: current.fsRoot,
      engineId: current.engineId,
      // Use the exact store captured by the routed engine. Opening a second
      // sql.js handle for current.dbPath would read a stale in-memory copy and
      // could fabricate missing snapshot evidence.
      ...(snapshotStore !== null ? { snapshotStore } : {}),
      // Forward the engine-config gitRepoDir so the coverage walk excludes
      // the Hoplon-internal repository subtree.
      gitRepoDir: current.gitRepoDir,
    };
    if (
      current.policy.revertAllowlist !== undefined &&
      current.policy.revertAllowlist.length > 0
    ) {
      // Mirror engineBootstrap's registeredProjectHasPolicy gate: sessions
      // see the custom allowlist exactly when the project's engine was
      // built with it, keeping coverage exclusion and revert on one source
      // of truth (hcr-009).
      registryOpts.revertAllowlist = [...current.policy.revertAllowlist];
    }
    if (opts.behaviorTestRunner !== undefined) {
      registryOpts.behaviorTestRunner = opts.behaviorTestRunner;
    }
    if (opts.emitter !== undefined) {
      registryOpts.emitter = opts.emitter;
    }
    return createSessionRegistry(registryOpts);
  }

  async function registryForProject(
    projectId: string,
    opLabel: string,
  ): Promise<OwnerRegistry> {
    const project = requireProject(projectId, opLabel);
    const key = projectCacheKey(project);
    const cached = registries.get(projectId);
    if (cached && registryKeys.get(projectId) === key) {
      return { owner: projectId, registry: cached };
    }
    if (cached) {
      cached.dispose();
      registries.delete(projectId);
      registryKeys.delete(projectId);
    }

    const pending = inFlight.get(projectId);
    if (pending && inFlightKeys.get(projectId) === key) {
      return { owner: projectId, registry: await pending };
    }

    const build = (async () => {
      try {
        const registry = await buildProjectRegistry(project, key, opLabel);
        registries.set(projectId, registry);
        registryKeys.set(projectId, key);
        return registry;
      } finally {
        inFlight.delete(projectId);
        inFlightKeys.delete(projectId);
      }
    })();
    inFlight.set(projectId, build);
    inFlightKeys.set(projectId, key);
    return { owner: projectId, registry: await build };
  }

  async function registryForManifest(
    projectId: string,
    opLabel: string,
  ): Promise<OwnerRegistry> {
    if (opts.projectRegistry.size() === 0) {
      return { owner: null, registry: opts.defaultRegistry };
    }
    return registryForProject(projectId, opLabel);
  }

  function lookupMapped(sessionId: SessionId): RegisteredSessionEntry | null {
    const owner = sessionOwners.get(sessionId);
    if (owner === undefined) return null;
    const registry = owner === null ? opts.defaultRegistry : registries.get(owner);
    const entry = registry?.get(sessionId) ?? null;
    if (!entry) sessionOwners.delete(sessionId);
    return entry;
  }

  function lookupAny(sessionId: SessionId): RegisteredSessionEntry | null {
    const mapped = lookupMapped(sessionId);
    if (mapped) return mapped;
    const defaultEntry = opts.defaultRegistry.get(sessionId);
    if (defaultEntry) {
      sessionOwners.set(sessionId, null);
      return defaultEntry;
    }
    for (const [projectId, registry] of registries) {
      const entry = registry.get(sessionId);
      if (entry) {
        sessionOwners.set(sessionId, projectId);
        return entry;
      }
    }
    return null;
  }

  function listAll(): readonly RegisteredSessionInfo[] {
    const sessions = [...opts.defaultRegistry.list()];
    for (const registry of registries.values()) {
      sessions.push(...registry.list());
    }
    return sessions;
  }

  function closeFrom(registry: SessionRegistry, sessionId: SessionId): boolean {
    const closed = registry.close(sessionId);
    if (closed) sessionOwners.delete(sessionId);
    return closed;
  }

  return {
    async start(startOpts: StartSessionOptions) {
      const routed = await registryForManifest(startOpts.manifest.projectId, 'start');
      const entry = await routed.registry.start(startOpts);
      sessionOwners.set(entry.sessionId, routed.owner);
      return entry;
    },
    get(sessionId) {
      return lookupAny(sessionId);
    },
    close(sessionId) {
      const owner = sessionOwners.get(sessionId);
      if (owner !== undefined) {
        const registry = owner === null ? opts.defaultRegistry : registries.get(owner);
        return registry ? closeFrom(registry, sessionId) : false;
      }
      if (closeFrom(opts.defaultRegistry, sessionId)) return true;
      for (const registry of registries.values()) {
        if (closeFrom(registry, sessionId)) return true;
      }
      return false;
    },
    list() {
      return listAll();
    },
    size() {
      return listAll().length;
    },
    dispose() {
      opts.defaultRegistry.dispose();
      for (const registry of registries.values()) registry.dispose();
      registries.clear();
      registryKeys.clear();
      inFlight.clear();
      inFlightKeys.clear();
      sessionOwners.clear();
    },
    sweepIdle() {
      const evicted: SessionId[] = [...opts.defaultRegistry.sweepIdle()];
      for (const registry of registries.values()) {
        evicted.push(...registry.sweepIdle());
      }
      for (const sessionId of evicted) sessionOwners.delete(sessionId);
      return evicted;
    },
    async quickEdit(quickOpts: RegistryQuickEditOptions) {
      const routed = await registryForManifest(quickOpts.manifest.projectId, 'quickEdit');
      return routed.registry.quickEdit(quickOpts);
    },
    async targetFirstScopedEdit(scopedOpts: RegistryTargetFirstScopedEditOptions) {
      const routed = await registryForManifest(
        scopedOpts.request.projectId,
        'targetFirstScopedEdit',
      );
      return routed.registry.targetFirstScopedEdit(scopedOpts);
    },
  };
}
