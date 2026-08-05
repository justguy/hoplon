import { writeFileSync } from 'node:fs';
import type { Database } from 'sql.js';
import { AdapterError, ValidationError } from '../../contracts/errors.js';
import { addHashPrefix, stripHashPrefix } from '../../util/hashManifest.js';
import type { SnapshotRecord } from '../snapshotStore.js';
import { throwSqliteSnapshotRead, throwSqliteSnapshotWrite } from './sqliteErrors.js';
import { execSqliteSnapshotSelect, sqliteSnapshotParams } from './sqliteRows.js';

export class SqliteSnapshotBase {
  constructor(
    protected readonly db: Database,
    protected readonly dbPath: string | null,
  ) {}

  protected flush(): void {
    if (this.dbPath === null) return;
    try {
      writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (cause) {
      throwSqliteSnapshotWrite(cause, 'SnapshotStore: failed to flush database to disk');
    }
  }

  async put(record: SnapshotRecord): Promise<void> {
    try {
      this.db.run(`INSERT OR IGNORE INTO hoplon_snapshots (
        id, manifest_schema_version, engine_id, project_id, run_id, correlation_id,
        status, status_reason, git_ref, manifest, created_at, ttl_expires,
        replica_ids, presence_paths
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sqliteSnapshotParams(record));
      this.flush();
    } catch (cause) { throwSqliteSnapshotWrite(cause, 'SnapshotStore: put failed'); }
  }

  async get(id: string): Promise<SnapshotRecord | null> {
    try {
      const row = execSqliteSnapshotSelect(
        this.db, 'SELECT * FROM hoplon_snapshots WHERE id = ?', [id],
      )[0];
      if (row) return row;
      let alternateId: string;
      try {
        const bareHex = stripHashPrefix(id);
        alternateId = id === bareHex ? addHashPrefix(id) : bareHex;
      } catch {
        return null;
      }
      return execSqliteSnapshotSelect(
        this.db, 'SELECT * FROM hoplon_snapshots WHERE id = ?', [alternateId],
      )[0] ?? null;
    } catch (cause) { throwSqliteSnapshotRead(cause, 'SnapshotStore: get failed'); }
  }

  async findByProjectAndRun(projectId: string, runId: string): Promise<SnapshotRecord[]> {
    try {
      return execSqliteSnapshotSelect(this.db, `SELECT * FROM hoplon_snapshots
        WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC`, [projectId, runId]);
    } catch (cause) {
      throwSqliteSnapshotRead(cause, 'SnapshotStore: findByProjectAndRun failed');
    }
  }

  async updateStatus(
    id: string,
    status: 'committed' | 'failed',
    statusReason?: string,
    gitRef?: string,
  ): Promise<void> {
    try {
      this.db.run(`UPDATE hoplon_snapshots SET status = ?, status_reason = ?, git_ref = ?
        WHERE id = ?`, [status, statusReason ?? null, gitRef ?? null, id]);
      this.flush();
    } catch (cause) { throwSqliteSnapshotWrite(cause, 'SnapshotStore: updateStatus failed'); }
  }

  async recordPendingGitRef(id: string, gitRef: string): Promise<void> {
    try {
      this.db.run(`UPDATE hoplon_snapshots SET git_ref = ?
        WHERE id = ? AND status = 'pending'`, [gitRef, id]);
      this.flush();
    } catch (cause) {
      throwSqliteSnapshotWrite(cause, 'SnapshotStore: recordPendingGitRef failed');
    }
  }

  async listPending(olderThanMs: number): Promise<SnapshotRecord[]> {
    try {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      return execSqliteSnapshotSelect(this.db, `SELECT * FROM hoplon_snapshots
        WHERE status = 'pending' AND created_at < ? ORDER BY created_at ASC`, [cutoff]);
    } catch (cause) { throwSqliteSnapshotRead(cause, 'SnapshotStore: listPending failed'); }
  }

  async listByReplica(replicaId: string): Promise<SnapshotRecord[]> {
    try {
      return execSqliteSnapshotSelect(this.db, `SELECT s.* FROM hoplon_snapshots s,
        json_each(s.replica_ids) j WHERE j.value = ? ORDER BY s.created_at ASC`, [replicaId]);
    } catch (cause) { throwSqliteSnapshotRead(cause, 'SnapshotStore: listByReplica failed'); }
  }

  async setReplicaIds(id: string, replicaIds: string[]): Promise<void> {
    try {
      this.db.run('UPDATE hoplon_snapshots SET replica_ids = ? WHERE id = ?', [
        JSON.stringify(replicaIds), id,
      ]);
      this.flush();
    } catch (cause) { throwSqliteSnapshotWrite(cause, 'SnapshotStore: setReplicaIds failed'); }
  }

  async gc(opts: {
    projectId?: string;
    olderThan?: string;
    expiredBefore?: string;
  }): Promise<{ deletedCount: number }> {
    const { projectId, olderThan, expiredBefore } = opts;
    if (projectId == null && olderThan == null && expiredBefore == null) {
      throw new ValidationError({
        kind: 'invalid_scope', engineId: 'adapter', correlationId: 'adapter',
      }, 'SnapshotStore.gc: at least one filter (projectId, olderThan, or expiredBefore) is required to prevent accidental full-table deletion');
    }
    try {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];
      if (projectId != null) { conditions.push('project_id = ?'); params.push(projectId); }
      if (olderThan != null) { conditions.push('created_at < ?'); params.push(olderThan); }
      if (expiredBefore != null) {
        conditions.push('(ttl_expires IS NOT NULL AND ttl_expires < ?)');
        params.push(expiredBefore);
      }
      this.db.run(`DELETE FROM hoplon_snapshots WHERE ${conditions.join(' AND ')}`, params);
      const deletedCount = this.db.getRowsModified();
      this.flush();
      return { deletedCount };
    } catch (cause) {
      if (cause instanceof AdapterError || cause instanceof ValidationError) throw cause;
      throwSqliteSnapshotWrite(cause, 'SnapshotStore: gc failed');
    }
  }
}
