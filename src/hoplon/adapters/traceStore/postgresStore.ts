import type { Pool, PoolClient } from 'pg';
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
  buildPgAttemptSearchQuery,
  buildPgExecutionsQuery,
  wrapPgTraceRead,
  wrapPgTraceWrite,
} from './postgresSupport.js';

export class PostgresTraceStore implements TraceStore {
  constructor(private readonly pool: Pool) {}

  async putExecution(trace: ExecutionTrace): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO hoplon_trace_executions (
        execution_id, project_id, run_id, engine_id, correlation_id, plan_ref,
        baseline_snapshot_ref, current_status, origin, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (execution_id) DO NOTHING`, [
        trace.executionId, trace.projectId, trace.runId, trace.engineId,
        trace.correlationId, trace.planRef, trace.baselineSnapshotRef,
        trace.currentStatus, trace.origin, trace.createdAt, trace.updatedAt,
      ]);
    } catch (cause) { wrapPgTraceWrite(cause, 'putExecution failed'); }
  }

  async updateExecution(
    executionId: string,
    patch: { currentStatus: ExecutionStatus; updatedAt: string },
  ): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE hoplon_trace_executions SET current_status=$1, updated_at=$2 WHERE execution_id=$3',
        [patch.currentStatus, patch.updatedAt, executionId],
      );
    } catch (cause) { wrapPgTraceWrite(cause, 'updateExecution failed'); }
  }

  async getExecution(executionId: string): Promise<ExecutionTrace | null> {
    try {
      const result = await this.pool.query('SELECT * FROM hoplon_trace_executions WHERE execution_id = $1', [executionId]);
      return result.rows[0] ? rowToExecution(result.rows[0]) : null;
    } catch (cause) { wrapPgTraceRead(cause, 'getExecution failed'); }
  }

  async listExecutions(filters: TraceSearchFilters): Promise<ExecutionTrace[]> {
    try {
      const { sql, params } = buildPgExecutionsQuery(filters);
      return (await this.pool.query(sql, params)).rows.map(rowToExecution);
    } catch (cause) { wrapPgTraceRead(cause, 'listExecutions failed'); }
  }

  async appendAttempt(attempt: Attempt): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO hoplon_trace_attempts (
        attempt_id, execution_id, attempt_number, contract_ref, based_on_snapshot_ref,
        result_snapshot_ref, audit_ref, proof_bundle_ref, status, actor_type,
        actor_ref, repair_plan_ref, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (attempt_id) DO NOTHING`, [
        attempt.attemptId, attempt.executionId, attempt.attemptNumber, attempt.contractRef,
        attempt.basedOnSnapshotRef, attempt.resultSnapshotRef, attempt.auditRef,
        attempt.proofBundleRef, attempt.status, attempt.actorType, attempt.actorRef,
        attempt.repairPlanRef, attempt.startedAt, attempt.completedAt,
      ]);
    } catch (cause) { wrapPgTraceWrite(cause, 'appendAttempt failed'); }
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    try {
      const result = await this.pool.query('SELECT * FROM hoplon_trace_attempts WHERE attempt_id = $1', [attemptId]);
      return result.rows[0] ? rowToAttempt(result.rows[0]) : null;
    } catch (cause) { wrapPgTraceRead(cause, 'getAttempt failed'); }
  }

  async listAttempts(executionId: string): Promise<Attempt[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM hoplon_trace_attempts WHERE execution_id = $1 ORDER BY attempt_number ASC',
        [executionId],
      );
      return result.rows.map(rowToAttempt);
    } catch (cause) { wrapPgTraceRead(cause, 'listAttempts failed'); }
  }

  async putProofBundle(bundle: ProofBundle, violations: ProofViolation[]): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO hoplon_trace_proof_bundles (
        proof_bundle_ref, attempt_id, execution_id, project_id, run_id, snapshot_ref_before,
        snapshot_ref_after, audit_ref, violation_refs, manifest_ref, engine_version,
        engine_id, schema_version, correlation_id, audit_result, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (proof_bundle_ref) DO NOTHING`, [
        bundle.proofBundleRef, bundle.attemptId, bundle.executionId, bundle.projectId,
        bundle.runId, bundle.snapshotRefBefore, bundle.snapshotRefAfter, bundle.auditRef,
        JSON.stringify(bundle.violationRefs), bundle.manifestRef, bundle.engineVersion,
        bundle.engineId, bundle.schemaVersion, bundle.correlationId,
        JSON.stringify(bundle.auditResult), bundle.createdAt,
      ]);
      for (const violation of violations) await this.insertViolation(client, violation);
      await client.query('COMMIT');
    } catch (cause) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original write error. */ }
      wrapPgTraceWrite(cause, 'putProofBundle failed');
    } finally {
      client.release();
    }
  }

  private async insertViolation(client: PoolClient, violation: ProofViolation): Promise<void> {
    await client.query(`INSERT INTO hoplon_trace_violations (
      violation_id, proof_bundle_ref, attempt_id, execution_id, project_id, run_id,
      kind, path, symbol_name, node_kind, byte_range_start, byte_range_end,
      index_in_bundle, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (violation_id) DO NOTHING`, [
      violation.violationId, violation.proofBundleRef, violation.attemptId,
      violation.executionId, violation.projectId, violation.runId, violation.kind,
      violation.path, violation.symbolName, violation.nodeKind,
      violation.byteRangeStart, violation.byteRangeEnd,
      violation.indexInBundle, violation.createdAt,
    ]);
  }

  async getProofBundle(proofBundleRef: string): Promise<ProofBundle | null> {
    try {
      const result = await this.pool.query('SELECT * FROM hoplon_trace_proof_bundles WHERE proof_bundle_ref = $1', [proofBundleRef]);
      return result.rows[0] ? rowToProofBundle(result.rows[0]) : null;
    } catch (cause) { wrapPgTraceRead(cause, 'getProofBundle failed'); }
  }

  async listProofBundles(executionId: string): Promise<ProofBundle[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM hoplon_trace_proof_bundles WHERE execution_id = $1 ORDER BY created_at ASC',
        [executionId],
      );
      return result.rows.map(rowToProofBundle);
    } catch (cause) { wrapPgTraceRead(cause, 'listProofBundles failed'); }
  }

  async getViolation(violationId: string): Promise<ProofViolation | null> {
    try {
      const result = await this.pool.query('SELECT * FROM hoplon_trace_violations WHERE violation_id = $1', [violationId]);
      return result.rows[0] ? rowToViolation(result.rows[0]) : null;
    } catch (cause) { wrapPgTraceRead(cause, 'getViolation failed'); }
  }

  async listViolations(proofBundleRef: string): Promise<ProofViolation[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM hoplon_trace_violations WHERE proof_bundle_ref = $1 ORDER BY index_in_bundle ASC',
        [proofBundleRef],
      );
      return result.rows.map(rowToViolation);
    } catch (cause) { wrapPgTraceRead(cause, 'listViolations failed'); }
  }

  async appendDecisionProvenance(record: DecisionProvenance): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO hoplon_trace_provenance (
        provenance_id, execution_id, attempt_id, category, summary, detail, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provenance_id) DO NOTHING`, [
        record.provenanceId, record.executionId, record.attemptId, record.category,
        record.summary, record.detail != null ? JSON.stringify(record.detail) : null,
        record.createdAt,
      ]);
    } catch (cause) { wrapPgTraceWrite(cause, 'appendDecisionProvenance failed'); }
  }

  async listProvenance(executionId: string): Promise<DecisionProvenance[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM hoplon_trace_provenance WHERE execution_id = $1 ORDER BY created_at ASC',
        [executionId],
      );
      return result.rows.map(rowToProvenance);
    } catch (cause) { wrapPgTraceRead(cause, 'listProvenance failed'); }
  }

  async searchAttempts(filters: TraceSearchFilters): Promise<Attempt[]> {
    try {
      const { sql, params } = buildPgAttemptSearchQuery(filters);
      return (await this.pool.query(sql, params)).rows.map(rowToAttempt);
    } catch (cause) { wrapPgTraceRead(cause, 'searchAttempts failed'); }
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
