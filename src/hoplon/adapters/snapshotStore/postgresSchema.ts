import type { Pool, PoolClient } from 'pg';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hoplon_snapshots (
  id TEXT PRIMARY KEY, manifest_schema_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'committed', 'failed')),
  status_reason TEXT, git_ref TEXT, manifest JSONB, created_at TEXT NOT NULL,
  ttl_expires TEXT, replica_ids JSONB NOT NULL DEFAULT '[]', presence_paths JSONB
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project_run ON hoplon_snapshots(project_id, run_id, status);
CREATE INDEX IF NOT EXISTS idx_snapshots_engine ON hoplon_snapshots(engine_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_status_created ON hoplon_snapshots(status, created_at);
CREATE TABLE IF NOT EXISTS hoplon_audit_log (
  id TEXT PRIMARY KEY, snapshot_id TEXT, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  engine_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN (
    'CREATE_SNAPSHOT', 'AUDIT_DIFF', 'REVERT', 'POLICY_HANDSHAKE',
    'POLICY_ACCESS_CHECK', 'POLICY_RENEW', 'POLICY_REVOKE', 'PROOF_ACCESS'
  )),
  result TEXT NOT NULL CHECK(result IN (
    'PASS', 'BLOCK', 'ERROR', 'GRANTED', 'DENIED',
    'REAUTH_REQUIRED', 'REVOKED'
  )),
  violation_count INTEGER NOT NULL DEFAULT 0,
  violation_kinds JSONB NOT NULL DEFAULT '[]', duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL, audit_sequence INTEGER, previous_chain_hash TEXT,
  row_hash TEXT, chain_hash TEXT, chain_version INTEGER, chain_algorithm TEXT,
  proof_access_event JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_log_project_run ON hoplon_audit_log(project_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_snapshot ON hoplon_audit_log(snapshot_id);
`;

const ADDITIVE_MIGRATIONS = [
  'ALTER TABLE hoplon_audit_log ADD COLUMN ast_node_count INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN file_line_count INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN manifest_scope_ratio REAL',
  'ALTER TABLE hoplon_audit_log ADD COLUMN policy_event JSONB',
  'ALTER TABLE hoplon_audit_log ADD COLUMN proof_access_event JSONB',
  'ALTER TABLE hoplon_audit_log ADD COLUMN audit_sequence INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN previous_chain_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN row_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_hash TEXT',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_version INTEGER',
  'ALTER TABLE hoplon_audit_log ADD COLUMN chain_algorithm TEXT',
  'ALTER TABLE hoplon_snapshots ADD COLUMN presence_paths JSONB',
];

const POLICY_CHECK_MIGRATIONS = [
  'ALTER TABLE hoplon_audit_log DROP CONSTRAINT IF EXISTS hoplon_audit_log_operation_check',
  'ALTER TABLE hoplon_audit_log DROP CONSTRAINT IF EXISTS hoplon_audit_log_result_check',
  `ALTER TABLE hoplon_audit_log ADD CONSTRAINT hoplon_audit_log_operation_check
    CHECK (operation IN ('CREATE_SNAPSHOT','AUDIT_DIFF','REVERT','POLICY_HANDSHAKE',
      'POLICY_ACCESS_CHECK','POLICY_RENEW','POLICY_REVOKE','PROOF_ACCESS'))`,
  `ALTER TABLE hoplon_audit_log ADD CONSTRAINT hoplon_audit_log_result_check
    CHECK (result IN ('PASS','BLOCK','ERROR','GRANTED','DENIED',
      'REAUTH_REQUIRED','REVOKED'))`,
];

async function attemptMigrations(client: PoolClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    try { await client.query(statement); } catch { /* Idempotent/dialect-compatible migration. */ }
  }
}

export async function runPostgresSnapshotMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
    await attemptMigrations(client, ADDITIVE_MIGRATIONS);
    await attemptMigrations(client, [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_chain_sequence
        ON hoplon_audit_log(project_id, run_id, audit_sequence)
        WHERE audit_sequence IS NOT NULL`,
    ]);
    await attemptMigrations(client, POLICY_CHECK_MIGRATIONS);
  } finally {
    client.release();
  }
}
