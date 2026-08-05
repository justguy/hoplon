import type { LauncherWorkspaceInput } from './config.js';

export function collectFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(token.slice(2), next);
        i++;
      } else {
        flags.set(token.slice(2), 'true');
      }
    }
  }
  return flags;
}

export function flagsToWorkspace(flags: Map<string, string>): LauncherWorkspaceInput {
  const ws: LauncherWorkspaceInput = {};
  const root = flags.get('root');
  if (root) ws.root = root;
  const db = flags.get('db');
  if (db) ws.dbPath = db;
  const gitRepoDir = flags.get('git-repo-dir');
  if (gitRepoDir) ws.gitRepoDir = gitRepoDir;
  const grammarsDir = flags.get('grammars-dir');
  if (grammarsDir) ws.grammarsDir = grammarsDir;
  const engineId = flags.get('engine-id');
  if (engineId) ws.engineId = engineId;
  return ws;
}
