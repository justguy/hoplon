import { AuditLogRecordSchema } from '../../contracts/auditLog.js';
import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { ProofAccessAuditEventSchema } from '../../contracts/complianceAccess.js';
import { WritableManifestSchema } from '../../contracts/manifest.js';
import { PolicyAuditEventSchema } from '../../contracts/policyAudit.js';
import { SnapshotRecordSchema } from '../snapshotStore.js';
import type { SnapshotRecord } from '../snapshotStore.js';
import { throwPostgresSnapshotRead } from './postgresErrors.js';

export const PG_AUDIT_LOG_COLUMNS = `id, snapshot_id, project_id, run_id, engine_id,
  correlation_id, operation, result, violation_count, violation_kinds, duration_ms,
  created_at, ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
  proof_access_event, audit_sequence, previous_chain_hash, row_hash, chain_hash,
  chain_version, chain_algorithm`;

export function rowToPostgresSnapshotRecord(row: Record<string, unknown>): SnapshotRecord {
  let manifest: SnapshotRecord['manifest'] = null;
  if (row['manifest'] != null) {
    const validation = WritableManifestSchema.safeParse(row['manifest']);
    if (!validation.success) {
      throwPostgresSnapshotRead(
        validation.error,
        'SnapshotStore(pg): manifest in database failed WritableManifest schema validation',
      );
    }
    manifest = validation.data;
  }
  let replicaIds: string[] = [];
  if (row['replica_ids'] != null) {
    if (!Array.isArray(row['replica_ids'])) {
      throwPostgresSnapshotRead(
        new TypeError('replica_ids is not an array'),
        'SnapshotStore(pg): replica_ids is not an array',
      );
    }
    replicaIds = row['replica_ids'] as string[];
  }
  let presencePaths: string[] | null = null;
  if (row['presence_paths'] != null) {
    if (!Array.isArray(row['presence_paths'])) {
      throwPostgresSnapshotRead(
        new TypeError('presence_paths is not an array'),
        'SnapshotStore(pg): presence_paths is not an array',
      );
    }
    presencePaths = row['presence_paths'] as string[];
  }
  const record: SnapshotRecord = {
    id: String(row['id'] ?? ''),
    manifestSchemaVersion: Number(row['manifest_schema_version'] ?? 0),
    engineId: String(row['engine_id'] ?? ''),
    projectId: String(row['project_id'] ?? ''),
    runId: String(row['run_id'] ?? ''),
    correlationId: String(row['correlation_id'] ?? ''),
    status: row['status'] as SnapshotRecord['status'],
    statusReason: row['status_reason'] != null ? String(row['status_reason']) : null,
    gitRef: row['git_ref'] != null ? String(row['git_ref']) : null,
    manifest,
    createdAt: String(row['created_at'] ?? ''),
    ttlExpires: row['ttl_expires'] != null ? String(row['ttl_expires']) : null,
    replicaIds,
    presencePaths,
  };
  const validation = SnapshotRecordSchema.safeParse(record);
  if (!validation.success) {
    throwPostgresSnapshotRead(
      validation.error,
      'SnapshotStore(pg): assembled record failed SnapshotRecord schema validation',
    );
  }
  return validation.data;
}

function parseAuditEvent<T>(
  value: unknown,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } },
  column: 'policy_event' | 'proof_access_event',
  schemaName: string,
): T | null {
  if (value == null) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (cause) {
      throwPostgresSnapshotRead(cause, `SnapshotStore(pg): failed to parse ${column} JSON`);
    }
  }
  const validation = schema.safeParse(parsed);
  if (!validation.success) {
    throwPostgresSnapshotRead(
      validation.error,
      `SnapshotStore(pg): ${column} failed ${schemaName} schema validation`,
    );
  }
  return validation.data;
}

export function rowToPostgresAuditLogRecord(obj: Record<string, unknown>): AuditLogRecord {
  let violationKinds: string[] = [];
  if (Array.isArray(obj['violation_kinds'])) violationKinds = obj['violation_kinds'] as string[];
  else if (typeof obj['violation_kinds'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(obj['violation_kinds']);
      if (Array.isArray(parsed)) violationKinds = parsed as string[];
    } catch {
      violationKinds = [];
    }
  }
  const policyEvent = parseAuditEvent(
    obj['policy_event'], PolicyAuditEventSchema, 'policy_event', 'PolicyAuditEvent',
  );
  const proofAccessEvent = parseAuditEvent(
    obj['proof_access_event'], ProofAccessAuditEventSchema,
    'proof_access_event', 'ProofAccessAuditEvent',
  );
  const record: AuditLogRecord = {
    id: String(obj['id'] ?? ''),
    snapshotId: obj['snapshot_id'] != null ? String(obj['snapshot_id']) : null,
    projectId: String(obj['project_id'] ?? ''),
    runId: String(obj['run_id'] ?? ''),
    engineId: String(obj['engine_id'] ?? ''),
    correlationId: String(obj['correlation_id'] ?? ''),
    operation: obj['operation'] as AuditLogRecord['operation'],
    result: obj['result'] as AuditLogRecord['result'],
    violationCount: Number(obj['violation_count'] ?? 0),
    violationKinds,
    durationMs: Number(obj['duration_ms'] ?? 0),
    createdAt: String(obj['created_at'] ?? ''),
    astNodeCount: obj['ast_node_count'] != null ? Number(obj['ast_node_count']) : null,
    fileLineCount: obj['file_line_count'] != null ? Number(obj['file_line_count']) : null,
    manifestScopeRatio: obj['manifest_scope_ratio'] != null ? Number(obj['manifest_scope_ratio']) : null,
    auditSequence: obj['audit_sequence'] != null ? Number(obj['audit_sequence']) : null,
    previousChainHash: obj['previous_chain_hash'] != null ? String(obj['previous_chain_hash']) : null,
    rowHash: obj['row_hash'] != null ? String(obj['row_hash']) : null,
    chainHash: obj['chain_hash'] != null ? String(obj['chain_hash']) : null,
    chainVersion: obj['chain_version'] != null ? Number(obj['chain_version']) : null,
    chainAlgorithm: obj['chain_algorithm'] != null
      ? obj['chain_algorithm'] as AuditLogRecord['chainAlgorithm']
      : null,
    ...(policyEvent !== null ? { policyEvent } : {}),
    ...(proofAccessEvent !== null ? { proofAccessEvent } : {}),
  };
  const validation = AuditLogRecordSchema.safeParse(record);
  if (!validation.success) {
    throwPostgresSnapshotRead(
      validation.error,
      'SnapshotStore(pg): assembled AuditLogRecord failed schema validation',
    );
  }
  return validation.data;
}
