/**
 * operations/getRelevantTestsInternal.ts — Internal helpers for LC10
 * getRelevantTests. Split from getRelevantTests.ts per the 300-line law.
 *
 * Contains: file collection, import graph construction, BFS traversal,
 * path normalization, dynamic import query definitions.
 *
 * ## Import wall
 *   Imports only from ../contracts/*, ./stdQueries, ./queryStructure.
 *   Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import { posix } from 'node:path';
import type { QueryMatch } from '../contracts/queryStructure.js';
import type { TreeSitterQuery } from '../contracts/queryStructure.js';
export { collectFiles, isJsTsFile, SKIP_DIRS } from './getRelevantTestsFileCollection.js';

// ---------------------------------------------------------------------------
// Dynamic require() / import() detection queries
// ---------------------------------------------------------------------------

/**
 * Detects require() and import() calls that static import graph extraction
 * cannot prove as complete coverage.
 */
export const DYNAMIC_REQUIRE_JS: TreeSitterQuery = {
  id: 'detect-dynamic-require',
  language: 'javascript',
  pattern: `(call_expression function: (identifier) @fn (#eq? @fn "require") arguments: (arguments (_) @req_arg))`,
};

export const DYNAMIC_REQUIRE_TS: TreeSitterQuery = {
  id: 'detect-dynamic-require',
  language: 'typescript',
  pattern: `(call_expression function: (identifier) @fn (#eq? @fn "require") arguments: (arguments (_) @req_arg))`,
};

export const DYNAMIC_REQUIRE_TSX: TreeSitterQuery = {
  id: 'detect-dynamic-require',
  language: 'tsx',
  pattern: `(call_expression function: (identifier) @fn (#eq? @fn "require") arguments: (arguments (_) @req_arg))`,
};

export const DYNAMIC_IMPORT_JS: TreeSitterQuery = {
  id: 'detect-dynamic-import',
  language: 'javascript',
  pattern: `(call_expression function: (_) @fn (#eq? @fn "import") arguments: (arguments (_) @import_arg))`,
};

export const DYNAMIC_IMPORT_TS: TreeSitterQuery = {
  id: 'detect-dynamic-import',
  language: 'typescript',
  pattern: `(call_expression function: (_) @fn (#eq? @fn "import") arguments: (arguments (_) @import_arg))`,
};

export const DYNAMIC_IMPORT_TSX: TreeSitterQuery = {
  id: 'detect-dynamic-import',
  language: 'tsx',
  pattern: `(call_expression function: (_) @fn (#eq? @fn "import") arguments: (arguments (_) @import_arg))`,
};

export const DYNAMIC_REQUIRE_QUERIES: readonly TreeSitterQuery[] = [
  DYNAMIC_REQUIRE_JS,
  DYNAMIC_REQUIRE_TS,
  DYNAMIC_REQUIRE_TSX,
  DYNAMIC_IMPORT_JS,
  DYNAMIC_IMPORT_TS,
  DYNAMIC_IMPORT_TSX,
];

// ---------------------------------------------------------------------------
// Forward import graph construction
// ---------------------------------------------------------------------------

export type ForwardGraph = Map<string, Set<string>>;

/**
 * Build a forward import graph from queryStructure matches.
 * Each relative import is resolved from the importing file's directory,
 * then matched against known files (with extension fallback).
 *
 * Non-relative imports (package imports) are silently ignored —
 * they can't resolve to project files.
 */
export function buildForwardGraph(
  allFiles: readonly string[],
  matches: readonly QueryMatch[],
): ForwardGraph {
  const graph: ForwardGraph = new Map();
  for (const f of allFiles) {
    graph.set(normalizePath(f), new Set());
  }

  for (const match of matches) {
    const importerNorm = normalizePath(match.path);
    const rawPath = stripQuotes(match.text);
    if (!rawPath || !rawPath.startsWith('.')) continue;

    const importerDir = posix.dirname(importerNorm);
    const resolved = posix.normalize(posix.join(importerDir, rawPath));
    const normalizedResolved = resolved.startsWith('./') ? resolved : `./${resolved}`;

    const edges = graph.get(importerNorm);
    if (edges !== undefined) {
      const candidates = expandExtensions(normalizedResolved);
      for (const candidate of candidates) {
        if (graph.has(candidate)) {
          edges.add(candidate);
          break;
        }
      }
    }
  }

  return graph;
}

/**
 * Expand a path to candidate resolved paths, handling:
 *   - Paths without extension: try common JS/TS extensions + index variants.
 *   - TypeScript ESM convention: '.js' imports may resolve to '.ts' source files,
 *     and '.jsx' imports may resolve to '.tsx' source files.
 *
 * Returns candidates in priority order (most specific first).
 */
export function expandExtensions(resolved: string): string[] {
  const dot = resolved.lastIndexOf('.');
  const lastSlash = resolved.lastIndexOf('/');
  if (dot <= lastSlash) {
    // No extension — try all variants
    return [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}.js`,
      `${resolved}.jsx`,
      `${resolved}/index.ts`,
      `${resolved}/index.js`,
    ];
  }
  // Has extension — try as-is, then TypeScript source remapping
  const ext = resolved.slice(dot);
  const base = resolved.slice(0, dot);
  switch (ext) {
    case '.js':
      // TypeScript ESM: import './foo.js' may be './foo.ts' or './foo.tsx'
      return [resolved, `${base}.ts`, `${base}.tsx`];
    case '.jsx':
      // import './foo.jsx' may be './foo.tsx'
      return [resolved, `${base}.tsx`, `${base}.jsx`];
    default:
      return [resolved];
  }
}

// ---------------------------------------------------------------------------
// BFS traversal
// ---------------------------------------------------------------------------

/**
 * Return the set of files reachable from `start` via forward graph edges
 * within `maxDepth` hops. Does NOT include `start` itself.
 */
export function bfsReachable(
  start: string,
  graph: ForwardGraph,
  maxDepth: number,
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[start, 0]];
  visited.add(start);

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    const [current, depth] = entry;
    if (depth >= maxDepth) continue;

    const neighbors = graph.get(current);
    if (neighbors === undefined) continue;
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, depth + 1]);
      }
    }
  }

  visited.delete(start);
  return visited;
}

// ---------------------------------------------------------------------------
// Path normalization helpers
// ---------------------------------------------------------------------------

export function normalizePath(p: string): string {
  const posixPath = p.replace(/\\/g, '/');
  if (posixPath.startsWith('./') || posixPath.startsWith('/')) return posixPath;
  return `./${posixPath}`;
}

export function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

// ---------------------------------------------------------------------------
// Empty result helper
// ---------------------------------------------------------------------------

import type { TestOracleResult } from '../contracts/getRelevantTests.js';

export function emptyResult(modifiedFiles: string[]): TestOracleResult {
  return {
    relevantTests: [],
    coverageConfidence: 'exact',
    unusedModifiedFiles: [...modifiedFiles].sort(),
  };
}
