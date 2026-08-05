import type { Database } from 'sql.js';
import { AuditLogRecordSchema } from '../../contracts/auditLog.js';
import type { AuditLogRecord } from '../../contracts/auditLog.js';
import { ProofAccessAuditEventSchema } from '../../contracts/complianceAccess.js';
import { WritableManifestSchema } from '../../contracts/manifest.js';
import { PolicyAuditEventSchema } from '../../contracts/policyAudit.js';
import { SnapshotRecordSchema } from '../snapshotStore.js';
import type { SnapshotRecord } from '../snapshotStore.js';
import { throwSqliteSnapshotRead } from './sqliteErrors.js';

export const AUDIT_LOG_COLUMNS = `id, snapshot_id, project_id, run_id, engine_id,
  correlation_id, operation, result, violation_count, violation_kinds, duration_ms,
  created_at, ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
  proof_access_event, audit_sequence, previous_chain_hash, row_hash, chain_hash,
  chain_version, chain_algorithm`;

function parseJsonArray(
  value: unknown,
  column: 'replica_ids' | 'presence_paths',
): string[] {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new TypeError(`${column} is not an array`);
    return parsed as string[];
  } catch (cause) {
    throwSqliteSnapshotRead(cause, `SnapshotStore: failed to parse ${column} JSON from database`);
  }
}

export function rowToSqliteSnapshotRecord(row: Record<string, unknown>): SnapshotRecord {
  let manifest: SnapshotRecord['manifest'] = null;
  if (row['manifest'] != null) {
    let parsed: unknown;
    try {
      parsed = typeof row['manifest'] === 'string' ? JSON.parse(row['manifest']) : row['manifest'];
    } catch (cause) {
      throwSqliteSnapshotRead(cause, 'SnapshotStore: failed to parse manifest JSON from database');
    }
    const validation = WritableManifestSchema.safeParse(parsed);
    if (!validation.success) {
      throwSqliteSnapshotRead(
        validation.error,
        'SnapshotStore: manifest in database failed WritableManifest schema validation',
      );
    }
    manifest = validation.data;
  }
  const replicaIds = row['replica_ids'] == null ? [] : parseJsonArray(row['replica_ids'], 'replica_ids');
  const presencePaths = row['presence_paths'] == null
    ? null
    : parseJsonArray(row['presence_paths'], 'presence_paths');
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
    throwSqliteSnapshotRead(
      validation.error,
      'SnapshotStore: assembled record failed SnapshotRecord schema validation',
    );
  }
  return validation.data;
}

export function sqliteSnapshotParams(record: SnapshotRecord): (string | number | null)[] {
  return [
    record.id,
    record.manifestSchemaVersion,
    record.engineId,
    record.projectId,
    record.runId,
    record.correlationId,
    record.status,
    record.statusReason ?? null,
    record.gitRef ?? null,
    record.manifest != null ? JSON.stringify(record.manifest) : null,
    record.createdAt,
    record.ttlExpires ?? null,
    JSON.stringify(record.replicaIds),
    record.presencePaths != null ? JSON.stringify(record.presencePaths) : null,
  ];
}

export function execSqliteSnapshotSelect(
  db: Database,
  sql: string,
  params: (string | number | null)[],
): SnapshotRecord[] {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((row) => rowToSqliteSnapshotRecord(Object.fromEntries(
    result.columns.map((column, index) => [column, row[index] ?? null]),
  )));
}

function parseAuditEvent<T>(
  value: unknown,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } },
  column: 'policy_event' | 'proof_access_event',
  schemaName: string,
): T | null {
  if (value == null) return null;
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    const validation = schema.safeParse(parsed);
    if (!validation.success) {
      throwSqliteSnapshotRead(
        validation.error,
        `SnapshotStore: ${column} failed ${schemaName} schema validation`,
      );
    }
    return validation.data;
  } catch (cause) {
    throwSqliteSnapshotRead(cause, `SnapshotStore: failed to parse ${column} JSON from database`);
  }
}

export function rowToSqliteAuditLogRecord(
  columns: string[],
  row: ReadonlyArray<string | number | Uint8Array | null>,
): AuditLogRecord {
  const obj = Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]));
  let violationKinds: string[] = [];
  if (obj['violation_kinds'] != null) {
    try {
      const parsed: unknown = typeof obj['violation_kinds'] === 'string'
        ? JSON.parse(obj['violation_kinds'])
        : obj['violation_kinds'];
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
    throwSqliteSnapshotRead(
      validation.error,
      'SnapshotStore: assembled AuditLogRecord failed schema validation',
    );
  }
  return validation.data;
}
