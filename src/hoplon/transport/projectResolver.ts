/**
 * transport/projectResolver.ts — project-aware dispatch for HTTP (t-080).
 *
 * Wraps a single `EngineDispatcher` with per-request engine resolution
 * based on the `projectId` field carried in the request body. Pre-t-080
 * the HTTP server held one engine and ignored `projectId` during
 * dispatch — it was a request-level label, not a router key. Now that
 * launchers may register multiple project roots, this resolver uses
 * `projectId` to pick the right project's engine before invocation.
 *
 * Backward-compat contract (DoD: "do not fork existing read/session APIs"):
 *   - If no `HoplonEngineRouter` is wired, this module is a no-op — the
 *     original single-engine dispatcher runs unchanged.
 *   - If a router IS wired:
 *       - A request carrying a `projectId` of a registered project is
 *         routed to that project's engine.
 *       - A request omitting `projectId` (e.g. `health`, `reconcile`)
 *         falls through to the **default** engine the server was started
 *         with. If no projects are registered yet, request projectId values
 *         remain labels on that default engine for single-project callers.
 *         Once any project is registered, unknown projectId values fail as a
 *         typed project-routing error instead of silently reading the launcher
 *         root.
 *   - Requests never escape a registered project's fsRoot; the route-level
 *     resolver refuses to default-route a registered-project's projectId
 *     to the default engine.
 *
 * Isolation guarantees:
 *   - Each per-project engine was built with its own fsRoot, gitRepoDir,
 *     dbPath, lockProvider, snapshotStore, and secretScanner. Routing
 *     here is a *thin dispatch pointer*, not a capability merge — there
 *     is no shared state between engines beyond the registry metadata.
 */

import type { HoplonEngine } from '../engine/types.js';
import type { EngineDispatcher, DispatchRequest } from './dispatcher.js';
import { createEngineDispatcher } from './dispatcher.js';
import {
  EngineRouterError,
  type HoplonEngineRouter,
} from '../concurrency/engineRouter.js';
import { EngineError, SemanticError } from '../contracts/errors.js';

export interface ProjectAwareDispatcherOptions {
  /** Default (single-project) engine; always available. */
  defaultEngine: HoplonEngine;
  /**
   * Optional router mapping `projectId` to registered-project engines.
   * When omitted, this module behaves identically to the underlying
   * single-engine dispatcher.
   */
  router?: HoplonEngineRouter;
}

export interface ProjectAwareDispatcher extends EngineDispatcher {
  /** Snapshot of projectIds the router currently recognizes (best effort). */
  registeredProjectIds(): readonly string[];
}

/**
 * Build a project-aware dispatcher. Delegates to a freshly built
 * `EngineDispatcher` per resolved engine so validation, call shapes,
 * and signal wiring stay byte-identical to the single-project path.
 */
export function createProjectAwareDispatcher(
  opts: ProjectAwareDispatcherOptions,
): ProjectAwareDispatcher {
  const defaultDispatcher = createEngineDispatcher(opts.defaultEngine);
  const dispatcherCache = new Map<string, EngineDispatcher>();

  function cachedDispatcher(
    projectId: string,
    engine: HoplonEngine,
  ): EngineDispatcher {
    const cached = dispatcherCache.get(projectId);
    if (cached) return cached;
    const d = createEngineDispatcher(engine);
    dispatcherCache.set(projectId, d);
    return d;
  }

  async function invoke(req: DispatchRequest): Promise<unknown> {
    if (!opts.router) return defaultDispatcher.invoke(req);
    const extracted = extractProjectId(req.body);
    if (extracted === null) return defaultDispatcher.invoke(req);
    const registeredProjectIds = opts.router.registeredProjectIds();
    if (registeredProjectIds.length === 0) {
      return defaultDispatcher.invoke(req);
    }
    if (!registeredProjectIds.includes(extracted)) {
      // Resolve explicitly to catch unknown-project early; the router
      // throws a typed EngineRouterError which is normalized below.
      try {
        const resolved = await opts.router.resolve({ projectId: extracted });
        const dispatcher = cachedDispatcher(extracted, resolved.engine);
        return dispatcher.invoke(req);
      } catch (err) {
        throw normalizeRouterError(err, req);
      }
    }
    try {
      const engine = await opts.router.acquire(extracted);
      const dispatcher = cachedDispatcher(extracted, engine);
      return dispatcher.invoke(req);
    } catch (err) {
      throw normalizeRouterError(err, req);
    }
  }

  function registeredProjectIds(): readonly string[] {
    return opts.router ? opts.router.registeredProjectIds() : [];
  }

  return {
    operations: defaultDispatcher.operations,
    operationFor: (m: string) => defaultDispatcher.operationFor(m),
    invoke,
    registeredProjectIds,
  };
}

function normalizeRouterError(err: unknown, req: DispatchRequest): unknown {
  if (!(err instanceof EngineRouterError)) return err;
  if (err.kind === 'unknown_project' || err.kind === 'no_active_project') {
    return new SemanticError(
      {
        kind: err.kind,
        engineId: req.engineId,
        correlationId: req.correlationId,
        cause: err,
      },
      `${err.message} Re-resolve the target project and retry with an explicit registered projectId.`,
    );
  }
  return new EngineError(
    {
      kind: 'project_engine_build_failed',
      engineId: req.engineId,
      correlationId: req.correlationId,
      cause: err,
    },
    `${err.message} Rebuild or restart the project engine before retrying.`,
  );
}

/** Best-effort projectId extraction from a dispatch body. */
function extractProjectId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const pid = (body as Record<string, unknown>)['projectId'];
  if (typeof pid === 'string' && pid.length > 0) return pid;
  // Some requests (e.g. auditDiff) carry projectId nested under manifest.
  const manifest = (body as Record<string, unknown>)['manifest'];
  if (manifest !== null && typeof manifest === 'object') {
    const m = (manifest as Record<string, unknown>)['projectId'];
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return null;
}
