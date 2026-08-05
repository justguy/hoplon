import type { TraceStore } from './traceStore.js';
import { SqliteTraceStore } from './traceStore/sqliteStore.js';
import { openSqliteTraceDatabase } from './traceStore/sqliteSupport.js';

export async function createSqliteTraceStore(opts: { dbPath: string }): Promise<TraceStore> {
  const db = await openSqliteTraceDatabase(opts.dbPath);
  return new SqliteTraceStore(db, opts.dbPath);
}

export async function createInMemorySqliteTraceStore(): Promise<TraceStore> {
  const db = await openSqliteTraceDatabase(null);
  return new SqliteTraceStore(db, null);
}
