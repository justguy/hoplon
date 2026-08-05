/**
 * adapters/fs.ts — HoplonFsAdapter interface.
 *
 * All paths are relative to the adapter's root.
 * Path traversal (../, absolute paths) must throw BoundaryError({ kind: 'path_traversal' }).
 * No streams in Phase 1 — Promise-returning only.
 */

export interface HoplonFsAdapter {
  /** Read file contents as raw bytes. */
  read(path: string): Promise<Uint8Array>;
  /** Write raw bytes to a file, creating it if absent. */
  write(path: string, content: Uint8Array): Promise<void>;
  /** List names (not paths) of entries in a directory. */
  list(path: string): Promise<string[]>;
  /** Stat a path. Returns { exists: false } for missing paths without throwing. */
  stat(path: string): Promise<{ exists: boolean; isFile: boolean; size: number }>;
  /** Create a directory. */
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Remove a file or directory. */
  remove(path: string): Promise<void>;
}
