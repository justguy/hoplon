/**
 * tests/benchmark/t064/directPath.ts — "direct" path primitives.
 *
 * These are the raw host-file surfaces an ordinary agent would have
 * without Hoplon: node:fs for reads and writes, ripgrep subprocess for
 * raw-text search. No snapshot, no audit, no manifest awareness.
 *
 * Each primitive records tool-turn + byte counters into the supplied
 * DirectPathMeter so the harness can attribute cost to the path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DirectPathMeter {
  turns: number;
  bytesRead: number;
  bytesWritten: number;
  fallbackUsed: boolean;
  notes: string[];
}

export function createDirectMeter(): DirectPathMeter {
  return { turns: 0, bytesRead: 0, bytesWritten: 0, fallbackUsed: false, notes: [] };
}

export function directReadFile(
  meter: DirectPathMeter,
  workspaceRoot: string,
  relPath: string,
): string {
  meter.turns += 1;
  const abs = path.resolve(workspaceRoot, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  meter.bytesRead += Buffer.byteLength(content, 'utf8');
  return content;
}

export function directWriteFile(
  meter: DirectPathMeter,
  workspaceRoot: string,
  relPath: string,
  content: string,
): void {
  meter.turns += 1;
  const abs = path.resolve(workspaceRoot, relPath);
  fs.writeFileSync(abs, content);
  meter.bytesWritten += Buffer.byteLength(content, 'utf8');
}

export interface DirectGrepMatch {
  path: string;
  line: number;
  text: string;
}

export function directGrep(
  meter: DirectPathMeter,
  workspaceRoot: string,
  pattern: string,
  glob: string | null,
): DirectGrepMatch[] {
  meter.turns += 1;
  const args = ['--line-number', '--no-heading', '--color=never'];
  if (glob !== null) args.push('--glob', glob);
  args.push(pattern, workspaceRoot);
  const res = spawnSync('rg', args, { encoding: 'utf8', timeout: 10_000 });
  if (res.status !== 0 && res.status !== 1) {
    meter.notes.push(`rg exited ${res.status ?? 'null'}: ${res.stderr?.slice(0, 120) ?? ''}`);
    return [];
  }
  const out = res.stdout ?? '';
  meter.bytesRead += Buffer.byteLength(out, 'utf8');
  const matches: DirectGrepMatch[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    // ripgrep format: <path>:<line>:<text>
    const firstColon = line.indexOf(':');
    if (firstColon < 0) continue;
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon < 0) continue;
    const p = line.slice(0, firstColon);
    const l = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(l)) continue;
    const text = line.slice(secondColon + 1);
    matches.push({ path: p, line: l, text });
  }
  return matches;
}
