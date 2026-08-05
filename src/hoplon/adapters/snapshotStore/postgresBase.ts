import type { Pool } from 'pg';
import { AdapterError, ValidationError } from '../../contracts/errors.js';
import { addHashPrefix, stripHashPrefix } from '../../util/hashManifest.js';
import type { SnapshotRecord } from '../snapshotStore.js';
import {
  postgresSnapshotErrorMessage,
  throwPostgresSnapshotRead,
  throwPostgresSnapshotWrite,
} from './postgresErrors.js';
import { rowToPostgresSnapshotRecord } from './postgresRows.js';

export type PostgresSnapshotParam = string | number | boolean | null | undefined;

export class PostgresSnapshotBase {
  constructor(protected readonly pool: Pool) {}

  protected async query<T = unknown>(
    sql: string,
    params: PostgresSnapshotParam[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async put(record: SnapshotRecord): Promise<void> {
    try {
      await this.query(`INSERT INTO hoplon_snapshots (
        id, manifest_schema_version, engine_id, project_id, run_id, correlation_id,
        status, status_reason, git_ref, manifest, created_at, ttl_expires,
        replica_ids, presence_paths
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO NOTHING`, [
        record.id, record.manifestSchemaVersion, record.engineId, record.projectId,
        record.runId, record.correlationId, record.status, record.statusReason ?? null,
        record.gitRef ?? null, record.manifest != null ? JSON.stringify(record.manifest) : null,
        record.createdAt, record.ttlExpires ?? null, JSON.stringify(record.replicaIds),
        record.presencePaths != null ? JSON.stringify(record.presencePaths) : null,
      ]);
    } catch (cause) {
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): put failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async get(id: string): Promise<SnapshotRecord | null> {
    try {
      const row = (await this.query<Record<string, unknown>>(
        'SELECT * FROM hoplon_snapshots WHERE id = $1', [id],
      )).rows[0];
      if (row) return rowToPostgresSnapshotRecord(row);
      let alternateId: string;
      try {
        const bareHex = stripHashPrefix(id);
        alternateId = id === bareHex ? addHashPrefix(id) : bareHex;
      } catch {
        return null;
      }
      const alternate = (await this.query<Record<string, unknown>>(
        'SELECT * FROM hoplon_snapshots WHERE id = $1', [alternateId],
      )).rows[0];
      return alternate ? rowToPostgresSnapshotRecord(alternate) : null;
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): get failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async findByProjectAndRun(projectId: string, runId: string): Promise<SnapshotRecord[]> {
    try {
      const { rows } = await this.query<Record<string, unknown>>(`SELECT * FROM hoplon_snapshots
        WHERE project_id = $1 AND run_id = $2 ORDER BY created_at ASC`, [projectId, runId]);
      return rows.map(rowToPostgresSnapshotRecord);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): findByProjectAndRun failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async updateStatus(
    id: string,
    status: 'committed' | 'failed',
    statusReason?: string,
    gitRef?: string,
  ): Promise<void> {
    try {
      await this.query(`UPDATE hoplon_snapshots
        SET status = $1, status_reason = $2, git_ref = $3 WHERE id = $4`, [
        status, statusReason ?? null, gitRef ?? null, id,
      ]);
    } catch (cause) {
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): updateStatus failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async recordPendingGitRef(id: string, gitRef: string): Promise<void> {
    try {
      await this.query(`UPDATE hoplon_snapshots SET git_ref = $1
        WHERE id = $2 AND status = 'pending'`, [gitRef, id]);
    } catch (cause) {
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): recordPendingGitRef failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async listPending(olderThanMs: number): Promise<SnapshotRecord[]> {
    try {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { rows } = await this.query<Record<string, unknown>>(`SELECT * FROM hoplon_snapshots
        WHERE status = 'pending' AND created_at < $1 ORDER BY created_at ASC`, [cutoff]);
      return rows.map(rowToPostgresSnapshotRecord);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): listPending failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
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
      }, 'SnapshotStore(pg).gc: at least one filter (projectId, olderThan, or expiredBefore) is required');
    }
    try {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];
      if (projectId != null) { params.push(projectId); conditions.push(`project_id = $${params.length}`); }
      if (olderThan != null) { params.push(olderThan); conditions.push(`created_at < $${params.length}`); }
      if (expiredBefore != null) {
        params.push(expiredBefore);
        conditions.push(`(ttl_expires IS NOT NULL AND ttl_expires < $${params.length})`);
      }
      const { rowCount } = await this.query(
        `DELETE FROM hoplon_snapshots WHERE ${conditions.join(' AND ')}`, params,
      );
      return { deletedCount: rowCount };
    } catch (cause) {
      if (cause instanceof AdapterError || cause instanceof ValidationError) throw cause;
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): gc failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async listByReplica(replicaId: string): Promise<SnapshotRecord[]> {
    try {
      const { rows } = await this.query<Record<string, unknown>>(`SELECT * FROM hoplon_snapshots
        WHERE replica_ids @> $1 ORDER BY created_at ASC`, [JSON.stringify([replicaId])]);
      return rows.map(rowToPostgresSnapshotRecord);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): listByReplica failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async setReplicaIds(id: string, replicaIds: string[]): Promise<void> {
    try {
      await this.query('UPDATE hoplon_snapshots SET replica_ids = $1 WHERE id = $2', [
        JSON.stringify(replicaIds), id,
      ]);
    } catch (cause) {
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): setReplicaIds failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }
}
