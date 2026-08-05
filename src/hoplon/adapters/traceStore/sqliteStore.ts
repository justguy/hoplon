import type { Database } from 'sql.js';
import type { Attempt } from '../../contracts/attempt.js';
import type { DecisionProvenance } from '../../contracts/decisionProvenance.js';
import type { ExecutionStatus, ExecutionTrace } from '../../contracts/executionTrace.js';
import type { ProofBundle, ProofViolation } from '../../contracts/proofBundle.js';
import type { TraceExportBundle, TraceSearchFilters, TraceStore } from '../traceStore.js';
import {
  rowToAttempt,
  rowToExecution,
  rowToProofBundle,
  rowToProvenance,
  rowToViolation,
} from './rowMappers.js';
import {
  buildSqliteAttemptSearchQuery,
  buildSqliteExecutionsQuery,
  execSqliteTraceRows,
  flushSqliteTraceDatabase,
  wrapTraceRead,
  wrapTraceWrite,
} from './sqliteSupport.js';

export class SqliteTraceStore implements TraceStore {
  constructor(private readonly db: Database, private readonly dbPath: string | null) {}

  private flush(): void {
    flushSqliteTraceDatabase(this.db, this.dbPath);
  }

  async putExecution(trace: ExecutionTrace): Promise<void> {
    try {
      this.db.run(`INSERT OR IGNORE INTO hoplon_trace_executions (
        execution_id, project_id, run_id, engine_id, correlation_id, plan_ref,
        baseline_snapshot_ref, current_status, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        trace.executionId, trace.projectId, trace.runId, trace.engineId,
        trace.correlationId, trace.planRef, trace.baselineSnapshotRef,
        trace.currentStatus, trace.origin, trace.createdAt, trace.updatedAt,
      ]);
      this.flush();
    } catch (cause) { wrapTraceWrite(cause, 'putExecution failed'); }
  }

  async updateExecution(
    executionId: string,
    patch: { currentStatus: ExecutionStatus; updatedAt: string },
  ): Promise<void> {
    try {
      this.db.run('UPDATE hoplon_trace_executions SET current_status = ?, updated_at = ? WHERE execution_id = ?', [
        patch.currentStatus, patch.updatedAt, executionId,
      ]);
      this.flush();
    } catch (cause) { wrapTraceWrite(cause, 'updateExecution failed'); }
  }

  async getExecution(executionId: string): Promise<ExecutionTrace | null> {
    try {
      const row = execSqliteTraceRows(this.db, 'SELECT * FROM hoplon_trace_executions WHERE execution_id = ?', [executionId])[0];
      return row ? rowToExecution(row) : null;
    } catch (cause) { wrapTraceRead(cause, 'getExecution failed'); }
  }

  async listExecutions(filters: TraceSearchFilters): Promise<ExecutionTrace[]> {
    try {
      const { sql, params } = buildSqliteExecutionsQuery(filters);
      return execSqliteTraceRows(this.db, sql, params).map(rowToExecution);
    } catch (cause) { wrapTraceRead(cause, 'listExecutions failed'); }
  }

  async appendAttempt(attempt: Attempt): Promise<void> {
    try {
      this.db.run(`INSERT OR IGNORE INTO hoplon_trace_attempts (
        attempt_id, execution_id, attempt_number, contract_ref, based_on_snapshot_ref,
        result_snapshot_ref, audit_ref, proof_bundle_ref, status, actor_type,
        actor_ref, repair_plan_ref, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        attempt.attemptId, attempt.executionId, attempt.attemptNumber, attempt.contractRef,
        attempt.basedOnSnapshotRef, attempt.resultSnapshotRef, attempt.auditRef,
        attempt.proofBundleRef, attempt.status, attempt.actorType, attempt.actorRef,
        attempt.repairPlanRef, attempt.startedAt, attempt.completedAt,
      ]);
      this.flush();
    } catch (cause) { wrapTraceWrite(cause, 'appendAttempt failed'); }
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    try {
      const row = execSqliteTraceRows(this.db, 'SELECT * FROM hoplon_trace_attempts WHERE attempt_id = ?', [attemptId])[0];
      return row ? rowToAttempt(row) : null;
    } catch (cause) { wrapTraceRead(cause, 'getAttempt failed'); }
  }

  async listAttempts(executionId: string): Promise<Attempt[]> {
    try {
      const rows = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_attempts WHERE execution_id = ? ORDER BY attempt_number ASC',
        [executionId]);
      return rows.map(rowToAttempt);
    } catch (cause) { wrapTraceRead(cause, 'listAttempts failed'); }
  }

  async putProofBundle(bundle: ProofBundle, violations: ProofViolation[]): Promise<void> {
    try {
      this.db.run(`INSERT OR IGNORE INTO hoplon_trace_proof_bundles (
        proof_bundle_ref, attempt_id, execution_id, project_id, run_id, snapshot_ref_before,
        snapshot_ref_after, audit_ref, violation_refs, manifest_ref, engine_version,
        engine_id, schema_version, correlation_id, audit_result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        bundle.proofBundleRef, bundle.attemptId, bundle.executionId, bundle.projectId,
        bundle.runId, bundle.snapshotRefBefore, bundle.snapshotRefAfter, bundle.auditRef,
        JSON.stringify(bundle.violationRefs), bundle.manifestRef, bundle.engineVersion,
        bundle.engineId, bundle.schemaVersion, bundle.correlationId,
        JSON.stringify(bundle.auditResult), bundle.createdAt,
      ]);
      for (const violation of violations) {
        this.db.run(`INSERT OR IGNORE INTO hoplon_trace_violations (
          violation_id, proof_bundle_ref, attempt_id, execution_id, project_id, run_id,
          kind, path, symbol_name, node_kind, byte_range_start, byte_range_end,
          index_in_bundle, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          violation.violationId, violation.proofBundleRef, violation.attemptId,
          violation.executionId, violation.projectId, violation.runId, violation.kind,
          violation.path, violation.symbolName, violation.nodeKind,
          violation.byteRangeStart, violation.byteRangeEnd,
          violation.indexInBundle, violation.createdAt,
        ]);
      }
      this.flush();
    } catch (cause) { wrapTraceWrite(cause, 'putProofBundle failed'); }
  }

  async getProofBundle(proofBundleRef: string): Promise<ProofBundle | null> {
    try {
      const row = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_proof_bundles WHERE proof_bundle_ref = ?',
        [proofBundleRef])[0];
      return row ? rowToProofBundle(row) : null;
    } catch (cause) { wrapTraceRead(cause, 'getProofBundle failed'); }
  }

  async listProofBundles(executionId: string): Promise<ProofBundle[]> {
    try {
      const rows = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_proof_bundles WHERE execution_id = ? ORDER BY created_at ASC',
        [executionId]);
      return rows.map(rowToProofBundle);
    } catch (cause) { wrapTraceRead(cause, 'listProofBundles failed'); }
  }

  async getViolation(violationId: string): Promise<ProofViolation | null> {
    try {
      const row = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_violations WHERE violation_id = ?', [violationId])[0];
      return row ? rowToViolation(row) : null;
    } catch (cause) { wrapTraceRead(cause, 'getViolation failed'); }
  }

  async listViolations(proofBundleRef: string): Promise<ProofViolation[]> {
    try {
      const rows = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_violations WHERE proof_bundle_ref = ? ORDER BY index_in_bundle ASC',
        [proofBundleRef]);
      return rows.map(rowToViolation);
    } catch (cause) { wrapTraceRead(cause, 'listViolations failed'); }
  }

  async appendDecisionProvenance(record: DecisionProvenance): Promise<void> {
    try {
      this.db.run(`INSERT OR IGNORE INTO hoplon_trace_provenance (
        provenance_id, execution_id, attempt_id, category, summary, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        record.provenanceId, record.executionId, record.attemptId, record.category,
        record.summary, record.detail != null ? JSON.stringify(record.detail) : null,
        record.createdAt,
      ]);
      this.flush();
    } catch (cause) { wrapTraceWrite(cause, 'appendDecisionProvenance failed'); }
  }

  async listProvenance(executionId: string): Promise<DecisionProvenance[]> {
    try {
      const rows = execSqliteTraceRows(this.db,
        'SELECT * FROM hoplon_trace_provenance WHERE execution_id = ? ORDER BY created_at ASC',
        [executionId]);
      return rows.map(rowToProvenance);
    } catch (cause) { wrapTraceRead(cause, 'listProvenance failed'); }
  }

  async searchAttempts(filters: TraceSearchFilters): Promise<Attempt[]> {
    try {
      const { sql, params } = buildSqliteAttemptSearchQuery(filters);
      return execSqliteTraceRows(this.db, sql, params).map(rowToAttempt);
    } catch (cause) { wrapTraceRead(cause, 'searchAttempts failed'); }
  }

  async exportExecution(executionId: string): Promise<TraceExportBundle | null> {
    const execution = await this.getExecution(executionId);
    if (!execution) return null;
    const attempts = await this.listAttempts(executionId);
    const proofBundles = await this.listProofBundles(executionId);
    const violations: ProofViolation[] = [];
    for (const bundle of proofBundles) {
      violations.push(...await this.listViolations(bundle.proofBundleRef));
    }
    return {
      execution,
      attempts,
      proofBundles,
      violations,
      provenance: await this.listProvenance(executionId),
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
  }
}
