/**
 * contracts/compliance.ts — SOC2 evidence primitives.
 *
 * t-134 starts with audit-log integrity. The hash chain is adapter-owned:
 * callers append ordinary `AuditLogRecord` values and stores finalize the
 * chain metadata at write time. The metadata is H13-safe because it contains
 * only counters, algorithms, and hashes.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditLogRecord } from './auditLog.js';

export const AuditLogChainAlgorithmSchema = z.enum(['sha256']);
export type AuditLogChainAlgorithm = z.infer<typeof AuditLogChainAlgorithmSchema>;

export const AuditLogIntegrityRequestSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
}).strict();
export type AuditLogIntegrityRequest = z.infer<typeof AuditLogIntegrityRequestSchema>;

export const AuditLogIntegrityCheckpointSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  coveredUntil: z.string(),
  lastAuditSequence: z.number().int().positive(),
  terminalChainHash: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  createdAt: z.string(),
}).strict();
export type AuditLogIntegrityCheckpoint = z.infer<
  typeof AuditLogIntegrityCheckpointSchema
>;

export const AuditLogIntegrityFailureKindSchema = z.enum([
  'missing_chain_metadata',
  'unsupported_algorithm',
  'unsupported_version',
  'sequence_gap',
  'previous_hash_mismatch',
  'row_hash_mismatch',
  'chain_hash_mismatch',
]);
export type AuditLogIntegrityFailureKind = z.infer<
  typeof AuditLogIntegrityFailureKindSchema
>;

export const AuditLogIntegrityFailureSchema = z.object({
  kind: AuditLogIntegrityFailureKindSchema,
  recordId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  auditSequence: z.number().int().positive().nullable(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});
export type AuditLogIntegrityFailure = z.infer<
  typeof AuditLogIntegrityFailureSchema
>;

export const AuditLogIntegrityStatusSchema = z.enum(['PASS', 'FAIL', 'UNCHECKED']);
export type AuditLogIntegrityStatus = z.infer<typeof AuditLogIntegrityStatusSchema>;

export const AuditLogIntegrityResultSchema = z.object({
  status: AuditLogIntegrityStatusSchema,
  projectId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  checkedRows: z.number().int().nonnegative(),
  uncheckedRows: z.number().int().nonnegative(),
  failures: z.array(AuditLogIntegrityFailureSchema),
});
export type AuditLogIntegrityResult = z.infer<typeof AuditLogIntegrityResultSchema>;

export const AUDIT_LOG_CHAIN_VERSION = 1;
export const AUDIT_LOG_CHAIN_ALGORITHM: AuditLogChainAlgorithm = 'sha256';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function canonicalizeAuditLogValue(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function auditLogRowHash(record: AuditLogRecord): string {
  return sha256Hex(canonicalizeAuditLogValue(auditLogHashPayload(record)));
}

export function auditLogChainHash(
  previousChainHash: string | null,
  rowHash: string,
): string {
  return sha256Hex(canonicalizeAuditLogValue({
    algorithm: AUDIT_LOG_CHAIN_ALGORITHM,
    previousChainHash,
    rowHash,
    version: AUDIT_LOG_CHAIN_VERSION,
  }));
}

export function finalizeAuditLogChainRecord(
  record: AuditLogRecord,
  opts: {
    auditSequence: number;
    previousChainHash: string | null;
  },
): AuditLogRecord {
  const base: AuditLogRecord = {
    ...record,
    auditSequence: opts.auditSequence,
    previousChainHash: opts.previousChainHash,
    chainVersion: AUDIT_LOG_CHAIN_VERSION,
    chainAlgorithm: AUDIT_LOG_CHAIN_ALGORITHM,
    rowHash: null,
    chainHash: null,
  };
  const rowHash = auditLogRowHash(base);
  return {
    ...base,
    rowHash,
    chainHash: auditLogChainHash(opts.previousChainHash, rowHash),
  };
}

export function verifyAuditLogChain(
  rows: readonly AuditLogRecord[],
  request: AuditLogIntegrityRequest,
  checkpoints: readonly AuditLogIntegrityCheckpoint[] = [],
): AuditLogIntegrityResult {
  const failures: AuditLogIntegrityFailure[] = [];
  let checkedRows = 0;
  let uncheckedRows = 0;
  const sortedRows = [...rows].sort(compareAuditChainRows);
  const groups = new Map<string, AuditLogRecord[]>();
  for (const row of sortedRows) {
    const key = `${row.projectId}\u0000${row.runId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  for (const group of groups.values()) {
    const checkpoint = findCheckpointForGroup(group, checkpoints);
    let previousSequence = checkpoint?.lastAuditSequence ?? 0;
    let previousChainHash: string | null = checkpoint?.terminalChainHash ?? null;
    for (const row of group) {
      if (!hasChainMetadata(row)) {
        uncheckedRows += 1;
        failures.push(failure('missing_chain_metadata', row, null, null));
        continue;
      }
      checkedRows += 1;
      if (row.chainAlgorithm !== AUDIT_LOG_CHAIN_ALGORITHM) {
        failures.push(failure('unsupported_algorithm', row, AUDIT_LOG_CHAIN_ALGORITHM, row.chainAlgorithm));
      }
      if (row.chainVersion !== AUDIT_LOG_CHAIN_VERSION) {
        failures.push(failure('unsupported_version', row, String(AUDIT_LOG_CHAIN_VERSION), String(row.chainVersion)));
      }
      const expectedSequence = previousSequence + 1;
      if (row.auditSequence !== expectedSequence) {
        failures.push(failure('sequence_gap', row, String(expectedSequence), String(row.auditSequence)));
      }
      if (row.previousChainHash !== previousChainHash) {
        failures.push(failure('previous_hash_mismatch', row, previousChainHash, row.previousChainHash));
      }
      const expectedRowHash = auditLogRowHash({
        ...row,
        rowHash: null,
        chainHash: null,
      });
      if (row.rowHash !== expectedRowHash) {
        failures.push(failure('row_hash_mismatch', row, expectedRowHash, row.rowHash));
      }
      const expectedChainHash = auditLogChainHash(row.previousChainHash, expectedRowHash);
      if (row.chainHash !== expectedChainHash) {
        failures.push(failure('chain_hash_mismatch', row, expectedChainHash, row.chainHash));
      }
      previousSequence = row.auditSequence;
      previousChainHash = row.chainHash;
    }
  }

  return AuditLogIntegrityResultSchema.parse({
    status: failures.length > uncheckedRows ? 'FAIL' : uncheckedRows > 0 ? 'UNCHECKED' : 'PASS',
    projectId: request.projectId,
    runId: request.runId ?? null,
    checkedRows,
    uncheckedRows,
    failures,
  });
}

function findCheckpointForGroup(
  group: readonly AuditLogRecord[],
  checkpoints: readonly AuditLogIntegrityCheckpoint[],
): AuditLogIntegrityCheckpoint | null {
  const first = group[0];
  if (!first) return null;
  const firstSequence = first.auditSequence ?? Number.MAX_SAFE_INTEGER;
  const matches = checkpoints
    .filter((c) => c.projectId === first.projectId
      && c.runId === first.runId
      && c.lastAuditSequence < firstSequence)
    .sort((a, b) => b.lastAuditSequence - a.lastAuditSequence);
  return matches[0] ?? null;
}

function hasChainMetadata(row: AuditLogRecord): row is AuditLogRecord & {
  auditSequence: number;
  previousChainHash: string | null;
  rowHash: string;
  chainHash: string;
  chainVersion: number;
  chainAlgorithm: AuditLogChainAlgorithm;
} {
  return row.auditSequence != null
    && row.previousChainHash !== undefined
    && row.rowHash != null
    && row.chainHash != null
    && row.chainVersion != null
    && row.chainAlgorithm != null;
}

function auditLogHashPayload(record: AuditLogRecord): Record<string, unknown> {
  return {
    astNodeCount: record.astNodeCount ?? null,
    auditSequence: record.auditSequence ?? null,
    chainAlgorithm: record.chainAlgorithm ?? null,
    chainVersion: record.chainVersion ?? null,
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    durationMs: record.durationMs,
    engineId: record.engineId,
    fileLineCount: record.fileLineCount ?? null,
    id: record.id,
    manifestScopeRatio: record.manifestScopeRatio ?? null,
    operation: record.operation,
    policyEvent: record.policyEvent ?? null,
    previousChainHash: record.previousChainHash ?? null,
    proofAccessEvent: record.proofAccessEvent ?? null,
    projectId: record.projectId,
    result: record.result,
    runId: record.runId,
    snapshotId: record.snapshotId,
    violationCount: record.violationCount,
    violationKinds: record.violationKinds,
  };
}

function compareAuditChainRows(a: AuditLogRecord, b: AuditLogRecord): number {
  const byProject = a.projectId.localeCompare(b.projectId);
  if (byProject !== 0) return byProject;
  const byRun = a.runId.localeCompare(b.runId);
  if (byRun !== 0) return byRun;
  return (a.auditSequence ?? Number.MAX_SAFE_INTEGER)
    - (b.auditSequence ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function failure(
  kind: AuditLogIntegrityFailureKind,
  row: AuditLogRecord,
  expected: string | null,
  actual: string | null,
): AuditLogIntegrityFailure {
  return {
    kind,
    recordId: row.id,
    projectId: row.projectId,
    runId: row.runId,
    auditSequence: row.auditSequence ?? null,
    expected,
    actual,
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const next = input[key];
      output[key] = next === undefined ? null : sortJson(next);
    }
    return output;
  }
  return value;
}
