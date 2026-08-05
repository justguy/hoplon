/**
 * launcher/queryFlags.ts — argv flag helpers shared by `hoplon query`
 * subcommands. Extracted so query.ts can stay under the 300-line cap as
 * the read-only intelligence surface grows (t-056).
 */

import type { QueryFormat } from './query.js';
import type { LauncherWorkspaceConfig } from './config.js';

export interface QueryFlagBag {
  get(name: string): string | undefined;
  getAll(name: string): string[];
}

export function collectQueryFlags(argv: readonly string[]): QueryFlagBag {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    let name: string;
    let value: string;
    if (eq !== -1) {
      name = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = 'true';
      }
    }
    single.set(name, value);
    const list = multi.get(name) ?? [];
    list.push(value);
    multi.set(name, list);
  }
  return {
    get: (n) => single.get(n),
    getAll: (n) => multi.get(n) ?? [],
  };
}

export function parseFormat(
  raw: string | undefined,
): { kind: 'parsed'; value: QueryFormat } | { kind: 'error'; message: string } {
  if (raw === undefined) return { kind: 'parsed', value: 'json' };
  if (raw === 'json' || raw === 'human') return { kind: 'parsed', value: raw };
  return { kind: 'error', message: `Unknown --format: ${raw}` };
}

export function generateQueryIds(
  workspace: LauncherWorkspaceConfig,
  now: () => number,
): { projectId: string; runId: string; correlationId: string } {
  const ts = now();
  return {
    projectId: workspace.engineId,
    runId: `cli-${ts}`,
    correlationId: `cli-query-${ts}`,
  };
}

export function parsePositiveIntFlag(
  raw: string | undefined,
  flagName: string,
): { kind: 'value'; value: number | undefined } | { kind: 'error'; message: string } {
  if (raw === undefined) return { kind: 'value', value: undefined };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'error', message: `--${flagName} must be a positive integer; got ${raw}` };
  }
  return { kind: 'value', value: parsed };
}
