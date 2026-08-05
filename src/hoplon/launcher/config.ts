/**
 * launcher/config.ts — workspace resolution for the local launcher.
 *
 * Resolves the workspace root, DB path, git repo dir, grammars dir, and
 * engineId from either caller-supplied overrides or safe defaults rooted
 * at CWD. This file is pure data — it never starts an engine or touches
 * adapters directly. Callers pass the resolved config into the Phase 1
 * createDefaultHoplonEngine factory.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LauncherWorkspaceInput {
  root?: string;
  dbPath?: string;
  gitRepoDir?: string;
  grammarsDir?: string;
  engineId?: string;
}

export interface LauncherWorkspaceConfig {
  root: string;
  dbPath: string;
  gitRepoDir: string;
  grammarsDir: string;
  engineId: string;
}

const DEFAULT_DB_RELATIVE = '.hoplon/hoplon.db';
const DEFAULT_GIT_REPO_RELATIVE = '.hoplon/repo';
const DEFAULT_ENGINE_ID = 'local-0';
const LOCAL_GRAMMARS_RELATIVE = 'vendor/grammars';

/**
 * Resolve a launcher workspace config from partial user input.
 *
 * - `root` defaults to `process.cwd()`.
 * - `dbPath` defaults to `<root>/.hoplon/hoplon.db`.
 * - `gitRepoDir` defaults to `.hoplon/repo` (engine resolves relative paths
 *   against the fsRoot internally).
 * - `grammarsDir` defaults to the packaged grammars bundled under the
 *   distributed Hoplon package; falls back to `<root>/vendor/grammars`
 *   only when the packaged assets cannot be located (e.g. dev checkout).
 * - `engineId` defaults to `local-0`.
 */
export function resolveLauncherWorkspace(
  input: LauncherWorkspaceInput = {},
): LauncherWorkspaceConfig {
  const root = path.resolve(input.root ?? process.cwd());
  const dbPath = input.dbPath
    ? resolveFromWorkspaceRoot(root, input.dbPath)
    : path.join(root, DEFAULT_DB_RELATIVE);
  const gitRepoDir = input.gitRepoDir ?? DEFAULT_GIT_REPO_RELATIVE;
  const grammarsDir = input.grammarsDir
    ? resolveFromWorkspaceRoot(root, input.grammarsDir)
    : resolveDefaultGrammarsDir(root);
  const engineId = input.engineId ?? DEFAULT_ENGINE_ID;

  return { root, dbPath, gitRepoDir, grammarsDir, engineId };
}

/**
 * Ensure the workspace layout needed by the default engine exists on disk.
 *
 * Creates the parent directories of `dbPath` and the internal git repo so
 * the Phase 1 adapters can open their backing files without surprise. Any
 * real filesystem problem (non-directory sitting at the path, EACCES, …)
 * is surfaced by the adapter later with a typed HoplonError.
 */
export function ensureWorkspaceLayout(workspace: LauncherWorkspaceConfig): void {
  try {
    fs.mkdirSync(path.dirname(workspace.dbPath), { recursive: true });
  } catch {
    // Let the engine factory surface real errors with a proper HoplonError kind.
  }
  try {
    const repoDir = path.isAbsolute(workspace.gitRepoDir)
      ? workspace.gitRepoDir
      : path.join(workspace.root, workspace.gitRepoDir);
    fs.mkdirSync(repoDir, { recursive: true });
  } catch {
    // Same as above.
  }
}

/**
 * Find the grammars directory shipped with this package. Walks upward from
 * the current module file looking for a `vendor/grammars` sibling; falls
 * back to `<root>/vendor/grammars` when nothing is found (dev checkout).
 */
function resolveDefaultGrammarsDir(root: string): string {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    const candidate = path.join(dir, LOCAL_GRAMMARS_RELATIVE);
    if (existsSyncSafe(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(root, LOCAL_GRAMMARS_RELATIVE);
}

function existsSyncSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveFromWorkspaceRoot(root: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}
