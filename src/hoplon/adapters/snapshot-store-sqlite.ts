import { randomUUID } from 'node:crypto';
import type { SnapshotStore } from './snapshotStore.js';
import { SqliteSnapshotStore } from './snapshotStore/sqlitePolicyAudit.js';
import { openSqliteSnapshotDatabase } from './snapshotStore/sqliteSchema.js';

export async function createSqliteSnapshotStore(opts: { dbPath: string }): Promise<SnapshotStore> {
  const db = await openSqliteSnapshotDatabase(opts.dbPath);
  return new SqliteSnapshotStore(db, opts.dbPath);
}

export async function createIsolatedTestStore(): Promise<SnapshotStore> {
  const db = await openSqliteSnapshotDatabase(null);
  const tag = `hoplon_test_${randomUUID()}`;
  void tag;
  return new SqliteSnapshotStore(db, null);
}
