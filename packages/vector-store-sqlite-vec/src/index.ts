import { NODE_SQLITE_UNAVAILABLE } from './constants.js';
import { createLexicalIndex } from './lexical.js';
import {
  createUnavailableLexicalIndex,
  createUnavailableVectorIndex,
} from './results.js';
import {
  createDescription,
  initializeDatabase,
  loadNodeSqlite,
} from './runtime.js';
import { createVectorIndex } from './vector.js';
import type {
  NodeSqliteVecDescription,
  NodeSqliteVecOptions,
  NodeSqliteVecSemanticIndex,
} from './types.js';

export {
  createNodeSqliteVecHoplonAdapters,
} from './hoplonAdapters.js';
export type {
  HoplonIndexResult,
  HoplonLexicalIndexAdapter,
  HoplonSemanticAdapters,
  HoplonSemanticStorageProfile,
  HoplonSemanticStorageProfileAdapter,
  HoplonVectorIndexAdapter,
} from './hoplonAdapters.js';
export type {
  NativeLexicalIndexAdapter,
  NativeLexicalIndexDocument,
  NativeMetadata,
  NativeSemanticIndexResult,
  NativeSemanticMatch,
  NativeSemanticSqlRuntime,
  NativeSemanticStatus,
  NativeSemanticVectorRuntime,
  NativeVectorIndexAdapter,
  NativeVectorIndexRecord,
  NodeSqliteModule,
  NodeSqliteVecDescription,
  NodeSqliteVecOptions,
  NodeSqliteVecSemanticIndex,
  SqliteVecModule,
} from './types.js';

export async function createNodeSqliteVecSemanticIndex(
  options: NodeSqliteVecOptions,
): Promise<NodeSqliteVecSemanticIndex> {
  let nodeSqlite;
  try {
    nodeSqlite = await loadNodeSqlite(options);
  } catch {
    return createUnavailableSemanticIndex();
  }

  const database = new nodeSqlite.DatabaseSync(options.databasePath, {
    allowExtension: true,
  });
  const description = await initializeDatabase(database, options);

  return {
    lexicalIndex: createLexicalIndex(database),
    vectorIndex: createVectorIndex(database, options.vectorDimension, description),
    async describe(): Promise<NodeSqliteVecDescription> {
      return { ...description, degradationReasons: [...description.degradationReasons] };
    },
    async close(): Promise<void> {
      database.close();
    },
  };
}

function createUnavailableSemanticIndex(): NodeSqliteVecSemanticIndex {
  const description = createDescription({
    status: 'UNAVAILABLE',
    semanticSqlRuntime: 'unavailable',
    reason: NODE_SQLITE_UNAVAILABLE,
  });
  return {
    lexicalIndex: createUnavailableLexicalIndex(NODE_SQLITE_UNAVAILABLE),
    vectorIndex: createUnavailableVectorIndex(NODE_SQLITE_UNAVAILABLE),
    async describe(): Promise<NodeSqliteVecDescription> {
      return { ...description, degradationReasons: [...description.degradationReasons] };
    },
    async close(): Promise<void> {},
  };
}
