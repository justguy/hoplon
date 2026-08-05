import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TraceStore } from '../traceStore.js';
import { PostgresTraceStore } from './postgresStore.js';
import { runPostgresTraceMigrations } from './postgresSupport.js';

export interface PostgresTraceStoreOptions {
  pool: Pool;
}

export async function createPostgresTraceStore(
  opts: PostgresTraceStoreOptions,
): Promise<TraceStore> {
  await runPostgresTraceMigrations(opts.pool);
  return new PostgresTraceStore(opts.pool);
}

export async function createIsolatedPgTestTraceStore(): Promise<TraceStore> {
  const { newDb } = await import('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as Pool;
  const tag = `hoplon_pg_trace_test_${randomUUID()}`;
  void tag;
  return createPostgresTraceStore({ pool });
}
