/**
 * concurrency/engineRouter.ts — project-keyed engine routing for t-080.
 *
 * A `HoplonEngineRouter` resolves an incoming `projectId` to a live
 * `HoplonEngine` constructed against that project's fsRoot, dbPath,
 * gitRepoDir, grammarsDir, engineId, and per-project policy. Engines
 * are cached per-project and reused across calls; each project has
 * its own snapshot store instance and its own adapter set, so the
 * project-boundary invariants DoD #2 requires (separate snapshot
 * state, separate lock state, separate policy surface) hold by
 * construction.
 *
 * Routing contract:
 *   - `acquire(projectId)` returns the engine for the named registered
 *     project, constructing it on first call.
 *   - `acquireActive()` returns the engine for the registry's active
 *     project (launcher-pointer semantics). Throws if no active project.
 *   - `resolve({ projectId? })` picks `projectId` when provided,
 *     otherwise falls back to the active project. Throws when neither
 *     resolves — so transports can decide whether to require explicit
 *     projectId on mutations vs default-to-active on reads.
 *   - `release(projectId)` is a symmetric no-op for now (per-project
 *     engines are kept warm). The interface accepts it so call sites
 *     can be refactored later without API churn.
 *   - `dispose()` closes every cached engine reference (Hoplon engines
 *     have no shutdown today; adapters own their own cleanup).
 *
 * Isolation guarantees proved by the integration test (tests/integration):
 *   1. Distinct `SnapshotStore` instances per project — no shared table.
 *   2. Distinct `LockProvider` instances per project — a lock held in
 *      project A is invisible to project B.
 *   3. Per-project fsRoot — reads routed by projectId cannot escape into
 *      a sibling project's filesystem.
 *   4. Per-project engineId — audit evidence carries the per-project id.
 *
 * This router does NOT pick `projectId` for the caller. The transport
 * layer owns that decision (see `transport/projectResolver.ts`).
 */

import type { HoplonEngine } from '../engine/types.js';
import type { RegisteredProject, ProjectRegistry } from './projectRegistry.js';
import {
  buildProjectResolutionHelp,
  looksLikeFilesystemPath,
} from '../util/projectGuidance.js';

/**
 * Engine-construction callback. Given a registered project, produce an
 * initialized HoplonEngine. The launcher provides a real implementation
 * (calls `createDefaultHoplonEngine` with the per-project fsRoot /
 * dbPath / etc); tests provide an in-memory fake.
 *
 * This indirection keeps `concurrency/` free of engine/adapter imports,
 * preserving the layered import rules.
 */
export type EngineBuilder = (project: RegisteredProject) => Promise<HoplonEngine>;

export interface HoplonEngineRouter {
  /** Return (creating on first call) the engine for `projectId`. */
  acquire(projectId: string): Promise<HoplonEngine>;
  /** Return the engine for the registry's active project. */
  acquireActive(): Promise<HoplonEngine>;
  /**
   * Resolve a request to an engine: explicit projectId wins; otherwise
   * fall back to active. Throws when neither resolves.
   */
  resolve(req: { projectId?: string | undefined }): Promise<{
    engine: HoplonEngine;
    project: RegisteredProject;
    resolvedFrom: 'explicit' | 'active';
  }>;
  /** Release hook. Currently a no-op; engines are kept warm. */
  release(projectId: string): void;
  /** Iterate the live engine cache without forcing builds. */
  cachedProjectIds(): readonly string[];
  /** Snapshot of registered project ids without forcing engine builds. */
  registeredProjectIds(): readonly string[];
  /** Drop cached engines (no shutdown() on engines today). */
  dispose(): Promise<void>;
}

export interface CreateEngineRouterOptions {
  registry: ProjectRegistry;
  buildEngine: EngineBuilder;
}

export type EngineRouterErrorKind =
  | 'unknown_project'
  | 'no_active_project'
  | 'engine_build_failed';

export class EngineRouterError extends Error {
  public readonly kind: EngineRouterErrorKind;
  public readonly projectId?: string;
  public readonly registeredProjectIds: readonly string[];
  public readonly projectIdLooksLikePath: boolean;
  public readonly recoveryHelp: string;
  public override readonly cause?: unknown;

  constructor(
    kind: EngineRouterErrorKind,
    message: string,
    opts: {
      projectId?: string;
      cause?: unknown;
      registeredProjectIds?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = 'EngineRouterError';
    this.kind = kind;
    if (opts.projectId !== undefined) this.projectId = opts.projectId;
    this.registeredProjectIds = [...(opts.registeredProjectIds ?? [])].sort();
    this.projectIdLooksLikePath =
      opts.projectId !== undefined && looksLikeFilesystemPath(opts.projectId);
    this.recoveryHelp = buildProjectResolutionHelp({
      kind,
      projectIdLooksLikePath: this.projectIdLooksLikePath,
      registeredProjectIds: this.registeredProjectIds,
    });
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Build a router over a project registry.
 *
 * The returned router owns a per-projectId engine cache; engines are
 * constructed lazily on first `acquire`, then reused. Because each
 * engine is constructed against its project's own fsRoot, dbPath,
 * lockProvider, and snapshotStore, cross-project isolation is
 * structural rather than enforced by checks on the hot path.
 */
export function createHoplonEngineRouter(
  opts: CreateEngineRouterOptions,
): HoplonEngineRouter {
  const { registry, buildEngine } = opts;
  const cache = new Map<string, HoplonEngine>();
  const inFlight = new Map<string, Promise<HoplonEngine>>();

  async function acquire(projectId: string): Promise<HoplonEngine> {
    const project = registry.get(projectId);
    if (!project) {
      cache.delete(projectId);
      inFlight.delete(projectId);
      throw new EngineRouterError(
        'unknown_project',
        `No project registered with id '${projectId}'. Registered: [${registry
          .list()
          .map((p) => p.projectId)
          .join(', ')}].`,
        { projectId, registeredProjectIds: registry.list().map((p) => p.projectId) },
      );
    }

    const cached = cache.get(projectId);
    if (cached) return cached;

    const pending = inFlight.get(projectId);
    if (pending) return pending;

    const build = (async () => {
      try {
        const engine = await buildEngine(project);
        if (!registry.has(projectId)) {
          throw new EngineRouterError(
            'unknown_project',
            `Project '${projectId}' was unregistered while its engine was building.`,
            { projectId, registeredProjectIds: registry.list().map((p) => p.projectId) },
          );
        }
        cache.set(projectId, engine);
        return engine;
      } catch (err) {
        throw new EngineRouterError(
          'engine_build_failed',
          `Failed to build engine for project '${projectId}': ${
            err instanceof Error ? err.message : String(err)
          }`,
          { projectId, cause: err },
        );
      } finally {
        inFlight.delete(projectId);
      }
    })();

    inFlight.set(projectId, build);
    return build;
  }

  async function acquireActive(): Promise<HoplonEngine> {
    const active = registry.getActive();
    if (!active) {
      throw new EngineRouterError(
        'no_active_project',
        'No active project selected. Register a project and set it active, or pass an explicit projectId.',
        { registeredProjectIds: registry.list().map((p) => p.projectId) },
      );
    }
    return acquire(active.projectId);
  }

  async function resolve(req: {
    projectId?: string | undefined;
  }): Promise<{
    engine: HoplonEngine;
    project: RegisteredProject;
    resolvedFrom: 'explicit' | 'active';
  }> {
    if (typeof req.projectId === 'string' && req.projectId.length > 0) {
      const project = registry.get(req.projectId);
      if (!project) {
        throw new EngineRouterError(
          'unknown_project',
          `No project registered with id '${req.projectId}'. Registered: [${registry
            .list()
            .map((p) => p.projectId)
            .join(', ')}].`,
          { projectId: req.projectId, registeredProjectIds: registry.list().map((p) => p.projectId) },
        );
      }
      const engine = await acquire(req.projectId);
      return { engine, project, resolvedFrom: 'explicit' };
    }
    const active = registry.getActive();
    if (!active) {
      throw new EngineRouterError(
        'no_active_project',
        'Request omitted projectId and no active project is set. Register a project and set it active, or pass an explicit projectId.',
        { registeredProjectIds: registry.list().map((p) => p.projectId) },
      );
    }
    const engine = await acquire(active.projectId);
    return { engine, project: active, resolvedFrom: 'active' };
  }

  function release(_projectId: string): void {
    // Currently a no-op: engines are held warm.
    // Kept in the interface so future eviction (memory pressure, shutdown)
    // can be implemented without surface churn.
  }

  function cachedProjectIds(): readonly string[] {
    return [...cache.keys()].filter((projectId) => registry.has(projectId)).sort();
  }

  function registeredProjectIds(): readonly string[] {
    return registry.list().map((project) => project.projectId);
  }

  async function dispose(): Promise<void> {
    cache.clear();
    inFlight.clear();
  }

  return {
    acquire,
    acquireActive,
    resolve,
    release,
    cachedProjectIds,
    registeredProjectIds,
    dispose,
  };
}
