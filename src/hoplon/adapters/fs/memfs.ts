/**
 * adapters/fs/memfs.ts — In-memory filesystem adapter for tests.
 *
 * Implements HoplonFsAdapter using memfs (a pure-JS in-memory filesystem).
 * Starts empty. No root concept — all paths are absolute within the memfs volume.
 * Tests control content explicitly via write() before read/list/stat.
 *
 * Used in unit tests and the contract test suite to prove behavioral equivalence
 * with createNodeFsAdapter without disk I/O.
 */

import { Volume, createFsFromVolume } from 'memfs';
import { dirname, resolve as pathResolve, join } from 'node:path';
import type { HoplonFsAdapter } from '../fs.js';
import { AdapterError } from '../../contracts/errors.js';

const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

// Type for the memfs promises API derived from what createFsFromVolume returns.
// memfs exposes the same promise-based API as node:fs/promises.
type MemFsPromises = ReturnType<typeof createFsFromVolume>['promises'];

/** Internal wrapper: call a memfs promise operation and rethrow as AdapterError on failure. */
async function fsOp<T>(
  kind: 'fs_read_failed' | 'fs_write_failed',
  label: string,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw new AdapterError(
      {
        kind,
        engineId: ADAPTER_ENGINE_ID,
        correlationId: ADAPTER_CORRELATION_ID,
        cause: err,
      },
      label,
    );
  }
}

/**
 * Create an in-memory filesystem adapter.
 *
 * State starts empty. Callers write files before reading.
 * All paths are treated as absolute within the memfs volume root '/'.
 */
export function createMemFsAdapter(): HoplonFsAdapter {
  const vol = new Volume();
  const mfs = createFsFromVolume(vol);
  const p: MemFsPromises = mfs.promises;

  /** Resolve a relative path to an absolute memfs path under '/'. */
  function absPath(relPath: string): string {
    return pathResolve(join('/', relPath));
  }

  return {
    async read(path: string): Promise<Uint8Array> {
      const abs = absPath(path);
      const buf = await fsOp('fs_read_failed', `Failed to read '${path}'`, () =>
        p.readFile(abs) as Promise<Buffer>,
      );
      return new Uint8Array((buf as Buffer).buffer, (buf as Buffer).byteOffset, (buf as Buffer).byteLength);
    },

    async write(path: string, content: Uint8Array): Promise<void> {
      const abs = absPath(path);
      await fsOp('fs_write_failed', `Failed to write '${path}'`, async () => {
        await p.mkdir(dirname(abs), { recursive: true });
        await p.writeFile(abs, Buffer.from(content));
      });
    },

    async list(path: string): Promise<string[]> {
      const abs = absPath(path);
      const entries = await fsOp('fs_read_failed', `Failed to list '${path}'`, () =>
        p.readdir(abs) as Promise<string[]>,
      );
      return (entries as string[]).slice().sort();
    },

    async stat(path: string): Promise<{ exists: boolean; isFile: boolean; size: number }> {
      const abs = absPath(path);
      try {
        const s = await p.stat(abs);
        return {
          exists: true,
          isFile: (s as { isFile(): boolean }).isFile(),
          size: (s as { size: number }).size,
        };
      } catch (err) {
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
      const abs = absPath(path);
      await fsOp('fs_write_failed', `Failed to mkdir '${path}'`, () =>
        p.mkdir(abs, opts) as Promise<void>,
      );
    },

    async remove(path: string): Promise<void> {
      const abs = absPath(path);
      await fsOp('fs_write_failed', `Failed to remove '${path}'`, () =>
        p.rm(abs, { force: true }),
      );
    },
  };
}
