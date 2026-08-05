/**
 * operations/seeCodebaseRaw.ts — t-061 raw file read + raw text search
 * primitives behind `see_codebase`.
 *
 * Keeps raw surfaces behind the FS adapter seam. `rawFileRead` canonicalizes
 * the path and returns verbatim bytes as UTF-8 text (callers that need
 * non-UTF-8 support must route an explicit decoder through the adapter).
 * `rawTextSearch` walks the project with SKIP_DIRS respected (node_modules,
 * .git, .hoplon, dist, build, .next, .turbo, coverage) and applies the
 * caller-supplied regex to each line.
 *
 * Import wall: adapters + util only.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import {
  assertStrictPathClass,
  assertStrictPathWithinFolder,
  assertStrictReadableBytes,
  assertStrictReadableFile,
  isStrictReadablePath,
} from './seeCodebaseFilePolicy.js';
import { SKIP_DIRS } from './getRelevantTestsInternal.js';

const RAW_DEFAULT_MAX_RESULTS = 500;
const RAW_SEARCH_MAX_FILES = 10_000;

export interface RawFileReadOptions {
  engineId: string;
  correlationId: string;
  root: string;
  maxBytes?: number;
  strictFilePolicy?: boolean;
  strictFolder?: string;
}

export interface RawFileReadResult {
  path: string;
  bytes: number;
  originalBytes: number;
  content: string;
  truncated: boolean;
}

interface RawPathNotFoundError extends Error {
  kind: 'path_not_found';
  targetPath: string;
}

export async function rawFileRead(
  fs: HoplonFsAdapter,
  rawPath: string,
  opts: RawFileReadOptions,
): Promise<RawFileReadResult> {
  // Validate traversal safety; the adapter interprets paths relative to its
  // own root, so we keep the caller-supplied relative form on the wire.
  canonicalizePath({
    path: rawPath,
    root: opts.root,
    engineId: opts.engineId,
    correlationId: opts.correlationId,
  });
  if (opts.strictFilePolicy) {
    assertStrictPathClass(rawPath);
    assertStrictPathWithinFolder(rawPath, opts.strictFolder ?? '');
  }
  const stat = await fs.stat(rawPath);
  if (!stat.exists || !stat.isFile) throw rawPathNotFound(rawPath);
  let bytes: Uint8Array;
  try {
    bytes = await fs.read(rawPath);
  } catch (err) {
    if (isMissingFsError(err)) throw rawPathNotFound(rawPath);
    throw err;
  }
  if (opts.strictFilePolicy) assertStrictReadableBytes(rawPath, bytes);
  const effectiveBytes =
    typeof opts.maxBytes === 'number' && opts.maxBytes > 0
      ? bytes.subarray(0, Math.min(bytes.length, opts.maxBytes))
      : bytes;
  const truncated = effectiveBytes.length < bytes.length;
  return {
    path: rawPath,
    bytes: effectiveBytes.length,
    originalBytes: bytes.length,
    content: new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(effectiveBytes),
    truncated,
  };
}

function rawPathNotFound(path: string): RawPathNotFoundError {
  const err = new Error(`see_codebase: target path not found: '${path}'`) as RawPathNotFoundError;
  err.kind = 'path_not_found';
  err.targetPath = path;
  return err;
}

function isMissingFsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export interface RawTextSearchOptions {
  engineId: string;
  correlationId: string;
  root: string;
  regex: RegExp;
  scope?: readonly string[];
  maxResults?: number;
  maxFileBytes: number;
  strictFilePolicy?: boolean;
  strictFolder?: string;
}

export interface RawTextMatch {
  path: string;
  line: number;
  byteOffset: number;
  text: string;
}

export interface RawTextSearchResult {
  matches: RawTextMatch[];
  filesScanned: number;
  truncated: boolean;
}

export async function rawTextSearch(
  fs: HoplonFsAdapter,
  opts: RawTextSearchOptions,
): Promise<RawTextSearchResult> {
  const cap = opts.maxResults ?? RAW_DEFAULT_MAX_RESULTS;
  const matches: RawTextMatch[] = [];
  const files: string[] = [];
  const scope =
    opts.strictFilePolicy && (!opts.scope || opts.scope.length === 0)
      ? [opts.strictFolder && opts.strictFolder.length > 0 ? opts.strictFolder : '.']
      : opts.scope;
  if (scope && scope.length > 0) {
    for (const s of scope) {
      canonicalizePath({
        path: s,
        root: opts.root,
        engineId: opts.engineId,
        correlationId: opts.correlationId,
      });
      if (opts.strictFilePolicy) {
        assertStrictPathWithinFolder(s, opts.strictFolder ?? '');
      }
      const stat = await fs.stat(s);
      if (!stat.exists) continue;
      if (stat.isFile) {
        if (opts.strictFilePolicy) {
          await assertStrictReadableFile(fs, s);
        }
        files.push(s);
      } else {
        await collectAllFiles(fs, s, files, opts.strictFilePolicy ?? false);
      }
      if (files.length >= RAW_SEARCH_MAX_FILES) break;
    }
  } else {
    await collectAllFiles(fs, '.', files, opts.strictFilePolicy ?? false);
  }
  files.sort();
  let truncated = false;
  let filesScanned = 0;
  for (const file of files) {
    if (matches.length >= cap) {
      truncated = true;
      break;
    }
    filesScanned += 1;
    let bytes: Uint8Array;
    try {
      const stat = await fs.stat(file);
      if (!stat.exists || !stat.isFile) continue;
      if (stat.size > opts.maxFileBytes) continue;
      bytes = await fs.read(file);
    } catch {
      continue;
    }
    const text = tryDecode(bytes);
    if (text === undefined) continue;
    scanLines(file, text, opts.regex, cap, matches);
  }
  return { matches, filesScanned, truncated: truncated || matches.length >= cap };
}

async function collectAllFiles(
  fs: HoplonFsAdapter,
  dir: string,
  out: string[],
  strictFilePolicy: boolean,
): Promise<void> {
  if (out.length >= RAW_SEARCH_MAX_FILES) return;
  let entries: string[];
  try {
    entries = await fs.list(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= RAW_SEARCH_MAX_FILES) return;
    const entryPath = dir === '.' ? entry : `${dir}/${entry}`;
    let stat: { exists: boolean; isFile: boolean; size: number };
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }
    if (!stat.exists) continue;
    if (stat.isFile) {
      if (!strictFilePolicy || isStrictReadablePath(entryPath)) {
        out.push(entryPath);
      }
    } else {
      if (SKIP_DIRS.has(entry)) continue;
      await collectAllFiles(fs, entryPath, out, strictFilePolicy);
    }
  }
}

function tryDecode(bytes: Uint8Array): string | undefined {
  // Skip likely-binary files: presence of NUL byte in the first 1KiB is the
  // standard heuristic and matches ripgrep's default behavior.
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function scanLines(
  path: string,
  text: string,
  regex: RegExp,
  cap: number,
  out: RawTextMatch[],
): void {
  let byteOffset = 0;
  let line = 0;
  let cursor = 0;
  const encoder = new TextEncoder();
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const end = nl === -1 ? text.length : nl;
    const lineText = text.slice(cursor, end);
    line += 1;
    if (regex.test(lineText)) {
      out.push({ path, line, byteOffset, text: lineText });
      if (out.length >= cap) return;
    }
    byteOffset += encoder.encode(lineText).length + (nl === -1 ? 0 : 1);
    if (nl === -1) break;
    cursor = nl + 1;
  }
}
