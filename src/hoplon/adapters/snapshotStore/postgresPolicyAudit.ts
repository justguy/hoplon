import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { verifyAuditLogChain } from '../../contracts/compliance.js';
import type {
  AuditLogIntegrityRequest,
  AuditLogIntegrityResult,
} from '../../contracts/compliance.js';
import type { PolicyAuditQueryRequest } from '../../contracts/policyAuditQuery.js';
import type { SnapshotStore } from '../snapshotStore.js';
import { PostgresSnapshotAudit } from './postgresAudit.js';
import {
  postgresSnapshotErrorMessage,
  throwPostgresSnapshotRead,
} from './postgresErrors.js';
import { PG_AUDIT_LOG_COLUMNS, rowToPostgresAuditLogRecord } from './postgresRows.js';

export class PostgresSnapshotStore extends PostgresSnapshotAudit implements SnapshotStore {
  async findPolicyAuditEntries(request: PolicyAuditQueryRequest): Promise<AuditLogRecord[]> {
    const limit = Math.max(1, Math.min(200, request.limit));
    const conditions = [
      'project_id = $1',
      "operation IN ('POLICY_HANDSHAKE','POLICY_ACCESS_CHECK','POLICY_RENEW','POLICY_REVOKE')",
    ];
    const params: (string | number | null)[] = [request.projectId];
    let index = 2;
    if (request.folder !== undefined) {
      conditions.push(`policy_event ->> 'folder' = $${index++}`);
      params.push(request.folder);
    }
    switch (request.principal.kind) {
      case 'any': break;
      case 'none': conditions.push("policy_event ->> 'principalId' IS NULL"); break;
      case 'exact':
        conditions.push(`policy_event ->> 'principalId' = $${index++}`);
        params.push(request.principal.principalId);
        break;
    }
    if (request.outcome !== undefined) { conditions.push(`result = $${index++}`); params.push(request.outcome); }
    if (request.reasonCode !== undefined) {
      conditions.push(`policy_event ->> 'reasonCode' = $${index++}`);
      params.push(request.reasonCode);
    }
    if (request.since !== undefined) { conditions.push(`created_at >= $${index++}`); params.push(request.since); }
    if (request.until !== undefined) { conditions.push(`created_at <= $${index++}`); params.push(request.until); }
    params.push(limit);
    try {
      const { rows } = await this.query<Record<string, unknown>>(
        `SELECT ${PG_AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
          WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${index}`,
        params,
      );
      return rows.map(rowToPostgresAuditLogRecord);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): findPolicyAuditEntries failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }

  async verifyAuditLogIntegrity(
    request: AuditLogIntegrityRequest,
  ): Promise<AuditLogIntegrityResult> {
    const conditions = ['project_id = $1'];
    const params: (string | number | null)[] = [request.projectId];
    let index = 2;
    if (request.runId !== undefined) { conditions.push(`run_id = $${index++}`); params.push(request.runId); }
    if (request.since !== undefined) { conditions.push(`created_at >= $${index++}`); params.push(request.since); }
    if (request.until !== undefined) { conditions.push(`created_at <= $${index++}`); params.push(request.until); }
    try {
      const { rows } = await this.query<Record<string, unknown>>(
        `SELECT ${PG_AUDIT_LOG_COLUMNS} FROM hoplon_audit_log
          WHERE ${conditions.join(' AND ')}
          ORDER BY run_id ASC, audit_sequence ASC, created_at ASC, id ASC`, params,
      );
      return verifyAuditLogChain(rows.map(rowToPostgresAuditLogRecord), request);
    } catch (cause) {
      throwPostgresSnapshotRead(
        cause, `SnapshotStore(pg): verifyAuditLogIntegrity failed: ${postgresSnapshotErrorMessage(cause)}`,
      );
    }
  }
}
