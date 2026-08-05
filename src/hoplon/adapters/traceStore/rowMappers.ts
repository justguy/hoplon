/**
 * adapters/traceStore/rowMappers.ts — snake_case row → camelCase record
 * helpers shared by the SQLite and Postgres TraceStore adapters (t-068).
 *
 * The row shape is the same for both engines (SQLite stores JSON as TEXT;
 * Postgres stores JSON as JSONB and returns already-parsed objects). The
 * parse helpers below handle both string and already-parsed inputs.
 */

import { AdapterError } from '../../contracts/errors.js';
import {
  ExecutionTraceSchema,
  type ExecutionTrace,
} from '../../contracts/executionTrace.js';
import { AttemptSchema, type Attempt } from '../../contracts/attempt.js';
import {
  ProofBundleSchema,
  ProofViolationSchema,
  type ProofBundle,
  type ProofViolation,
} from '../../contracts/proofBundle.js';
import {
  DecisionProvenanceSchema,
  type DecisionProvenance,
} from '../../contracts/decisionProvenance.js';

function parseJson(raw: unknown, field: string): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause,
      },
      `TraceStore: failed to parse ${field} JSON from database`,
    );
  }
}

function str(row: Record<string, unknown>, col: string): string {
  return String(row[col] ?? '');
}

function strOrNull(row: Record<string, unknown>, col: string): string | null {
  const v = row[col];
  return v == null ? null : String(v);
}

function numOrNull(row: Record<string, unknown>, col: string): number | null {
  const v = row[col];
  return v == null ? null : Number(v);
}

export function rowToExecution(row: Record<string, unknown>): ExecutionTrace {
  const record = {
    executionId: str(row, 'execution_id'),
    projectId: str(row, 'project_id'),
    runId: str(row, 'run_id'),
    engineId: str(row, 'engine_id'),
    correlationId: str(row, 'correlation_id'),
    planRef: strOrNull(row, 'plan_ref'),
    baselineSnapshotRef: strOrNull(row, 'baseline_snapshot_ref'),
    currentStatus: str(row, 'current_status'),
    origin: str(row, 'origin'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
  const parsed = ExecutionTraceSchema.safeParse(record);
  if (!parsed.success) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: parsed.error,
      },
      'TraceStore: assembled ExecutionTrace failed schema validation',
    );
  }
  return parsed.data;
}

export function rowToAttempt(row: Record<string, unknown>): Attempt {
  const record = {
    attemptId: str(row, 'attempt_id'),
    executionId: str(row, 'execution_id'),
    attemptNumber: Number(row['attempt_number'] ?? 0),
    contractRef: strOrNull(row, 'contract_ref'),
    basedOnSnapshotRef: str(row, 'based_on_snapshot_ref'),
    resultSnapshotRef: strOrNull(row, 'result_snapshot_ref'),
    auditRef: strOrNull(row, 'audit_ref'),
    proofBundleRef: str(row, 'proof_bundle_ref'),
    status: str(row, 'status'),
    actorType: str(row, 'actor_type'),
    actorRef: str(row, 'actor_ref'),
    repairPlanRef: strOrNull(row, 'repair_plan_ref'),
    startedAt: str(row, 'started_at'),
    completedAt: str(row, 'completed_at'),
  };
  const parsed = AttemptSchema.safeParse(record);
  if (!parsed.success) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: parsed.error,
      },
      'TraceStore: assembled Attempt failed schema validation',
    );
  }
  return parsed.data;
}

export function rowToProofBundle(row: Record<string, unknown>): ProofBundle {
  const violationRefs = parseJson(row['violation_refs'], 'violation_refs');
  const auditResult = parseJson(row['audit_result'], 'audit_result');
  const record = {
    proofBundleRef: str(row, 'proof_bundle_ref'),
    attemptId: str(row, 'attempt_id'),
    executionId: str(row, 'execution_id'),
    projectId: str(row, 'project_id'),
    runId: str(row, 'run_id'),
    snapshotRefBefore: str(row, 'snapshot_ref_before'),
    snapshotRefAfter: strOrNull(row, 'snapshot_ref_after'),
    auditRef: strOrNull(row, 'audit_ref'),
    violationRefs: Array.isArray(violationRefs) ? (violationRefs as string[]) : [],
    manifestRef: strOrNull(row, 'manifest_ref'),
    engineVersion: str(row, 'engine_version'),
    engineId: str(row, 'engine_id'),
    schemaVersion: Number(row['schema_version'] ?? 0),
    correlationId: str(row, 'correlation_id'),
    auditResult,
    createdAt: str(row, 'created_at'),
  };
  const parsed = ProofBundleSchema.safeParse(record);
  if (!parsed.success) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: parsed.error,
      },
      'TraceStore: assembled ProofBundle failed schema validation',
    );
  }
  return parsed.data;
}

export function rowToViolation(row: Record<string, unknown>): ProofViolation {
  const record = {
    violationId: str(row, 'violation_id'),
    proofBundleRef: str(row, 'proof_bundle_ref'),
    attemptId: str(row, 'attempt_id'),
    executionId: str(row, 'execution_id'),
    projectId: str(row, 'project_id'),
    runId: str(row, 'run_id'),
    kind: str(row, 'kind'),
    path: strOrNull(row, 'path'),
    symbolName: strOrNull(row, 'symbol_name'),
    nodeKind: strOrNull(row, 'node_kind'),
    byteRangeStart: numOrNull(row, 'byte_range_start'),
    byteRangeEnd: numOrNull(row, 'byte_range_end'),
    indexInBundle: Number(row['index_in_bundle'] ?? 0),
    createdAt: str(row, 'created_at'),
  };
  const parsed = ProofViolationSchema.safeParse(record);
  if (!parsed.success) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: parsed.error,
      },
      'TraceStore: assembled ProofViolation failed schema validation',
    );
  }
  return parsed.data;
}

export function rowToProvenance(row: Record<string, unknown>): DecisionProvenance {
  const detail = parseJson(row['detail'], 'detail');
  const record = {
    provenanceId: str(row, 'provenance_id'),
    executionId: str(row, 'execution_id'),
    attemptId: strOrNull(row, 'attempt_id'),
    category: str(row, 'category'),
    summary: str(row, 'summary'),
    detail: detail != null && typeof detail === 'object' ? (detail as Record<string, unknown>) : null,
    createdAt: str(row, 'created_at'),
  };
  const parsed = DecisionProvenanceSchema.safeParse(record);
  if (!parsed.success) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: parsed.error,
      },
      'TraceStore: assembled DecisionProvenance failed schema validation',
    );
  }
  return parsed.data;
}
