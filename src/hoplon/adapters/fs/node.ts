/**
 * adapters/fs/node.ts — Node.js filesystem adapter.
 *
 * Implements HoplonFsAdapter using node:fs/promises.
 * All paths are resolved relative to the root directory supplied at construction.
 *
 * Path traversal defense (H9, defense-in-depth):
 *   After joining root + path the resolved absolute path is checked against root.
 *   If it escapes, throws AdapterError with cause: ValidationError({ kind: 'path_traversal' }).
 *   This is a second layer — the engine already canonicalizes at the request boundary,
 *   but the adapter does not trust that contract.
 */

import { resolve as pathResolve, join, dirname } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { HoplonFsAdapter } from '../fs.js';
import { AdapterError, ValidationError } from '../../contracts/errors.js';

const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

/** Resolve an adapter-relative path to an absolute path, enforcing root containment. */
function resolveAndGuard(root: string, relPath: string, writeOp: boolean): string {
  const abs = pathResolve(join(root, relPath));
  // The root separator prefix handles all cases:
  //   root = '/tmp/project' → abs must start with '/tmp/project/' or be exactly '/tmp/project'
  // When root is '/' the separator becomes '//' which would fail even valid paths, so handle
  // root='/' specially (abs is always inside '/' by definition).
  const rootWithSep = root === '/' ? '/' : root + '/';
  if (!abs.startsWith(rootWithSep) && abs !== root) {
    const traversalCause = new ValidationError(
      {
        kind: 'path_traversal',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: { path: relPath, root, resolved: abs },
      },
      `Path '${relPath}' resolves outside adapter root '${root}'`,
    );
    throw new AdapterError(
      {
        kind: writeOp ? 'fs_write_failed' : 'fs_read_failed',
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: traversalCause,
      },
      `Path traversal rejected: '${relPath}'`,
    );
  }
  return abs;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rootWithSep = root === '/' ? '/' : `${root}/`;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function pathTraversalAdapterError(args: {
  relPath: string;
  root: string;
  resolved: string;
  writeOp: boolean;
}): AdapterError {
  const traversalCause = new ValidationError(
    {
      kind: 'path_traversal',
      engineId: ADAPTER_ENGINE_ID,
      correlationId: ADAPTER_CORRELATION_ID,
      cause: {
        path: args.relPath,
        root: args.root,
        resolved: args.resolved,
      },
    },
    `Path '${args.relPath}' resolves outside adapter root '${args.root}'`,
  );
  return new AdapterError(
    {
      kind: args.writeOp ? 'fs_write_failed' : 'fs_read_failed',
      engineId: ADAPTER_ENGINE_ID,
      correlationId: ADAPTER_CORRELATION_ID,
      cause: traversalCause,
    },
    `Path traversal rejected: '${args.relPath}'`,
  );
}

async function guardRealpath(args: {
  rootRealpath: Promise<string>;
  abs: string;
  relPath: string;
  writeOp: boolean;
}): Promise<void> {
  const [rootReal, real] = await Promise.all([
    args.rootRealpath,
    fsPromises.realpath(args.abs),
  ]);
  if (!isInsideRoot(rootReal, real)) {
    throw pathTraversalAdapterError({
      relPath: args.relPath,
      root: rootReal,
      resolved: real,
      writeOp: args.writeOp,
    });
  }
}

async function resolveExistingAndGuard(
  root: string,
  rootRealpath: Promise<string>,
  relPath: string,
  writeOp: boolean,
): Promise<string> {
  const abs = resolveAndGuard(root, relPath, writeOp);
  await guardRealpath({ rootRealpath, abs, relPath, writeOp });
  return abs;
}

async function resolveWritableAndGuard(
  root: string,
  rootRealpath: Promise<string>,
  relPath: string,
): Promise<string> {
  const abs = resolveAndGuard(root, relPath, true);
  let cursor = abs;
  while (true) {
    try {
      await guardRealpath({
        rootRealpath,
        abs: cursor,
        relPath,
        writeOp: true,
      });
      return abs;
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const next = dirname(cursor);
      if (next === cursor) throw err;
      cursor = next;
    }
  }
}

export interface NodeFsAdapterOptions {
  /** The trusted root directory. All paths are relative to this. */
  root: string;
}

/**
 * Create a production filesystem adapter backed by node:fs/promises.
 *
 * @param opts.root - Root directory; normalized to an absolute path at construction.
 */
export function createNodeFsAdapter({ root }: NodeFsAdapterOptions): HoplonFsAdapter {
  // Normalize root at construction time (H9)
  const normalizedRoot = pathResolve(root);
  const rootRealpath = fsPromises.realpath(normalizedRoot).catch(() => normalizedRoot);

  return {
    async read(path: string): Promise<Uint8Array> {
      try {
        const abs = await resolveExistingAndGuard(normalizedRoot, rootRealpath, path, false);
        const buf = await fsPromises.readFile(abs);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          {
            kind: 'fs_read_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to read '${path}'`,
        );
      }
    },

    async write(path: string, content: Uint8Array): Promise<void> {
      try {
        const abs = await resolveWritableAndGuard(normalizedRoot, rootRealpath, path);
        // Ensure parent directories exist
        await fsPromises.mkdir(dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          {
            kind: 'fs_write_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to write '${path}'`,
        );
      }
    },

    async list(path: string): Promise<string[]> {
      try {
        const abs = await resolveExistingAndGuard(normalizedRoot, rootRealpath, path, false);
        const entries = await fsPromises.readdir(abs);
        return entries.slice().sort();
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          {
            kind: 'fs_read_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to list '${path}'`,
        );
      }
    },

    async stat(path: string): Promise<{ exists: boolean; isFile: boolean; size: number }> {
      let abs: string;
      try {
        abs = await resolveExistingAndGuard(normalizedRoot, rootRealpath, path, false);
        const s = await fsPromises.stat(abs);
        return { exists: true, isFile: s.isFile(), size: s.size };
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { exists: false, isFile: false, size: 0 };
        }
        throw new AdapterError(
          {
            kind: 'fs_read_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to stat '${path}'`,
        );
      }
    },

    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      try {
        const abs = await resolveWritableAndGuard(normalizedRoot, rootRealpath, path);
        await fsPromises.mkdir(abs, opts);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          {
            kind: 'fs_write_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to mkdir '${path}'`,
        );
      }
    },

    async remove(path: string): Promise<void> {
      try {
        const abs = await resolveWritableAndGuard(normalizedRoot, rootRealpath, path);
        await fsPromises.rm(abs, { force: true });
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          {
            kind: 'fs_write_failed',
            engineId: ADAPTER_ENGINE_ID,
            correlationId: ADAPTER_CORRELATION_ID,
            cause: err,
          },
          `Failed to remove '${path}'`,
        );
      }
    },
  };
}
