import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import {
  EXTENSION_UNAVAILABLE,
  HASH_MISMATCH,
} from './constants.js';
import {
  readNumber,
  readString,
  readVersion,
} from './sql.js';
import type {
  NodeSqliteDatabase,
  NodeSqliteModule,
  NodeSqliteVecDescription,
  NodeSqliteVecOptions,
  SqliteVecModule,
} from './types.js';

const require = createRequire(import.meta.url);

export async function initializeDatabase(
  database: NodeSqliteDatabase,
  options: NodeSqliteVecOptions,
): Promise<NodeSqliteVecDescription> {
  const walMode =
    readString(database.prepare('PRAGMA journal_mode = WAL').get()) ?? 'unknown';
  database.exec('PRAGMA busy_timeout = 5000');
  const busyTimeoutMs =
    readNumber(database.prepare('PRAGMA busy_timeout').get()) ?? 0;
  database.exec('CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(project_id UNINDEXED, document_id UNINDEXED, text)');
  database.exec('CREATE TABLE IF NOT EXISTS semantic_documents (project_id TEXT NOT NULL, document_id TEXT NOT NULL, text TEXT NOT NULL, metadata_json TEXT NOT NULL, updated_at_iso TEXT NOT NULL, PRIMARY KEY(project_id, document_id))');

  const baseDescription = { walMode, busyTimeoutMs, fts5Available: true };
  const extension = await resolveExtension(options);
  if (extension.status === 'unavailable') {
    database.enableLoadExtension(false);
    return createDescription({
      status: 'DEGRADED',
      semanticSqlRuntime: 'node:sqlite',
      reason: extension.reason,
      ...baseDescription,
    });
  }

  if (
    options.expectedExtensionSha256 !== undefined &&
    extension.sha256 !== options.expectedExtensionSha256
  ) {
    database.enableLoadExtension(false);
    return createDescription({
      status: 'DEGRADED',
      semanticSqlRuntime: 'node:sqlite',
      nativeExtensionBinaryHash: extension.sha256,
      nativeExtensionPath: extension.path,
      reason: HASH_MISMATCH,
      ...baseDescription,
    });
  }

  try {
    database.loadExtension(extension.path);
    database.enableLoadExtension(false);
    const sqlLevelExtensionLoadBlocked = proveSqlLoadBlocked(database, extension.path);
    const sqliteVecVersion =
      readVersion(database.prepare('SELECT vec_version() AS value').get()) ??
      'unknown';
    database.exec('CREATE TABLE IF NOT EXISTS semantic_vector_rows (project_id TEXT NOT NULL, document_id TEXT NOT NULL, rowid INTEGER PRIMARY KEY AUTOINCREMENT, metadata_json TEXT NOT NULL, updated_at_iso TEXT NOT NULL, UNIQUE(project_id, document_id))');
    database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vectors USING vec0(project_id TEXT partition key, embedding float[${options.vectorDimension}])`);
    return createDescription({
      status: 'AVAILABLE',
      semanticSqlRuntime: 'node:sqlite',
      nativeExtensionBinaryHash: extension.sha256,
      nativeExtensionPath: extension.path,
      nativeExtensionLoaded: true,
      semanticVectorRuntime: 'sqlite-vec-native',
      vectorAvailable: true,
      vectorSchemaAvailable: true,
      sqlLevelExtensionLoadBlocked,
      sqliteVecVersion,
      ...baseDescription,
    });
  } catch {
    database.enableLoadExtension(false);
    return createDescription({
      status: 'DEGRADED',
      semanticSqlRuntime: 'node:sqlite',
      nativeExtensionBinaryHash: extension.sha256,
      nativeExtensionPath: extension.path,
      reason: EXTENSION_UNAVAILABLE,
      ...baseDescription,
    });
  }
}

export async function loadNodeSqlite(
  options: NodeSqliteVecOptions,
): Promise<NodeSqliteModule> {
  if (options.loadNodeSqlite !== undefined) return options.loadNodeSqlite();
  const module: unknown = require('node:sqlite');
  return module as NodeSqliteModule;
}

export function createDescription(
  fields: Partial<NodeSqliteVecDescription> & {
    readonly status: NodeSqliteVecDescription['status'];
    readonly semanticSqlRuntime: NodeSqliteVecDescription['semanticSqlRuntime'];
    readonly reason?: string;
  },
): NodeSqliteVecDescription {
  return {
    runtimeProfile: 'native_performance',
    status: fields.status,
    snapshotSqlRuntime: 'not_owned_by_plugin',
    semanticSqlRuntime: fields.semanticSqlRuntime,
    semanticVectorRuntime: fields.semanticVectorRuntime ?? 'lexical-only',
    lexicalAvailable: fields.fts5Available ?? false,
    vectorAvailable: fields.vectorAvailable ?? false,
    nativeRuntime: fields.semanticSqlRuntime === 'node:sqlite',
    nativeExtensionLoaded: fields.nativeExtensionLoaded ?? false,
    ...(fields.nativeExtensionBinaryHash === undefined
      ? {}
      : { nativeExtensionBinaryHash: fields.nativeExtensionBinaryHash }),
    ...(fields.nativeExtensionPath === undefined
      ? {}
      : { nativeExtensionPath: fields.nativeExtensionPath }),
    ...(fields.sqliteVecVersion === undefined
      ? {}
      : { sqliteVecVersion: fields.sqliteVecVersion }),
    fts5Available: fields.fts5Available ?? false,
    ...(fields.walMode === undefined ? {} : { walMode: fields.walMode }),
    ...(fields.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: fields.busyTimeoutMs }),
    vectorSchemaAvailable: fields.vectorSchemaAvailable ?? false,
    sqlLevelExtensionLoadBlocked: fields.sqlLevelExtensionLoadBlocked ?? false,
    degradationReasons: fields.reason === undefined ? [] : [fields.reason],
  };
}

async function resolveExtension(options: NodeSqliteVecOptions): Promise<
  | { readonly status: 'available'; readonly path: string; readonly sha256: string }
  | { readonly status: 'unavailable'; readonly reason: string }
> {
  try {
    const path = options.extensionPath ?? (await loadSqliteVec(options)).getLoadablePath();
    const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
    return { status: 'available', path, sha256 };
  } catch {
    return { status: 'unavailable', reason: EXTENSION_UNAVAILABLE };
  }
}

async function loadSqliteVec(options: NodeSqliteVecOptions): Promise<SqliteVecModule> {
  if (options.sqliteVec !== undefined) return options.sqliteVec;
  const module: unknown = require('sqlite-vec');
  return module as SqliteVecModule;
}

function proveSqlLoadBlocked(database: NodeSqliteDatabase, path: string): boolean {
  try {
    database.prepare('SELECT load_extension(?)').get(path);
    return false;
  } catch {
    return true;
  }
}
