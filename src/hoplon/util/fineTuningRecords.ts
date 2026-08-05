import { z } from 'zod';
import type { AuditLogRecord } from '../contracts/auditLog.js';

export const FineTuningRecordSchema = z.object({
  audit_id: z.string().uuid(),
  snapshot_id: z.string().nullable(),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  operation: z.enum(['createSnapshot', 'auditDiff', 'revertUncontracted']),
  result: z.enum(['PASS', 'BLOCK']),
  violation_kinds: z.array(z.string()),
  violation_count: z.number().int().nonnegative(),
  ast_node_count: z.number().int().nonnegative().nullable(),
  file_line_count: z.number().int().nonnegative().nullable(),
  manifest_scope_ratio: z.number().min(0).max(1).nullable(),
  duration_ms: z.number().int().nonnegative(),
  created_at: z.string(),
  manifest_schema_version: z.union([z.literal(1), z.literal(2)]),
});

export type FineTuningRecord = z.infer<typeof FineTuningRecordSchema>;

const OPERATION_MAP: Record<
  string,
  FineTuningRecord['operation'] | undefined
> = {
  CREATE_SNAPSHOT: 'createSnapshot',
  AUDIT_DIFF: 'auditDiff',
  REVERT: 'revertUncontracted',
};

export function toFineTuningRecord(
  row: AuditLogRecord,
): FineTuningRecord | null {
  if (row.result === 'ERROR') return null;
  const operation = OPERATION_MAP[row.operation];
  if (!operation) return null;
  const manifestSchemaVersion: 1 | 2 = 1;
  return {
    audit_id: row.id,
    snapshot_id: row.snapshotId,
    project_id: row.projectId,
    run_id: row.runId,
    operation,
    result: row.result as 'PASS' | 'BLOCK',
    violation_kinds: row.violationKinds,
    violation_count: row.violationCount,
    ast_node_count: row.astNodeCount ?? null,
    file_line_count: row.fileLineCount ?? null,
    manifest_scope_ratio: row.manifestScopeRatio ?? null,
    duration_ms: row.durationMs,
    created_at: row.createdAt,
    manifest_schema_version: manifestSchemaVersion,
  };
}
