import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hoplon_snapshots (
  id TEXT PRIMARY KEY, manifest_schema_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'committed', 'failed')),
  status_reason TEXT, git_ref TEXT, manifest JSON, created_at TEXT NOT NULL,
  ttl_expires TEXT, replica_ids JSON DEFAULT '[]', presence_paths JSON
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project_run ON hoplon_snapshots(project_id, run_id, status);
CREATE INDEX IF NOT EXISTS idx_snapshots_engine ON hoplon_snapshots(engine_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_status_created ON hoplon_snapshots(status, created_at);
CREATE TABLE IF NOT EXISTS hoplon_audit_log (
  id TEXT PRIMARY KEY, snapshot_id TEXT, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  engine_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN (
    'CREATE_SNAPSHOT', 'AUDIT_DIFF', 'REVERT', 'POLICY_HANDSHAKE',
    'POLICY_ACCESS_CHECK', 'POLICY_CAPABILITY_CHECK', 'POLICY_RENEW',
    'POLICY_REVOKE', 'PROOF_ACCESS'
  )),
  result TEXT NOT NULL CHECK(result IN (
    'PASS', 'BLOCK', 'ERROR', 'GRANTED', 'DENIED',
    'REAUTH_REQUIRED', 'REVOKED'
  )),
  violation_count INTEGER NOT NULL DEFAULT 0,
  violation_kinds TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL, audit_sequence INTEGER, previous_chain_hash TEXT,
  row_hash TEXT, chain_hash TEXT, chain_version INTEGER, chain_algorithm TEXT,
  proof_access_event TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_project_run ON hoplon_audit_log(project_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_snapshot ON hoplon_audit_log(snapshot_id);
`;

const ADDITIVE_MIGRATIONS = [
  'ALTER TABLE hoplon_audit_log ADD COLUMN ast_node_count INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN file_line_count INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN manifest_scope_ratio REAL',
  'ALTER TABLE hoplon_audit_log ADD COLUMN policy_event TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN proof_access_event TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN audit_sequence INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN previous_chain_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN row_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_version INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_algorithm TEXT',
  'ALTER TABLE hoplon_snapshots ADD COLUMN presence_paths JSON',
];

function maybeWidenAuditLogCheck(db: Database): void {
  let storedSql = '';
  try {
    const result = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='hoplon_audit_log'")[0];
    if (!result?.values[0]) return;
    storedSql = String(result.values[0][0] ?? '');
  } catch {
    return;
  }
  if (
    storedSql.length === 0 ||
    (storedSql.includes('POLICY_HANDSHAKE') && storedSql.includes('POLICY_CAPABILITY_CHECK'))
  ) return;
  db.run(`
    CREATE TABLE hoplon_audit_log__wide (
      id TEXT PRIMARY KEY, snapshot_id TEXT, project_id TEXT NOT NULL,
      run_id TEXT NOT NULL, engine_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN (
        'CREATE_SNAPSHOT', 'AUDIT_DIFF', 'REVERT', 'POLICY_HANDSHAKE',
        'POLICY_ACCESS_CHECK', 'POLICY_CAPABILITY_CHECK', 'POLICY_RENEW',
        'POLICY_REVOKE', 'PROOF_ACCESS'
      )),
      result TEXT NOT NULL CHECK(result IN (
        'PASS', 'BLOCK', 'ERROR', 'GRANTED', 'DENIED',
        'REAUTH_REQUIRED', 'REVOKED'
      )),
      violation_count INTEGER NOT NULL DEFAULT 0,
      violation_kinds TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL, ast_node_count INTEGER, file_line_count INTEGER,
      manifest_scope_ratio REAL, policy_event TEXT, proof_access_event TEXT,
      audit_sequence INTEGER, previous_chain_hash TEXT, row_hash TEXT,
      chain_hash TEXT, chain_version INTEGER, chain_algorithm TEXT
    );
    INSERT INTO hoplon_audit_log__wide (
      id, snapshot_id, project_id, run_id, engine_id, correlation_id,
      operation, result, violation_count, violation_kinds, duration_ms, created_at,
      ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
      proof_access_event, audit_sequence, previous_chain_hash, row_hash,
      chain_hash, chain_version, chain_algorithm
    ) SELECT id, snapshot_id, project_id, run_id, engine_id, correlation_id,
      operation, result, violation_count, violation_kinds, duration_ms, created_at,
      ast_node_count, file_line_count, manifest_scope_ratio, policy_event,
      proof_access_event, audit_sequence, previous_chain_hash, row_hash,
      chain_hash, chain_version, chain_algorithm FROM hoplon_audit_log;
    DROP TABLE hoplon_audit_log;
    ALTER TABLE hoplon_audit_log__wide RENAME TO hoplon_audit_log;
    CREATE INDEX IF NOT EXISTS idx_audit_log_project_run ON hoplon_audit_log(project_id, run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_snapshot ON hoplon_audit_log(snapshot_id);
  `);
}

export async function openSqliteSnapshotDatabase(dbPath: string | null): Promise<Database> {
  const SQL = await initSqlJs();
  const db = dbPath !== null && existsSync(dbPath)
    ? new SQL.Database(readFileSync(dbPath))
    : new SQL.Database();
  db.run('PRAGMA journal_mode=WAL');
  db.run(MIGRATION_SQL);
  for (const statement of ADDITIVE_MIGRATIONS) {
    try { db.run(statement); } catch { /* Column already exists. */ }
  }
  maybeWidenAuditLogCheck(db);
  try {
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_chain_sequence
      ON hoplon_audit_log(project_id, run_id, audit_sequence)
      WHERE audit_sequence IS NOT NULL`);
  } catch {
    // Insert validation and verification still preserve the contract.
  }
  if (dbPath !== null) writeFileSync(dbPath, Buffer.from(db.export()));
  return db;
}
