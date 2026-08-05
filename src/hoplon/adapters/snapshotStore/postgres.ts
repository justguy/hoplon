import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SnapshotStore } from '../snapshotStore.js';
import { PostgresSnapshotStore } from './postgresPolicyAudit.js';
import { runPostgresSnapshotMigrations } from './postgresSchema.js';

export interface PostgresSnapshotStoreOptions {
  /** Caller-owned pool; this adapter never calls pool.end(). */
  pool: Pool;
}

export async function createPostgresSnapshotStore(
  opts: PostgresSnapshotStoreOptions,
): Promise<SnapshotStore> {
  await runPostgresSnapshotMigrations(opts.pool);
  return new PostgresSnapshotStore(opts.pool);
}

export async function createIsolatedPgTestStore(): Promise<SnapshotStore> {
  const { newDb } = await import('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as Pool;
  const tag = `hoplon_pg_test_${randomUUID()}`;
  void tag;
  return createPostgresSnapshotStore({ pool });
}
