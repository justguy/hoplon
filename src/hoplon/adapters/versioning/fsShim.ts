/**
 * adapters/versioning/fsShim.ts — node:fs-shaped shim over HoplonFsAdapter.
 *
 * isomorphic-git expects a flat object with promise-returning methods shaped
 * like node:fs (readFile, writeFile, readdir, mkdir, rmdir, unlink, stat,
 * lstat, readlink, symlink). Our HoplonFsAdapter has different method names
 * and a different stat return shape.
 *
 * This shim bridges the two interfaces. It is the ONLY place allowed to
 * call HoplonFsAdapter methods from within the versioning adapter.
 *
 * ## stat shape gotcha
 *
 * isomorphic-git's internal FileSystem wrapper calls stat/lstat and expects
 * the result to have:
 *   - isFile()        → method (function), not a boolean property
 *   - isDirectory()   → method (function), not a boolean property
 *   - isSymbolicLink() → method (function), returning false (no symlinks at
 *                        our adapter layer)
 *   - mode            → number (0o100644 for regular file, 0o40000 for dir)
 *   - size            → number (bytes for files; 0 for dirs is acceptable)
 *   - mtimeMs         → number (epoch milliseconds). HoplonFsAdapter.stat
 *                        does not expose timestamps, so we fabricate this with
 *                        Date.now() at the call site. This is safe because
 *                        isomorphic-git uses mtimeMs only for change-detection
 *                        in the index cache (compareStats). Since we don't
 *                        reuse an index across calls the fabricated timestamp
 *                        never produces a false-negative "unchanged" verdict.
 *   - ctimeMs         → same rationale as mtimeMs
 *
 * A bug in this shape causes silent git index corruption (wrong file modes,
 * wrong tree OIDs). The stat shape is explicitly tested in versioning.test.ts
 * test 11.
 *
 * ## readFile encoding
 *
 * When called with { encoding: 'utf8' } (or just 'utf8' as second arg),
 * isomorphic-git expects a string back. Otherwise it expects a Buffer or
 * Uint8Array. We return a Buffer (Uint8Array subclass) for binary reads.
 *
 * ## Errors
 *
 * AdapterErrors from the underlying HoplonFsAdapter propagate unchanged.
 * The ENOENT pattern is critical: when isomorphic-git checks file existence
 * via stat/lstat it expects an ENOENT-shaped error (with .code === 'ENOENT')
 * to signal absence, not a silent null return. We convert stat's "not found"
 * shape into an ENOENT Error at the shim boundary.
 *
 * ## Symlinks
 *
 * Phase 1: symlinks are not supported. readlink and symlink throw
 * AdapterError({ kind: 'fs_read_failed' / 'fs_write_failed' }).
 */

import type { HoplonFsAdapter } from '../fs.js';
import { AdapterError } from '../../contracts/errors.js';

const ADAPTER_ENGINE_ID = 'adapter';
const ADAPTER_CORRELATION_ID = 'adapter';

/** The stat result shape that isomorphic-git requires. */
export interface IsomorphicGitStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
}

/**
 * Monotonically increasing inode counter.
 *
 * isomorphic-git's compareStats() checks inode numbers (when trustino=true,
 * which is the case on non-Windows platforms) as one of its staleness signals.
 * By returning a unique ino on every stat() call we ensure compareStats()
 * always reports "potentially stale", so isomorphic-git always re-reads the
 * actual file content to compute the true OID rather than using a cached OID.
 *
 * This is intentionally conservative: it forces content re-reads on every
 * stat call, which is correct for our in-memory use case where we have no
 * real inode or mtime tracking. Without this, fabricated timestamps that
 * happen to match the index's cached timestamps (both from Date.now() within
 * the same second) cause isomorphic-git to silently skip content comparison.
 */
let _inodeCounter = 1;
function nextIno(): number {
  return _inodeCounter++;
}

/** Fabricate an isomorphic-git-compatible stat object from our adapter's flat result. */
function makeStatObject(
  isFile: boolean,
  size: number,
): IsomorphicGitStat {
  const now = Date.now();
  const mode = isFile ? 0o100644 : 0o40000;
  return {
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    mode,
    size,
    mtimeMs: now,
    ctimeMs: now,
    dev: 1,
    ino: nextIno(),
    uid: 0,
    gid: 0,
  };
}

/** Create an ENOENT-shaped Error for a missing path (isomorphic-git depends on .code). */
function enoent(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, stat '${path}'`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  return err;
}

/**
 * The flat fs interface that isomorphic-git consumes via its PromiseFsClient path.
 * isomorphic-git's isPromiseFs() probe calls readFile() — it must return a Promise.
 */
export interface IsomorphicGitFsShim {
  readFile(path: string, opts?: string | { encoding?: string }): Promise<Buffer | string>;
  writeFile(path: string, data: Buffer | Uint8Array | string, opts?: unknown): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean } | number): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<IsomorphicGitStat>;
  lstat(path: string): Promise<IsomorphicGitStat>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

/**
 * Build a shim over the given HoplonFsAdapter that satisfies the flat
 * promise-based fs interface isomorphic-git requires.
 */
export function createFsShim(adapter: HoplonFsAdapter): IsomorphicGitFsShim {
  return {
    // ------------------------------------------------------------------
    // readFile
    // ------------------------------------------------------------------
    async readFile(
      path: string,
      opts?: string | { encoding?: string },
    ): Promise<Buffer | string> {
      const bytes = await adapter.read(path);
      const buf = Buffer.from(bytes);
      const encoding =
        typeof opts === 'string' ? opts : opts?.encoding;
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return buf.toString('utf8');
      }
      return buf;
    },

    // ------------------------------------------------------------------
    // writeFile
    // ------------------------------------------------------------------
    async writeFile(
      path: string,
      data: Buffer | Uint8Array | string,
    ): Promise<void> {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else {
        bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      }
      await adapter.write(path, bytes);
    },

    // ------------------------------------------------------------------
    // readdir
    // ------------------------------------------------------------------
    async readdir(path: string): Promise<string[]> {
      return adapter.list(path);
    },

    // ------------------------------------------------------------------
    // mkdir
    // ------------------------------------------------------------------
    async mkdir(
      path: string,
      opts?: { recursive?: boolean } | number,
    ): Promise<void> {
      // opts may be a mode number (when called from isomorphic-git git.init)
      // or an options object. We only honor { recursive }.
      const recursive =
        typeof opts === 'object' && opts !== null
          ? (opts as { recursive?: boolean }).recursive
          : undefined;
      if (recursive === true) {
        await adapter.mkdir(path, { recursive: true });
      } else {
        await adapter.mkdir(path);
      }
    },

    // ------------------------------------------------------------------
    // rmdir — map to adapter.remove; force:true suppresses ENOENT
    // ------------------------------------------------------------------
    async rmdir(path: string): Promise<void> {
      await adapter.remove(path);
    },

    // ------------------------------------------------------------------
    // unlink — map to adapter.remove
    // ------------------------------------------------------------------
    async unlink(path: string): Promise<void> {
      await adapter.remove(path);
    },

    // ------------------------------------------------------------------
    // stat — build the isomorphic-git-compatible stat shape
    // ------------------------------------------------------------------
    async stat(path: string): Promise<IsomorphicGitStat> {
      const s = await adapter.stat(path);
      if (!s.exists) {
        throw enoent(path);
      }
      return makeStatObject(s.isFile, s.size);
    },

    // ------------------------------------------------------------------
    // lstat — identical to stat (no symlinks at our layer)
    // ------------------------------------------------------------------
    async lstat(path: string): Promise<IsomorphicGitStat> {
      const s = await adapter.stat(path);
      if (!s.exists) {
        throw enoent(path);
      }
      return makeStatObject(s.isFile, s.size);
    },

    // ------------------------------------------------------------------
    // readlink — Phase 1: not supported
    // ------------------------------------------------------------------
    async readlink(path: string): Promise<string> {
      throw new AdapterError(
        {
          kind: 'fs_read_failed',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: 'symlinks_not_supported_in_phase_1',
        },
        `readlink not supported: '${path}'`,
      );
    },

    // ------------------------------------------------------------------
    // symlink — Phase 1: not supported
    // ------------------------------------------------------------------
    async symlink(target: string, path: string): Promise<void> {
      throw new AdapterError(
        {
          kind: 'fs_write_failed',
          engineId: ADAPTER_ENGINE_ID,
          correlationId: ADAPTER_CORRELATION_ID,
          cause: 'symlinks_not_supported_in_phase_1',
        },
        `symlink not supported: '${target}' → '${path}'`,
      );
    },
  };
}
