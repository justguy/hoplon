import type { PoolClient } from 'pg';
import { AuditLogRecordSchema } from '../../contracts/auditLog.js';
import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { finalizeAuditLogChainRecord } from '../../contracts/compliance.js';
import { AdapterError, ValidationError } from '../../contracts/errors.js';
import { PostgresSnapshotBase } from './postgresBase.js';
import {
  postgresSnapshotErrorMessage,
  throwPostgresSnapshotRead,
  throwPostgresSnapshotWrite,
} from './postgresErrors.js';
import { PG_AUDIT_LOG_COLUMNS, rowToPostgresAuditLogRecord } from './postgresRows.js';

export class PostgresSnapshotAudit extends PostgresSnapshotBase {
  async appendAuditLog(record: AuditLogRecord): Promise<void> {
    const validation = AuditLogRecordSchema.safeParse(record);
    if (!validation.success) {
      throw new AdapterError({
        kind: 'snapshot_store_write_failed', engineId: 'adapter',
        correlationId: 'adapter', cause: validation.error,
      }, `SnapshotStore(pg): appendAuditLog: record failed schema validation: ${validation.error.message}`);
    }
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const finalized = await this.finalizeAuditLogRecord(client, validation.data);
        await client.query(`INSERT INTO hoplon_audit_log (
          id, snapshot_id, project_id, run_id, engine_id, correlation_id,
          operation, result, violation_count, violation_kinds, duration_ms, created_at,
          ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
          proof_access_event, audit_sequence, previous_chain_hash, row_hash,
          chain_hash, chain_version, chain_algorithm
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (id) DO NOTHING`, [
          finalized.id, finalized.snapshotId ?? null, finalized.projectId, finalized.runId,
          finalized.engineId, finalized.correlationId, finalized.operation, finalized.result,
          finalized.violationCount, JSON.stringify(finalized.violationKinds),
          finalized.durationMs, finalized.createdAt, finalized.astNodeCount ?? null,
          finalized.fileLineCount ?? null, finalized.manifestScopeRatio ?? null,
          finalized.policyEvent != null ? JSON.stringify(finalized.policyEvent) : null,
          finalized.proofAccessEvent != null ? JSON.stringify(finalized.proofAccessEvent) : null,
          finalized.auditSequence ?? null, finalized.previousChainHash ?? null,
          finalized.rowHash ?? null, finalized.chainHash ?? null,
          finalized.chainVersion ?? null, finalized.chainAlgorithm ?? null,
        ]);
        await client.query('COMMIT');
      } catch (cause) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
        throw cause;
      } finally {
        client.release();
      }
    } catch (cause) {
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): appendAuditLog failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async findAuditLogByProjectAndRun(projectId: string, runId: string): Promise<AuditLogRecord[]> {
    try {
      const { rows } = await this.query<Record<string, unknown>>(
        `SELECT ${PG_AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
          WHERE project_id = $1 AND run_id = $2 ORDER BY created_at ASC`, [projectId, runId],
      );
      return rows.map(rowToPostgresAuditLogRecord);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): findAuditLogByProjectAndRun failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async gcAuditLog(opts: {
    projectId?: string;
    olderThan?: string;
  }): Promise<{ deletedCount: number }> {
    const { projectId, olderThan } = opts;
    if (projectId == null && olderThan == null) {
      throw new ValidationError({
        kind: 'invalid_scope', engineId: 'adapter', correlationId: 'adapter',
        cause: 'at_least_one_filter_required',
      }, 'SnapshotStore(pg).gcAuditLog: at least one filter (projectId or olderThan) is required');
    }
    try {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];
      if (projectId != null) { params.push(projectId); conditions.push(`project_id = $${params.length}`); }
      if (olderThan != null) { params.push(olderThan); conditions.push(`created_at < $${params.length}`); }
      const { rowCount } = await this.query(
        `DELETE FROM hoplon_audit_log WHERE ${conditions.join(' AND ')}`, params,
      );
      return { deletedCount: rowCount };
    } catch (cause) {
      if (cause instanceof AdapterError || cause instanceof ValidationError) throw cause;
      throwPostgresSnapshotWrite(
        cause, `SnapshotStore(pg): gcAuditLog failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  private async finalizeAuditLogRecord(
    client: PoolClient,
    record: AuditLogRecord,
  ): Promise<AuditLogRecord> {
    const { rows } = await client.query<{
      audit_sequence: number | string | null;
      chain_hash: string | null;
    }>(`SELECT audit_sequence, chain_hash FROM hoplon_audit_log
      WHERE project_id = $1 AND run_id = $2 AND audit_sequence IS NOT NULL
      ORDER BY audit_sequence DESC LIMIT 1 FOR UPDATE`, [record.projectId, record.runId]);
    const previous = rows[0];
    return finalizeAuditLogChainRecord(record, {
      auditSequence: (previous?.audit_sequence != null ? Number(previous.audit_sequence) : 0) + 1,
      previousChainHash: previous?.chain_hash ?? null,
    });
  }
}
