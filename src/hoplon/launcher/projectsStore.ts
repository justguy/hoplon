/**
 * launcher/projectsStore.ts — durable project registry persistence (t-080).
 *
 * Registrations are the durable artifact for multi-project use. This
 * module owns the launcher-side read/write of the on-disk registry file
 * (default `<launcherRoot>/.hoplon/projects.json`). The registry file is
 * separate from the launcher workspace's SQLite snapshot store; it is an
 * operator-facing list of registered projects, not a snapshot log.
 *
 * Design decisions:
 *   - JSON format, easy to inspect / audit by humans.
 *   - Version field (`version: 1`). Future schema changes add a version
 *     bump and a migration path.
 *   - Validation runs every load. Corrupt/invalid files raise a typed
 *     `ProjectsStoreError` rather than silently dropping entries.
 *   - Writes are atomic via write-then-rename, so a crash mid-write
 *     never leaves the registry half-updated.
 *
 * The schema / parsing / serialization helpers live in `projectsStoreSchema.ts`
 * to honor the 300-line-per-file architecture rule.
 *
 * Intentional non-goals: this file does NOT construct engines, open SQLite,
 * or touch the project's fsRoot. Persistence and engine construction stay
 * separate concerns (H2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegisteredProject } from '../concurrency/projectRegistry.js';
import {
  PROJECTS_STORE_VERSION,
  ProjectsSchemaError,
  parseProjectsFile,
  toPersistedProject,
  type PersistedProjectsFile,
} from './projectsStoreSchema.js';

export { PROJECTS_STORE_VERSION } from './projectsStoreSchema.js';

export const DEFAULT_PROJECTS_STORE_RELATIVE = '.hoplon/projects.json';

export type ProjectsStoreErrorKind =
  | 'invalid_json'
  | 'invalid_schema'
  | 'invalid_version'
  | 'write_failed'
  | 'read_failed';

export class ProjectsStoreError extends Error {
  public readonly kind: ProjectsStoreErrorKind;
  public readonly file: string;
  public override readonly cause?: unknown;

  constructor(
    kind: ProjectsStoreErrorKind,
    file: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectsStoreError';
    this.kind = kind;
    this.file = file;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Resolve the projects-store path for a launcher workspace. Always
 * rooted under the launcher's `.hoplon/` directory.
 */
export function resolveProjectsStorePath(launcherRoot: string): string {
  return path.join(launcherRoot, DEFAULT_PROJECTS_STORE_RELATIVE);
}

/**
 * Load the on-disk projects registry.
 *
 * When the file does not exist, returns an empty snapshot with no active
 * project — the launcher treats a fresh workspace as "no additional
 * projects registered yet," not as an error.
 */
export function loadProjectsStore(filePath: string): {
  projects: RegisteredProject[];
  activeProjectId: string | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { projects: [], activeProjectId: null };
    }
    throw new ProjectsStoreError(
      'read_failed',
      filePath,
      `Failed to read projects registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectsStoreError(
      'invalid_json',
      filePath,
      `Projects registry at ${filePath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  try {
    return parseProjectsFile(parsed, filePath);
  } catch (err) {
    if (err instanceof ProjectsSchemaError) {
      throw new ProjectsStoreError(err.kind, filePath, err.message, err);
    }
    throw err;
  }
}

/**
 * Persist the projects registry to disk atomically (write + rename).
 */
export function saveProjectsStore(
  filePath: string,
  snapshot: {
    projects: readonly RegisteredProject[];
    activeProjectId: string | null;
  },
): void {
  const body: PersistedProjectsFile = {
    version: PROJECTS_STORE_VERSION,
    activeProjectId: snapshot.activeProjectId,
    projects: snapshot.projects.map(toPersistedProject),
  };

  const json = `${JSON.stringify(body, null, 2)}\n`;
  const dir = path.dirname(filePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new ProjectsStoreError(
      'write_failed',
      filePath,
      `Failed to create projects registry directory '${dir}': ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup.
    }
    throw new ProjectsStoreError(
      'write_failed',
      filePath,
      `Failed to persist projects registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
