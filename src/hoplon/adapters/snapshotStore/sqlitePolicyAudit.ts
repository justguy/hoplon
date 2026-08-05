import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { verifyAuditLogChain } from '../../contracts/compliance.js';
import type {
  AuditLogIntegrityRequest,
  AuditLogIntegrityResult,
} from '../../contracts/compliance.js';
import type { PolicyAuditQueryRequest } from '../../contracts/policyAuditQuery.js';
import type { SnapshotStore } from '../snapshotStore.js';
import { SqliteSnapshotAudit } from './sqliteAudit.js';
import { throwSqliteSnapshotRead } from './sqliteErrors.js';
import { AUDIT_LOG_COLUMNS, rowToSqliteAuditLogRecord } from './sqliteRows.js';

export class SqliteSnapshotStore extends SqliteSnapshotAudit implements SnapshotStore {
  async findPolicyAuditEntries(request: PolicyAuditQueryRequest): Promise<AuditLogRecord[]> {
    const limit = Math.max(1, Math.min(200, request.limit));
    const conditions = [
      'project_id = ?',
      "operation IN ('POLICY_HANDSHAKE','POLICY_ACCESS_CHECK','POLICY_RENEW','POLICY_REVOKE')",
    ];
    const params: (string | number | null)[] = [request.projectId];
    if (request.folder !== undefined) {
      conditions.push("json_extract(policy_event, '$.folder') = ?");
      params.push(request.folder);
    }
    switch (request.principal.kind) {
      case 'any': break;
      case 'none':
        conditions.push("json_extract(policy_event, '$.principalId') IS NULL");
        break;
      case 'exact':
        conditions.push("json_extract(policy_event, '$.principalId') = ?");
        params.push(request.principal.principalId);
        break;
    }
    if (request.outcome !== undefined) { conditions.push('result = ?'); params.push(request.outcome); }
    if (request.reasonCode !== undefined) {
      conditions.push("json_extract(policy_event, '$.reasonCode') = ?");
      params.push(request.reasonCode);
    }
    if (request.since !== undefined) { conditions.push('created_at >= ?'); params.push(request.since); }
    if (request.until !== undefined) { conditions.push('created_at <= ?'); params.push(request.until); }
    params.push(limit);
    try {
      const result = this.db.exec(`SELECT ${AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
        WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, params)[0];
      if (!result) return [];
      return result.values.map((row) => rowToSqliteAuditLogRecord(result.columns, row));
    } catch (cause) {
      throwSqliteSnapshotRead(
        cause, `SnapshotStore: findPolicyAuditEntries failed: ${errorMessage(cause)}`,
      );
    }
  }

  async verifyAuditLogIntegrity(
    request: AuditLogIntegrityRequest,
  ): Promise<AuditLogIntegrityResult> {
    try {
      const conditions = ['project_id = ?'];
      const params: (string | number | null)[] = [request.projectId];
      if (request.runId !== undefined) { conditions.push('run_id = ?'); params.push(request.runId); }
      if (request.since !== undefined) { conditions.push('created_at >= ?'); params.push(request.since); }
      if (request.until !== undefined) { conditions.push('created_at <= ?'); params.push(request.until); }
      const result = this.db.exec(`SELECT ${AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
        WHERE ${conditions.join(' AND ')}
        ORDER BY run_id ASC, audit_sequence ASC, created_at ASC, id ASC`, params)[0];
      const records = result
        ? result.values.map((row) => rowToSqliteAuditLogRecord(result.columns, row))
        : [];
      return verifyAuditLogChain(records, request);
    } catch (cause) {
      throwSqliteSnapshotRead(
        cause, `SnapshotStore: verifyAuditLogIntegrity failed: ${errorMessage(cause)}`,
      );
    }
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
