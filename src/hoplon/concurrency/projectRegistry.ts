/**
 * concurrency/projectRegistry.ts — multi-project registration for t-080.
 *
 * A `ProjectRegistry` tracks additional project roots (dotfiles, scratch
 * workspaces, etc.) as explicit **projects** with their own projectId, fsRoot,
 * and per-project policy. The launcher and transport resolve incoming requests
 * to a specific project root through this registry rather than accepting
 * arbitrary paths.
 *
 * Contract:
 *   - Registration is validated — a projectId may be registered exactly once,
 *     fsRoot must be an absolute path.
 *   - Registration is *pure data* — no engine or project filesystem I/O here.
 *     The launcher owns those side effects via `engineRouter`. The one exception
 *     is locating the grammars bundled with the installed hoplon package when a
 *     project omits `grammarsDir` (a read-only, package-scoped asset lookup — it
 *     never touches project files); the launcher still validates grammar
 *     presence before building the engine.
 *   - "Active project" is an explicit launcher-owned pointer; the registry
 *     records it, no hot-path special-casing happens here.
 *   - Each project carries its own policy (revertAllowlist, secretPatterns,
 *     maxFileBytes, parseTimeoutMs, gitRepoDir, grammarsDir, engineId). These
 *     are copied into the per-project HoplonEngineConfig so cross-project
 *     bleed is structurally impossible.
 *
 * This file does not import from engine/session/contracts — it is a pure
 * data surface that the router/launcher compose on top of.
 */

import { validateFolderPolicy } from './projectPolicyValidation.js';
import { resolvePackagedGrammarsDir } from '../engine/grammarsDir.js';
import { ProjectRegistryError } from './projectRegistryTypes.js';
import type {
  CreateProjectRegistryOptions,
  ProjectPolicy,
  ProjectRegistry,
  RegisteredProject,
  RegisterProjectInput,
} from './projectRegistryTypes.js';

export { ProjectRegistryError } from './projectRegistryTypes.js';
export type {
  CreateProjectRegistryOptions,
  ProjectPolicy,
  ProjectRegistry,
  ProjectRegistryErrorKind,
  RegisteredProject,
  RegisterProjectInput,
} from './projectRegistryTypes.js';

/**
 * Per-project policy knobs that survive across calls. Anything that
 * affects how the engine treats this project's bytes lives here so
 * cross-project bleed is avoided.
 */
function validateProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new ProjectRegistryError(
      'invalid_input',
      'projectId must be a non-empty string',
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-.]*$/.test(projectId)) {
    throw new ProjectRegistryError(
      'invalid_input',
      `projectId '${projectId}' must match /^[a-zA-Z0-9][a-zA-Z0-9_\\-.]*$/ — no path separators or whitespace`,
      projectId,
    );
  }
}

function validateFsRoot(fsRoot: unknown, projectId: string): asserts fsRoot is string {
  if (typeof fsRoot !== 'string' || fsRoot.length === 0) {
    throw new ProjectRegistryError(
      'invalid_input',
      `fsRoot for '${projectId}' must be a non-empty string`,
      projectId,
    );
  }
  // Require absolute path — path escape defense.
  // Use a platform-agnostic check: POSIX absolute (/...) or Windows drive (X:\...).
  const isPosixAbs = fsRoot.startsWith('/');
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(fsRoot);
  if (!isPosixAbs && !isWindowsAbs) {
    throw new ProjectRegistryError(
      'invalid_input',
      `fsRoot for '${projectId}' must be an absolute path; got '${fsRoot}'`,
      projectId,
    );
  }
}

/**
 * Factory for a fresh in-memory project registry.
 *
 * No persistence here; persistence is launcher-owned through the
 * `projectsFile` helper in `launcher/projectsStore.ts`.
 */
export function createProjectRegistry(
  opts: CreateProjectRegistryOptions = {},
): ProjectRegistry {
  const entries = new Map<string, RegisteredProject>();
  let activeId: string | null = null;

  function existingProjectIdForFsRoot(fsRoot: string): string | null {
    for (const entry of entries.values()) {
      if (entry.fsRoot === fsRoot) return entry.projectId;
    }
    return null;
  }

  // Seed (from persisted state) with validation so bad disk state surfaces
  // honestly rather than silently bypassing the rules.
  if (opts.seed) {
    for (const rec of opts.seed) {
      validateProjectId(rec.projectId);
      validateFsRoot(rec.fsRoot, rec.projectId);
      if (entries.has(rec.projectId)) {
        throw new ProjectRegistryError(
          'duplicate_project',
          `Duplicate projectId '${rec.projectId}' in seed`,
          rec.projectId,
        );
      }
      const existingFsRootOwner = existingProjectIdForFsRoot(rec.fsRoot);
      if (existingFsRootOwner !== null) {
        throw new ProjectRegistryError(
          'duplicate_project',
          `Duplicate fsRoot '${rec.fsRoot}' in seed: already registered by project '${existingFsRootOwner}'`,
          rec.projectId,
        );
      }
      const seededPolicy = normalizePolicy(rec.policy);
      entries.set(
        rec.projectId,
        seededPolicy === rec.policy
          ? rec
          : Object.freeze({ ...rec, policy: seededPolicy }),
      );
    }
  }

  if (opts.activeProjectId !== undefined) {
    if (!entries.has(opts.activeProjectId)) {
      throw new ProjectRegistryError(
        'unknown_project',
        `Cannot set active to unknown projectId '${opts.activeProjectId}'`,
        opts.activeProjectId,
      );
    }
    activeId = opts.activeProjectId;
  }

  function register(input: RegisterProjectInput): RegisteredProject {
    validateProjectId(input.projectId);
    validateFsRoot(input.fsRoot, input.projectId);
    if (entries.has(input.projectId)) {
      throw new ProjectRegistryError(
        'duplicate_project',
        `Project '${input.projectId}' is already registered`,
        input.projectId,
      );
    }
    const existingFsRootOwner = existingProjectIdForFsRoot(input.fsRoot);
    if (existingFsRootOwner !== null) {
      throw new ProjectRegistryError(
        'duplicate_project',
        `fsRoot '${input.fsRoot}' is already registered by project '${existingFsRootOwner}' — each project must own a distinct root`,
        input.projectId,
      );
    }

    const nowIso = input.registeredAtIso ?? new Date().toISOString();
    const label =
      typeof input.label === 'string' && input.label.length > 0
        ? input.label
        : input.projectId;
    const policy = normalizePolicy(input.policy);

    const record: RegisteredProject = Object.freeze({
      projectId: input.projectId,
      fsRoot: input.fsRoot,
      gitRepoDir: input.gitRepoDir ?? '.hoplon/repo',
      dbPath: input.dbPath ?? `${input.fsRoot}/.hoplon/hoplon.db`,
      // F1: default to the grammars bundled with the installed hoplon package
      // (resolved relative to the package on disk), NOT `<project>/vendor/grammars`,
      // which normally does not exist for an external project. An explicit
      // grammarsDir always wins. The legacy project-relative path remains only as
      // a last resort when packaged grammars cannot be located at all — the
      // launcher validates presence before building the engine.
      grammarsDir:
        input.grammarsDir ??
        resolvePackagedGrammarsDir() ??
        `${input.fsRoot}/vendor/grammars`,
      engineId: input.engineId ?? `local-${input.projectId}`,
      policy,
      label,
      registeredAtIso: nowIso,
    });

    entries.set(record.projectId, record);
    return record;
  }

  function unregister(projectId: string): void {
    validateProjectId(projectId);
    if (!entries.has(projectId)) {
      throw new ProjectRegistryError(
        'unknown_project',
        `Project '${projectId}' is not registered`,
        projectId,
      );
    }
    entries.delete(projectId);
    if (activeId === projectId) activeId = null;
  }

  function get(projectId: string): RegisteredProject | null {
    return entries.get(projectId) ?? null;
  }

  function list(): readonly RegisteredProject[] {
    return [...entries.values()].sort((a, b) =>
      a.projectId.localeCompare(b.projectId),
    );
  }

  function has(projectId: string): boolean {
    return entries.has(projectId);
  }

  function getActive(): RegisteredProject | null {
    if (activeId === null) return null;
    return entries.get(activeId) ?? null;
  }

  function setActive(projectId: string): void {
    validateProjectId(projectId);
    if (!entries.has(projectId)) {
      throw new ProjectRegistryError(
        'unknown_project',
        `Cannot set active to unknown projectId '${projectId}'`,
        projectId,
      );
    }
    activeId = projectId;
  }

  function clearActive(): void {
    activeId = null;
  }

  function size(): number {
    return entries.size;
  }

  return {
    register,
    unregister,
    get,
    list,
    has,
    getActive,
    setActive,
    clearActive,
    size,
  };
}

function normalizePolicy(
  policy: ProjectPolicy | undefined,
): Readonly<ProjectPolicy> {
  if (policy === undefined) return Object.freeze({});
  if (policy.folderPolicy === undefined) {
    return Object.freeze({ ...policy });
  }
  const folderPolicy = validateFolderPolicy(policy.folderPolicy);
  return Object.freeze({ ...policy, folderPolicy });
}
