/**
 * launcher/projectCliHelpers.ts — shared parsing helpers for the
 * `hoplon project ...` CLI surface.
 *
 * Kept separate from `projectCli.ts` so the CLI parser + runner file stays
 * under the 300-line architecture cap. Both helpers are pure / synchronous
 * and rely only on stdlib modules.
 */
import * as fs from 'node:fs';

import { parsePersistedFolderPolicy } from './projectsPolicySchema.js';
import type { FolderPolicy } from '../concurrency/projectPolicy.js';

/** Extract `--flag value` and `--flag=value` forms into a map. */
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

/**
 * Load and validate a folder-policy JSON file via the shared persisted
 * schema parser. Returns a typed success / failure tuple so the caller can
 * fold it into `ProjectCommandOutcome` without duplicating error kinds.
 */
export function loadFolderPolicyFile(
  filePath: string,
):
  | { ok: true; policy: FolderPolicy }
  | { ok: false; errorKind: string; message: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errorKind: 'folder_policy_file_unreadable',
      message: `Cannot read folder-policy file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errorKind: 'folder_policy_file_invalid_json',
      message: `Folder-policy file '${filePath}' is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  try {
    return { ok: true, policy: parsePersistedFolderPolicy(parsed, 0, filePath) };
  } catch (err) {
    return {
      ok: false,
      errorKind: 'folder_policy_file_invalid_shape',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
