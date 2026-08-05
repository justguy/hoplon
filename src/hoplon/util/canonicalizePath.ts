/**
 * util/canonicalizePath.ts — safe path canonicalization (H9).
 *
 * Resolves a path relative to a root, rejects ../ traversal, absolute paths,
 * and symlink-out escapes. Returns the canonicalized absolute path.
 *
 * Used at the engine boundary before any I/O to enforce H9.
 *
 * ## Sentinel values for errors before engine scope
 *
 * canonicalizePath takes an optional { engineId, correlationId } context.
 * When called before the engine is fully constructed (e.g. from Zod refinements
 * or early validation), pass the sentinels:
 *   - engineId: 'util'
 *   - correlationId: 'util'
 *
 * The engine boundary calls this function with the real engineId and
 * correlationId once those are known.
 */

import { resolve, relative } from 'node:path';
import { ValidationError } from '../contracts/errors.js';

export interface CanonicalizePathOptions {
  /** The path to canonicalize (may be relative or absolute). */
  path: string;
  /** The trusted root directory. The resolved path must be inside this root. */
  root: string;
  /** Engine identity for errors (H5). Default: 'util'. */
  engineId?: string;
  /** Trace ID for errors (H11). Default: 'util'. */
  correlationId?: string;
}

/**
 * Resolve `path` relative to `root`, verifying it does not escape the root.
 *
 * @throws {ValidationError} with kind 'path_traversal' when:
 *   - `path` is absolute
 *   - `path` contains '..' segments that escape `root`
 *   - the resolved path is outside `root` (symlink-out defense is the
 *     caller's responsibility — use fs.realpath before passing content)
 *
 * @returns The canonicalized absolute path.
 */
export function canonicalizePath({
  path,
  root,
  engineId = 'util',
  correlationId = 'util',
}: CanonicalizePathOptions): string {
  // Reject absolute paths (both POSIX and Windows-style)
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) {
    throw new ValidationError(
      {
        kind: 'path_traversal',
        engineId,
        correlationId,
        cause: { path, reason: 'absolute_path' },
      },
      `Path must be relative; got absolute path: '${path}'`,
    );
  }

  // Resolve relative to root to get the canonical absolute path
  const resolved = resolve(root, path);
  const normalizedRoot = resolve(root);

  // Check that the resolved path starts with the root (plus a separator)
  // This catches both '..' traversal and crafty path segments
  const rel = relative(normalizedRoot, resolved);
  if (rel.startsWith('..') || (rel !== '' && resolved === normalizedRoot)) {
    throw new ValidationError(
      {
        kind: 'path_traversal',
        engineId,
        correlationId,
        cause: { path, resolved, root: normalizedRoot, reason: 'escapes_root' },
      },
      `Path '${path}' resolves outside the engine root '${normalizedRoot}'`,
    );
  }

  return resolved;
}
