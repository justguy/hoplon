import type { HoplonFsAdapter } from '../adapters/fs.js';

const JS_TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hoplon',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
]);

interface IgnoreRule {
  pattern: string;
  negated: boolean;
  anchored: boolean;
  hasSlash: boolean;
  regex: RegExp;
}

export function isJsTsFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return JS_TS_EXTENSIONS.has(filePath.slice(dot));
}

export async function collectFiles(fs: HoplonFsAdapter, dir: string): Promise<string[]> {
  const ignoreRules = await loadRootGitignore(fs);
  return collectFilesWithRules(fs, dir, ignoreRules);
}

async function collectFilesWithRules(
  fs: HoplonFsAdapter,
  dir: string,
  ignoreRules: readonly IgnoreRule[],
): Promise<string[]> {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = await fs.list(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const entryPath = dir === '.' ? entry : `${dir}/${entry}`;
    let stat: { exists: boolean; isFile: boolean; size: number };
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }
    if (!stat.exists) continue;

    const isDirectory = !stat.isFile;
    if (isIgnoredByGitignore(entryPath, isDirectory, ignoreRules)) continue;

    if (stat.isFile) {
      if (isJsTsFile(entryPath)) result.push(entryPath);
    } else {
      if (SKIP_DIRS.has(entry)) continue;
      const sub = await collectFilesWithRules(fs, entryPath, ignoreRules);
      for (const f of sub) result.push(f);
    }
  }
  return result;
}

async function loadRootGitignore(fs: HoplonFsAdapter): Promise<IgnoreRule[]> {
  let stat: { exists: boolean; isFile: boolean; size: number };
  try {
    stat = await fs.stat('.gitignore');
  } catch {
    return [];
  }
  if (!stat.exists || !stat.isFile) return [];

  try {
    const bytes = await fs.read('.gitignore');
    return parseGitignore(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return [];
  }
}

function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    if (pattern.length === 0) continue;

    if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    pattern = normalizeRelativePath(pattern);
    if (pattern.length === 0) continue;

    const hasSlash = pattern.includes('/');
    rules.push({
      pattern,
      negated,
      anchored,
      hasSlash,
      regex: new RegExp(`^${globToRegExpSource(pattern)}$`),
    });
  }
  return rules;
}

function isIgnoredByGitignore(
  path: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  const normalized = normalizeRelativePath(path);
  const segments = normalized.split('/');
  let ignored = false;
  for (const rule of rules) {
    if (matchesIgnoreRule(rule, normalized, segments, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function matchesIgnoreRule(
  rule: IgnoreRule,
  path: string,
  segments: readonly string[],
  isDirectory: boolean,
): boolean {
  if (rule.hasSlash || rule.anchored) {
    if (rule.regex.test(path)) return true;
    return path.startsWith(`${rule.pattern}/`);
  }
  for (const segment of segments) {
    if (rule.regex.test(segment)) return true;
  }
  return isDirectory && rule.regex.test(segments[segments.length - 1] ?? '');
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
}

function globToRegExpSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(ch);
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
