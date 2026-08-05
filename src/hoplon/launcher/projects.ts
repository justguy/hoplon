/**
 * launcher/projects.ts — operator-facing multi-project surface (t-080).
 *
 * Binds the pure `ProjectRegistry` to a durable JSON store under the
 * launcher's `.hoplon/projects.json`. Callers — the launcher CLI, MCP
 * tool, HTTP route, or `runStatus` — talk to `openLauncherProjects()`
 * instead of re-implementing persistence.
 *
 * Contract:
 *   - Load is lazy but cached per launcher root; re-opening the same
 *     root returns the same registry instance so concurrent callers
 *     agree on "is active" without racing the disk.
 *   - Mutations (register, unregister, setActive, clearActive) are
 *     persisted atomically. A crash mid-write never leaves the
 *     registry half-updated (see projectsStore.ts).
 *   - Registration validates that the fsRoot exists and is a directory.
 *     Bad state surfaces as `LauncherProjectsError('invalid_fs_root')`
 *     rather than silently accepting a missing root.
 *   - Unregistration never touches the target project's filesystem
 *     — a project that was once supervised may retain its own
 *     `.hoplon/` state. That is intentional: the operator decides
 *     whether to clean up on-disk state, not Hoplon.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createProjectRegistry,
  ProjectRegistryError,
} from '../concurrency/projectRegistry.js';
import type {
  ProjectRegistry,
  RegisteredProject,
  RegisterProjectInput,
} from '../concurrency/projectRegistry.js';
import {
  loadProjectsStore,
  resolveProjectsStorePath,
  saveProjectsStore,
  ProjectsStoreError,
} from './projectsStore.js';
import { syncProjectRegistry } from './projectsRegistrySync.js';

export type LauncherProjectsErrorKind =
  | 'invalid_fs_root'
  | 'persistence_failed'
  | 'registry_error'
  | 'store_error';

export class LauncherProjectsError extends Error {
  public readonly kind: LauncherProjectsErrorKind;
  public readonly projectId?: string;
  public override readonly cause?: unknown;

  constructor(
    kind: LauncherProjectsErrorKind,
    message: string,
    opts: { projectId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'LauncherProjectsError';
    this.kind = kind;
    if (opts.projectId !== undefined) this.projectId = opts.projectId;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export interface LauncherProjects {
  /** The absolute path of the persisted projects registry for this root. */
  readonly storePath: string;
  /** The underlying registry (for routers that want the live object). */
  readonly registry: ProjectRegistry;
  /** List all registered projects (sorted). */
  list(): readonly RegisteredProject[];
  /** Currently active project, or null when none is set. */
  getActive(): RegisteredProject | null;
  /** Register a new project. Persists before returning. */
  register(input: RegisterProjectInput): RegisteredProject;
  /** Unregister a project. Persists before returning. */
  unregister(projectId: string): void;
  /** Set the active project. Persists before returning. */
  setActive(projectId: string): void;
  /** Clear the active-project pointer. Persists before returning. */
  clearActive(): void;
  /** Get a registered project by id. */
  get(projectId: string): RegisteredProject | null;
}

const launcherProjectsCache = new Map<string, LauncherProjects>();

/**
 * Open (or lazily load) the projects registry for a launcher root.
 *
 * The launcher root is the operator-owned directory that hosts the
 * launcher's own `.hoplon/` state. Registered projects can live
 * anywhere on disk; they do not need to be nested under the
 * launcher root.
 */
export function openLauncherProjects(launcherRoot: string): LauncherProjects {
  const resolvedLauncherRoot = path.resolve(launcherRoot);
  const cached = launcherProjectsCache.get(resolvedLauncherRoot);
  if (cached) return cached;

  const storePath = resolveProjectsStorePath(resolvedLauncherRoot);
  let loaded: {
    projects: RegisteredProject[];
    activeProjectId: string | null;
  };
  try {
    loaded = loadProjectsStore(storePath);
  } catch (err) {
    if (err instanceof ProjectsStoreError) {
      throw new LauncherProjectsError(
        'store_error',
        `Cannot open launcher projects at ${storePath}: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  const registry = createProjectRegistry({
    seed: loaded.projects,
    ...(loaded.activeProjectId !== null
      ? { activeProjectId: loaded.activeProjectId }
      : {}),
  });

  function persist(): void {
    try {
      const active = registry.getActive();
      saveProjectsStore(storePath, {
        projects: registry.list(),
        activeProjectId: active ? active.projectId : null,
      });
    } catch (err) {
      if (err instanceof ProjectsStoreError) {
        throw new LauncherProjectsError(
          'persistence_failed',
          `Failed to persist launcher projects: ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  function refreshFromStore(): void {
    const fresh = loadProjectsStore(storePath);
    syncProjectRegistry(registry, fresh);
  }

  function validateFsRoot(fsRoot: string, projectId: string): string {
    const abs = path.resolve(fsRoot);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      throw new LauncherProjectsError(
        'invalid_fs_root',
        `fsRoot '${fsRoot}' for project '${projectId}' does not exist or is not readable`,
        { projectId, cause: err },
      );
    }
    if (!stat.isDirectory()) {
      throw new LauncherProjectsError(
        'invalid_fs_root',
        `fsRoot '${fsRoot}' for project '${projectId}' is not a directory`,
        { projectId },
      );
    }
    return abs;
  }

  function register(input: RegisterProjectInput): RegisteredProject {
    refreshFromStore();
    const fsRoot = validateFsRoot(input.fsRoot, input.projectId);
    // Resolve relative dbPath/grammarsDir against the project's own fsRoot.
    const resolved: RegisterProjectInput = {
      ...input,
      fsRoot,
      dbPath: resolveMaybeRelative(fsRoot, input.dbPath ?? '.hoplon/hoplon.db'),
    };
    if (input.grammarsDir !== undefined) {
      resolved.grammarsDir = resolveMaybeRelative(fsRoot, input.grammarsDir);
    }
    let record: RegisteredProject;
    try {
      record = registry.register(resolved);
    } catch (err) {
      if (err instanceof ProjectRegistryError) {
        throw new LauncherProjectsError(
          'registry_error',
          err.message,
          {
            ...(err.projectId !== undefined
              ? { projectId: err.projectId }
              : {}),
            cause: err,
          },
        );
      }
      throw err;
    }
    persist();
    return record;
  }

  function unregister(projectId: string): void {
    refreshFromStore();
    try {
      registry.unregister(projectId);
    } catch (err) {
      if (err instanceof ProjectRegistryError) {
        throw new LauncherProjectsError(
          'registry_error',
          err.message,
          {
            ...(err.projectId !== undefined
              ? { projectId: err.projectId }
              : {}),
            cause: err,
          },
        );
      }
      throw err;
    }
    persist();
  }

  function setActive(projectId: string): void {
    refreshFromStore();
    try {
      registry.setActive(projectId);
    } catch (err) {
      if (err instanceof ProjectRegistryError) {
        throw new LauncherProjectsError(
          'registry_error',
          err.message,
          {
            ...(err.projectId !== undefined
              ? { projectId: err.projectId }
              : {}),
            cause: err,
          },
        );
      }
      throw err;
    }
    persist();
  }

  function clearActive(): void {
    refreshFromStore();
    registry.clearActive();
    persist();
  }

  const refreshingRegistry: ProjectRegistry = {
    register,
    unregister,
    setActive,
    clearActive,
    get: (projectId: string) => (refreshFromStore(), registry.get(projectId)),
    list: () => (refreshFromStore(), registry.list()),
    has: (projectId: string) => (refreshFromStore(), registry.has(projectId)),
    getActive: () => (refreshFromStore(), registry.getActive()),
    size: () => (refreshFromStore(), registry.size()),
  };

  const manager: LauncherProjects = {
    storePath,
    registry: refreshingRegistry,
    list: () => refreshingRegistry.list(),
    getActive: () => refreshingRegistry.getActive(),
    register,
    unregister,
    setActive,
    clearActive,
    get: (projectId: string) => refreshingRegistry.get(projectId),
  };
  launcherProjectsCache.set(resolvedLauncherRoot, manager);
  return manager;
}

function resolveMaybeRelative(fsRoot: string, candidate: string): string {
  if (path.isAbsolute(candidate)) return candidate;
  return path.resolve(fsRoot, candidate);
}
