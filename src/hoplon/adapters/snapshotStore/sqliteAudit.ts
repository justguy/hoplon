import { AuditLogRecordSchema } from '../../contracts/auditLog.js';
import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { finalizeAuditLogChainRecord } from '../../contracts/compliance.js';
import { AdapterError, ValidationError } from '../../contracts/errors.js';
import { SqliteSnapshotBase } from './sqliteBase.js';
import { throwSqliteSnapshotRead, throwSqliteSnapshotWrite } from './sqliteErrors.js';
import { AUDIT_LOG_COLUMNS, rowToSqliteAuditLogRecord } from './sqliteRows.js';

export class SqliteSnapshotAudit extends SqliteSnapshotBase {
  async appendAuditLog(record: AuditLogRecord): Promise<void> {
    const validation = AuditLogRecordSchema.safeParse(record);
    if (!validation.success) {
      throw new AdapterError({
        kind: 'snapshot_store_write_failed', engineId: 'adapter',
        correlationId: 'adapter', cause: validation.error,
      }, `SnapshotStore: appendAuditLog: record failed schema validation: ${validation.error.message}`);
    }
    try {
      const finalized = this.finalizeAuditLogRecord(validation.data);
      this.db.run(`INSERT OR IGNORE INTO hoplon_audit_log (
        id, snapshot_id, project_id, run_id, engine_id, correlation_id,
        operation, result, violation_count, violation_kinds, duration_ms, created_at,
        ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
        proof_access_event, audit_sequence, previous_chain_hash, row_hash,
        chain_hash, chain_version, chain_algorithm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
      this.flush();
    } catch (cause) {
      throwSqliteSnapshotWrite(cause, `SnapshotStore: appendAuditLog failed: ${errorMessage(cause)}`);
    }
  }

  async findAuditLogByProjectAndRun(projectId: string, runId: string): Promise<AuditLogRecord[]> {
    try {
      const result = this.db.exec(`SELECT ${AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
        WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC`, [projectId, runId])[0];
      if (!result) return [];
      return result.values.map((row) => rowToSqliteAuditLogRecord(result.columns, row));
    } catch (cause) {
      throwSqliteSnapshotRead(
        cause, `SnapshotStore: findAuditLogByProjectAndRun failed: ${errorMessage(cause)}`,
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
      }, 'SnapshotStore.gcAuditLog: at least one filter (projectId or olderThan) is required to prevent accidental full-table deletion');
    }
    try {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];
      if (projectId != null) { conditions.push('project_id = ?'); params.push(projectId); }
      if (olderThan != null) { conditions.push('created_at < ?'); params.push(olderThan); }
      this.db.run(`DELETE FROM hoplon_audit_log WHERE ${conditions.join(' AND ')}`, params);
      const deletedCount = this.db.getRowsModified();
      this.flush();
      return { deletedCount };
    } catch (cause) {
      if (cause instanceof AdapterError || cause instanceof ValidationError) throw cause;
      throwSqliteSnapshotWrite(cause, `SnapshotStore: gcAuditLog failed: ${errorMessage(cause)}`);
    }
  }

  private finalizeAuditLogRecord(record: AuditLogRecord): AuditLogRecord {
    const row = this.db.exec(`SELECT audit_sequence, chain_hash FROM hoplon_audit_log
      WHERE project_id = ? AND run_id = ? AND audit_sequence IS NOT NULL
      ORDER BY audit_sequence DESC LIMIT 1`, [record.projectId, record.runId])[0]?.values[0];
    return finalizeAuditLogChainRecord(record, {
      auditSequence: (row?.[0] != null ? Number(row[0]) : 0) + 1,
      previousChainHash: row?.[1] != null ? String(row[1]) : null,
    });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
