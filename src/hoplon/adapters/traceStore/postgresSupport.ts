import type { Pool } from 'pg';
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
  snapshot_ref_after TEXT, audit_ref TEXT, violation_refs JSONB NOT NULL DEFAULT '[]',
  manifest_ref TEXT, engine_version TEXT NOT NULL, engine_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL, correlation_id TEXT NOT NULL,
  audit_result JSONB NOT NULL, created_at TEXT NOT NULL
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
  category TEXT NOT NULL, summary TEXT NOT NULL, detail JSONB, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_provenance_exec ON hoplon_trace_provenance(execution_id, created_at);
`;

export type PgTraceParam = string | number | boolean | null;

export function wrapPgTraceRead(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_read_failed', engineId: 'adapter', correlationId: 'adapter', cause,
  }, `TraceStore(pg): ${message}`);
}

export function wrapPgTraceWrite(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_write_failed', engineId: 'adapter', correlationId: 'adapter', cause,
  }, `TraceStore(pg): ${message}`);
}

export function buildPgExecutionsQuery(filters: TraceSearchFilters): {
  sql: string;
  params: PgTraceParam[];
} {
  const conditions: string[] = [];
  const params: PgTraceParam[] = [];
  const push = (condition: string, value: PgTraceParam): void => {
    params.push(value);
    conditions.push(condition.replace('?', `$${params.length}`));
  };
  if (filters.projectId !== undefined) push('project_id = ?', filters.projectId);
  if (filters.runId !== undefined) push('run_id = ?', filters.runId);
  if (filters.status !== undefined) push('current_status = ?', filters.status);
  if (filters.snapshotRef !== undefined) push('baseline_snapshot_ref = ?', filters.snapshotRef);
  if (filters.createdAfter !== undefined) push('created_at >= ?', filters.createdAfter);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql: `SELECT * FROM hoplon_trace_executions ${where} ORDER BY created_at ASC`, params };
}

export function buildPgAttemptSearchQuery(filters: TraceSearchFilters): {
  sql: string;
  params: PgTraceParam[];
} {
  const conditions: string[] = [];
  const params: PgTraceParam[] = [];
  const push = (condition: string, value: PgTraceParam): void => {
    params.push(value);
    conditions.push(condition.replace('?', `$${params.length}`));
  };
  let join = '';
  if (filters.path !== undefined) {
    join = 'INNER JOIN hoplon_trace_violations v ON v.attempt_id = a.attempt_id';
    push('v.path = ?', filters.path);
  }
  if (filters.projectId !== undefined || filters.runId !== undefined) {
    const inner: string[] = [];
    if (filters.projectId !== undefined) {
      params.push(filters.projectId);
      inner.push(`project_id = $${params.length}`);
    }
    if (filters.runId !== undefined) {
      params.push(filters.runId);
      inner.push(`run_id = $${params.length}`);
    }
    conditions.push(`a.execution_id IN (SELECT execution_id FROM hoplon_trace_executions WHERE ${inner.join(' AND ')})`);
  }
  if (filters.status !== undefined) push('a.status = ?', filters.status);
  if (filters.auditRef !== undefined) push('a.audit_ref = ?', filters.auditRef);
  if (filters.snapshotRef !== undefined) {
    params.push(filters.snapshotRef);
    const index = params.length;
    conditions.push(`(a.based_on_snapshot_ref = $${index} OR a.result_snapshot_ref = $${index})`);
  }
  if (filters.createdAfter !== undefined) push('a.started_at >= ?', filters.createdAfter);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql: `SELECT DISTINCT a.* FROM hoplon_trace_attempts a ${join} ${where} ORDER BY a.started_at ASC`,
    params,
  };
}

export async function runPostgresTraceMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
  } finally {
    client.release();
  }
}
