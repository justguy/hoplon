/**
 * transport/http/policyAuditPresent.ts — t-086 operator-visible
 * presentation of t-088 policy audit rows.
 *
 * Pure module. Takes one or more `AuditLogRecord` rows whose
 * `operation` is a `POLICY_*` value and projects them into a
 * `PolicyAuditOperatorSummary` shape that operators can render
 * directly. The presentation:
 *
 *   - keeps the typed reason code, requested action, canonical folder,
 *     principal id, resolved access, outcome, and ISO timestamp so an
 *     operator can diagnose grant / downgrade / deny / expiry / revoke.
 *   - drops `engagementId` (the server-private binding nonce — not a
 *     token, but still an internal correlation handle that operators
 *     do not need to see in human-facing summaries).
 *   - keeps `correlationId` and `runId` for cross-system tracing.
 *   - keeps `snapshotId` only when present.
 *   - never accepts non-policy rows; mixing legacy `AUDIT_DIFF` /
 *     `CREATE_SNAPSHOT` / `REVERT` rows into this presentation is a
 *     caller bug, so we filter them out instead of silently rendering
 *     a partial row.
 *
 * Lives in `transport/http/` because that's the layer where t-088
 * audit writers and the future t-089 retrieval surface compose. The
 * helper is reusable by HTTP, MCP, and CLI surfaces — none of them
 * need to understand the t-088 schema themselves.
 */
import type { AuditLogRecord } from '../../contracts/auditLog.js';
import type {
  PolicyAuditAccess,
  PolicyAuditAction,
  PolicyAuditReason,
} from '../../contracts/policyAudit.js';

/**
 * Operator-visible shape for one t-088 policy audit row. Field names
 * mirror `AuditLogRecord` / `PolicyAuditEvent` so operators can
 * cross-reference the schema, but the projection drops the binding
 * nonce and the wall-clock duration to keep the surface human-facing.
 */
export interface PolicyAuditOperatorSummary {
  id: string;
  createdAtIso: string;
  operation:
    | 'POLICY_HANDSHAKE'
    | 'POLICY_ACCESS_CHECK'
    | 'POLICY_RENEW'
    | 'POLICY_REVOKE';
  outcome: 'GRANTED' | 'DENIED' | 'REAUTH_REQUIRED' | 'REVOKED';
  reasonCode: PolicyAuditReason;
  requestedAction: PolicyAuditAction;
  /** Canonical project-relative folder, or null when none was resolved. */
  folder: string | null;
  /** Declared principal, or null for principal-agnostic requests. */
  principalId: string | null;
  /** Resolved access mode at decision time, or null. */
  resolvedAccess: PolicyAuditAccess | null;
  /** Stable cross-system trace handle. */
  correlationId: string;
  /** Run scope handle (per-request when no upstream runId is supplied). */
  runId: string;
  projectId: string;
  /** Snapshot the decision was bound to, or null. */
  snapshotId: string | null;
  /**
   * Free-form machine-diagnostic detail emitted by the t-088 mapper.
   * Operator-visible by design — it carries the canonical reason
   * sub-classification (e.g. invalid-folder reason). Never raw user
   * input bytes; the t-088 mapping helpers strip those at write time.
   */
  detail: string | null;
}

const POLICY_OPERATION_SET = new Set<AuditLogRecord['operation']>([
  'POLICY_HANDSHAKE',
  'POLICY_ACCESS_CHECK',
  'POLICY_RENEW',
  'POLICY_REVOKE',
]);

/**
 * Project one audit log row into the operator-visible summary. Returns
 * `null` for rows whose `operation` is not a `POLICY_*` value or that
 * lack a `policyEvent` payload (defensive — `AuditLogRecord` validation
 * already enforces this pairing, but the helper guards against
 * accidental misuse from a downstream caller).
 */
export function summarizePolicyAuditRow(
  row: AuditLogRecord,
): PolicyAuditOperatorSummary | null {
  if (!POLICY_OPERATION_SET.has(row.operation)) return null;
  const event = row.policyEvent;
  if (event == null) return null;
  return {
    id: row.id,
    createdAtIso: row.createdAt,
    operation: row.operation as PolicyAuditOperatorSummary['operation'],
    outcome: row.result as PolicyAuditOperatorSummary['outcome'],
    reasonCode: event.reasonCode,
    requestedAction: event.requestedAction,
    folder: event.folder,
    principalId: event.principalId,
    resolvedAccess: event.resolvedAccess,
    correlationId: row.correlationId,
    runId: row.runId,
    projectId: row.projectId,
    snapshotId: row.snapshotId,
    detail: event.detail,
  };
}

/**
 * Project a batch of audit log rows. Non-policy rows and rows missing
 * a `policyEvent` payload are silently dropped — this surface is for
 * presenting policy decisions only, never the legacy audit trail.
 */
export function summarizePolicyAuditRows(
  rows: readonly AuditLogRecord[],
): PolicyAuditOperatorSummary[] {
  const out: PolicyAuditOperatorSummary[] = [];
  for (const row of rows) {
    const projected = summarizePolicyAuditRow(row);
    if (projected !== null) out.push(projected);
  }
  return out;
}
