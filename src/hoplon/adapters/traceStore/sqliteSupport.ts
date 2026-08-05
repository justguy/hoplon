import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { AdapterError } from '../../contracts/errors.js';
import type { TraceSearchFilters } from '../traceStore.js';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hoplon_trace_executions (
  execution_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  engine_id TEXT NOT NULL, correlation_id TEXT NOT NULL, plan_ref TEXT,
  baseline_snapshot_ref TEXT, current_status TEXT NOT NULL, origin TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_exec_project_run ON hoplon_trace_executions(project_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_exec_status ON hoplon_trace_executions(current_status);
CREATE INDEX IF NOT EXISTS idx_trace_exec_snapshot ON hoplon_trace_executions(baseline_snapshot_ref);
CREATE TABLE IF NOT EXISTS hoplon_trace_attempts (
  attempt_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  contract_ref TEXT, based_on_snapshot_ref TEXT NOT NULL, result_snapshot_ref TEXT,
  audit_ref TEXT, proof_bundle_ref TEXT NOT NULL, status TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_ref TEXT NOT NULL, repair_plan_ref TEXT,
  started_at TEXT NOT NULL, completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_attempt_execution ON hoplon_trace_attempts(execution_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_trace_attempt_audit ON hoplon_trace_attempts(audit_ref);
CREATE INDEX IF NOT EXISTS idx_trace_attempt_snapshot ON hoplon_trace_attempts(based_on_snapshot_ref);
CREATE TABLE IF NOT EXISTS hoplon_trace_proof_bundles (
  proof_bundle_ref TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, snapshot_ref_before TEXT NOT NULL,
  snapshot_ref_after TEXT, audit_ref TEXT, violation_refs TEXT NOT NULL DEFAULT '[]',
  manifest_ref TEXT, engine_version TEXT NOT NULL, engine_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL, correlation_id TEXT NOT NULL,
  audit_result TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_proof_attempt ON hoplon_trace_proof_bundles(attempt_id);
CREATE INDEX IF NOT EXISTS idx_trace_proof_execution ON hoplon_trace_proof_bundles(execution_id, created_at);
CREATE TABLE IF NOT EXISTS hoplon_trace_violations (
  violation_id TEXT PRIMARY KEY, proof_bundle_ref TEXT NOT NULL, attempt_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL, path TEXT, symbol_name TEXT, node_kind TEXT,
  byte_range_start INTEGER, byte_range_end INTEGER, index_in_bundle INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_violation_bundle ON hoplon_trace_violations(proof_bundle_ref);
CREATE INDEX IF NOT EXISTS idx_trace_violation_path ON hoplon_trace_violations(path);
CREATE INDEX IF NOT EXISTS idx_trace_violation_project ON hoplon_trace_violations(project_id, run_id);
CREATE TABLE IF NOT EXISTS hoplon_trace_provenance (
  provenance_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, attempt_id TEXT,
  category TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_provenance_exec ON hoplon_trace_provenance(execution_id, created_at);
`;

export function wrapTraceRead(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_read_failed',
    engineId: 'adapter',
    correlationId: 'adapter',
    cause,
  }, `TraceStore: ${message}`);
}

export function wrapTraceWrite(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_write_failed',
    engineId: 'adapter',
    correlationId: 'adapter',
    cause,
  }, `TraceStore: ${message}`);
}

export function execSqliteTraceRows(
  db: Database,
  sql: string,
  params: (string | number | null)[],
): Record<string, unknown>[] {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((row) => Object.fromEntries(
    result.columns.map((column, index) => [column, row[index] ?? null]),
  ));
}

export function flushSqliteTraceDatabase(db: Database, dbPath: string | null): void {
  if (dbPath === null) return;
  try {
    writeFileSync(dbPath, Buffer.from(db.export()));
  } catch (cause) {
    wrapTraceWrite(cause, 'failed to flush database to disk');
  }
}

export function buildSqliteExecutionsQuery(filters: TraceSearchFilters): {
  sql: string;
  params: (string | number | null)[];
} {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  const add = (condition: string, value: string | undefined): void => {
    if (value !== undefined) {
      conditions.push(condition);
      params.push(value);
    }
  };
  add('project_id = ?', filters.projectId);
  add('run_id = ?', filters.runId);
  add('current_status = ?', filters.status);
  add('baseline_snapshot_ref = ?', filters.snapshotRef);
  add('created_at >= ?', filters.createdAfter);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql: `SELECT * FROM hoplon_trace_executions ${where} ORDER BY created_at ASC`, params };
}

export function buildSqliteAttemptSearchQuery(filters: TraceSearchFilters): {
  sql: string;
  params: (string | number | null)[];
} {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  let joinPath = '';
  if (filters.path !== undefined) {
    joinPath = 'INNER JOIN hoplon_trace_violations v ON v.attempt_id = a.attempt_id';
    conditions.push('v.path = ?');
    params.push(filters.path);
  }
  if (filters.projectId !== undefined || filters.runId !== undefined) {
    conditions.push('EXISTS (SELECT 1 FROM hoplon_trace_executions e WHERE e.execution_id = a.execution_id'
      + (filters.projectId !== undefined ? ' AND e.project_id = ?' : '')
      + (filters.runId !== undefined ? ' AND e.run_id = ?' : '') + ')');
    if (filters.projectId !== undefined) params.push(filters.projectId);
    if (filters.runId !== undefined) params.push(filters.runId);
  }
  if (filters.status !== undefined) {
    conditions.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.auditRef !== undefined) {
    conditions.push('a.audit_ref = ?');
    params.push(filters.auditRef);
  }
  if (filters.snapshotRef !== undefined) {
    conditions.push('(a.based_on_snapshot_ref = ? OR a.result_snapshot_ref = ?)');
    params.push(filters.snapshotRef, filters.snapshotRef);
  }
  if (filters.createdAfter !== undefined) {
    conditions.push('a.started_at >= ?');
    params.push(filters.createdAfter);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql: `SELECT DISTINCT a.* FROM hoplon_trace_attempts a ${joinPath} ${where} ORDER BY a.started_at ASC`,
    params,
  };
}

export async function openSqliteTraceDatabase(dbPath: string | null): Promise<Database> {
  const SQL = await initSqlJs();
  const db = dbPath !== null && existsSync(dbPath)
    ? new SQL.Database(readFileSync(dbPath))
    : new SQL.Database();
  db.run('PRAGMA journal_mode=WAL');
  db.run(MIGRATION_SQL);
  if (dbPath !== null) writeFileSync(dbPath, Buffer.from(db.export()));
  return db;
}
