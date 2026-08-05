/**
 * tests/integration/phase3/postgres.integration.test.ts — PG1 integration tests.
 *
 * Gated by `RUN_INTEGRATION=1` environment variable. Requires a real PostgreSQL
 * instance accessible at PGHOST:PGPORT/PGDATABASE (see env vars below).
 *
 * These tests are NOT on the default CI path. They are run explicitly by
 * developers who have a local PostgreSQL instance or in a CI environment that
 * provides PostgreSQL as a service.
 *
 * Run with:
 *   RUN_INTEGRATION=1 npx vitest run tests/integration/phase3/postgres.integration.test.ts
 *
 * Environment variables:
 *   PGHOST      — PostgreSQL hostname (default: localhost)
 *   PGPORT      — PostgreSQL port (default: 5432)
 *   PGDATABASE  — Database name (default: hoplon_test)
 *   PGUSER      — PostgreSQL user (default: postgres)
 *   PGPASSWORD  — PostgreSQL password (optional)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SnapshotRecord } from '../../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';

const RUN = process.env['RUN_INTEGRATION'] === '1';

describe(
  RUN
    ? 'PostgreSQL integration — SnapshotStore (real PG)'
    : 'PostgreSQL integration (SKIPPED — set RUN_INTEGRATION=1)',
  () => {
    if (!RUN) {
      it.skip('skipped — set RUN_INTEGRATION=1 to enable', () => {});
      return;
    }

    const PGHOST = process.env['PGHOST'] ?? 'localhost';
    const PGPORT = parseInt(process.env['PGPORT'] ?? '5432', 10);
    const PGDATABASE = process.env['PGDATABASE'] ?? 'hoplon_test';
    const PGUSER = process.env['PGUSER'] ?? 'postgres';
    const PGPASSWORD = process.env['PGPASSWORD'];

    // Dynamic imports to avoid loading pg at non-integration test time.
    let store: Awaited<ReturnType<typeof import('../../../src/hoplon/adapters/snapshotStore/postgres.js')['createPostgresSnapshotStore']>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pool: any;

    // ---------------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------------

    function makeManifest(overrides: Partial<WritableManifest> = {}): WritableManifest {
      return {
        manifestSchemaVersion: 1,
        projectId: 'proj-pg-integration',
        runId: 'run-pg-integration',
        correlationId: 'corr-pg-integration',
        entries: [{ path: 'src/index.ts', scope: { kind: 'whole_file' } }],
        ...overrides,
      };
    }

    function makeRecord(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
      return {
        id: 'a'.repeat(64),
        manifestSchemaVersion: 1,
        engineId: 'local-0',
        projectId: 'proj-pg-integration',
        runId: 'run-pg-integration',
        correlationId: 'corr-pg-integration',
        status: 'pending',
        statusReason: null,
        gitRef: null,
        manifest: makeManifest(),
        createdAt: new Date().toISOString(),
        ttlExpires: null,
        replicaIds: [],
        ...overrides,
      };
    }

    // ---------------------------------------------------------------------------
    // Setup / teardown
    // ---------------------------------------------------------------------------

    beforeAll(async () => {
      const { default: PgModule } = await import('pg');
      const { Pool } = PgModule;
      pool = new Pool({
        host: PGHOST,
        port: PGPORT,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD,
        max: 5,
        connectionTimeoutMillis: 5_000,
      });

      // Verify connection
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();

      const { createPostgresSnapshotStore } = await import(
        '../../../src/hoplon/adapters/snapshotStore/postgres.js'
      );
      store = await createPostgresSnapshotStore({ pool });
    });

    afterAll(async () => {
      if (pool) {
        // Clean up integration test records
        try {
          const client = await pool.connect();
          await client.query(
            "DELETE FROM hoplon_snapshots WHERE project_id LIKE 'proj-pg-integration%'",
          );
          await client.query(
            "DELETE FROM hoplon_audit_log WHERE project_id LIKE 'proj-pg-integration%'",
          );
          client.release();
        } catch {
          // Ignore cleanup errors
        }
        await pool.end();
      }
    });

    beforeEach(async () => {
      // Clear test data before each test
      const client = await pool.connect();
      await client.query(
        "DELETE FROM hoplon_snapshots WHERE project_id = 'proj-pg-integration'",
      );
      await client.query(
        "DELETE FROM hoplon_audit_log WHERE project_id = 'proj-pg-integration'",
      );
      client.release();
    });

    // ---------------------------------------------------------------------------
    // Integration tests
    // ---------------------------------------------------------------------------

    it('put() + get() round-trip against real PostgreSQL', async () => {
      const id = `sha256:${'a'.repeat(64)}`;
      const record = makeRecord({ id });

      await store.put(record);
      const retrieved = await store.get(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.status).toBe('pending');
    });

    it('two-phase atomic write: pending → committed against real PostgreSQL', async () => {
      const id = `sha256:${'b'.repeat(64)}`;
      const record = makeRecord({ id, status: 'pending' });

      await store.put(record);

      const gitRef = `real-git-ref-${randomUUID()}`;
      await store.updateStatus(id, 'committed', undefined, gitRef);

      const committed = await store.get(id);
      expect(committed!.status).toBe('committed');
      expect(committed!.gitRef).toBe(gitRef);
    });

    it('DS1 setReplicaIds + listByReplica against real PostgreSQL', async () => {
      const id = `sha256:${'c'.repeat(64)}`;
      const record = makeRecord({ id, replicaIds: [] });

      await store.put(record);

      await store.setReplicaIds!(id, ['node-prod-1', 'node-prod-2']);

      const byNode1 = await store.listByReplica!('node-prod-1');
      expect(byNode1.map((r) => r.id)).toContain(id);

      const byNode2 = await store.listByReplica!('node-prod-2');
      expect(byNode2.map((r) => r.id)).toContain(id);

      const byNone = await store.listByReplica!('node-nonexistent');
      expect(byNone.map((r) => r.id)).not.toContain(id);
    });

    it('appendAuditLog() + findAuditLogByProjectAndRun() against real PostgreSQL', async () => {
      const { AuditLogRecordSchema } = await import(
        '../../../src/hoplon/contracts/auditLog.js'
      );

      const logRecord = AuditLogRecordSchema.parse({
        id: randomUUID(),
        snapshotId: null,
        projectId: 'proj-pg-integration',
        runId: 'run-pg-integration',
        engineId: 'local-0',
        correlationId: 'corr-pg-integration',
        operation: 'AUDIT_DIFF',
        result: 'PASS',
        violationCount: 0,
        violationKinds: [],
        durationMs: 100,
        createdAt: new Date().toISOString(),
        astNodeCount: 999,
        fileLineCount: 200,
        manifestScopeRatio: 0.5,
      });

      await store.appendAuditLog(logRecord);

      const entries = await store.findAuditLogByProjectAndRun(
        'proj-pg-integration',
        'run-pg-integration',
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]!.astNodeCount).toBe(999);
      expect(entries[0]!.fileLineCount).toBe(200);
      expect(entries[0]!.manifestScopeRatio).toBeCloseTo(0.5);
    });
  },
);
