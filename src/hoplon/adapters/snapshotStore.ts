/**
 * adapters/snapshotStore.ts — SnapshotStore interface and SnapshotRecord Zod schema.
 *
 * put() is idempotent on id — if a record with the same id exists, it is a no-op.
 * This is correct because snapshot IDs are content-addressable (invariant H1).
 *
 * The schema mirrors the SQLite table columns defined in ARCHITECTURE.md.
 * status enables atomic two-phase writes (H10): pending → committed/failed.
 */

import { z } from 'zod';
import { WritableManifestSchema } from '../contracts/manifest.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type {
  AuditLogIntegrityRequest,
  AuditLogIntegrityResult,
} from '../contracts/compliance.js';
import type { PolicyAuditQueryRequest } from '../contracts/policyAuditQuery.js';

// ---------------------------------------------------------------------------
// SnapshotRecord — the shape stored in the SQLite table
// ---------------------------------------------------------------------------

export const SnapshotRecordSchema = z.object({
  /**
   * PRIMARY KEY — content-addressable snapshot ID.
   *
   * Phase 2 HA1: new IDs use the `sha256:<64-char-hex>` format (73 chars).
   * Phase 1 bare-hex IDs (exactly 64 lowercase hex chars) are still valid
   * for backward compatibility (H19). Both forms are accepted here and by
   * SnapshotStore.get(). See hashManifest.ts for the canonical producer.
   */
  id: z.string().regex(
    /^(?:sha256:[0-9a-f]{64}|[0-9a-f]{64})$/,
    'snapshot id must be either sha256:<64-hex> or a bare 64-char hex string',
  ),
  /** WritableManifest schema version (H8). Phase 1 = 1. */
  manifestSchemaVersion: z.number().int().positive(),
  /** Engine that created this snapshot (H5). */
  engineId: z.string().min(1),
  /** Project this snapshot belongs to (H14). */
  projectId: z.string().min(1),
  /** Run this snapshot belongs to — cross-run replay protection (H14, AS-2). */
  runId: z.string().min(1),
  /** Caller-supplied trace ID (H11). */
  correlationId: z.string().min(1),
  /** Atomic two-phase write state (H10). */
  status: z.enum(['pending', 'committed', 'failed']),
  /** Non-null when status = 'failed'. Null otherwise. */
  statusReason: z.string().nullable(),
  /** isomorphic-git commit SHA. Null until committed. */
  gitRef: z.string().nullable(),
  /**
   * The contracted writable scope.
   * Null when manifestStorageMode = 'hash_only' (Phase 4 privacy mode).
   * Phase 1 always inlines.
   */
  manifest: WritableManifestSchema.nullable(),
  /** ISO 8601 UTC. */
  createdAt: z.string().datetime({ offset: false }),
  /** Phase 2 GC expiry. null = keep forever. */
  ttlExpires: z.string().datetime({ offset: false }).nullable(),
  /** Phase 3 replication confirmation list. */
  replicaIds: z.array(z.string()),
  /**
   * mcr-008 presence evidence: paths-only listing of every workspace file
   * present at snapshot time (relative to fsRoot, gitRepoDir subtree
   * excluded), recorded through the fs adapter when the snapshot committed.
   * revertUncontracted probes its post-snapshot deletions against this list.
   * null / absent = evidence was not captured (snapshot predates mcr-008);
   * revert then fails safe and deletes nothing. Paths only — never content.
   */
  presencePaths: z.array(z.string()).nullable().optional(),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

// ---------------------------------------------------------------------------
// SnapshotStore interface
// ---------------------------------------------------------------------------

export interface SnapshotStore {
  /** Persist a snapshot record. Idempotent on id (INSERT OR IGNORE). */
  put(record: SnapshotRecord): Promise<void>;
  /** Retrieve a record by id. Returns null if not found. */
  get(id: string): Promise<SnapshotRecord | null>;
  /**
   * Return all records for a project+run combination, ordered by createdAt ascending.
   * Replaces findByProject — AS-2 requires run-scoped lookups.
   */
  findByProjectAndRun(projectId: string, runId: string): Promise<SnapshotRecord[]>;
  /**
   * Update the status (and optionally statusReason and gitRef) of a record.
   * Used for the two-phase write pattern (H10): pending → committed | failed.
   */
  updateStatus(
    id: string,
    status: 'committed' | 'failed',
    statusReason?: string,
    gitRef?: string,
  ): Promise<void>;
  /**
   * List all records in 'pending' status older than olderThanMs milliseconds.
   * Used by reconcile() to detect crash-orphaned records.
   */
  listPending(olderThanMs: number): Promise<SnapshotRecord[]>;
  /**
   * hcr-001 crash-recovery evidence: record the git commit SHA on a row that
   * is still 'pending', without changing its status or statusReason.
   * createSnapshot calls this immediately after the Phase B git commit
   * succeeds and before Phase C finalization, so a crash between B and C
   * leaves a pending row that carries its gitRef. reconcile() (when given a
   * versioning adapter) can then verify the ref and complete the orphan
   * instead of marking it failed.
   *
   * Optional — stores that omit it leave the ref null on pending rows and
   * such orphans are marked failed by reconcile() exactly as before.
   *
   * @throws {AdapterError} kind 'snapshot_store_write_failed' on adapter failure.
   */
  recordPendingGitRef?(id: string, gitRef: string): Promise<void>;
  /**
   * Delete records matching the filter. Used for right-to-erasure (H13 privacy)
   * and TTL-based GC (W3).
   *
   * Filters:
   *   - `projectId`     — delete only records for this project.
   *   - `olderThan`     — delete records where `created_at < olderThan` (ISO 8601).
   *   - `expiredBefore` — delete records where `ttl_expires IS NOT NULL AND ttl_expires < expiredBefore` (ISO 8601).
   *
   * Safety guard: at least one filter must be present to prevent accidental
   * full-table deletion. Throws `ValidationError({ kind: 'invalid_scope' })` if all
   * three are absent.
   *
   * Returns the count of deleted records.
   */
  gc(opts: {
    projectId?: string;
    olderThan?: string;
    /** W3 TTL GC: delete records whose ttl_expires is set and has passed. */
    expiredBefore?: string;
  }): Promise<{ deletedCount: number }>;

  // ---------------------------------------------------------------------------
  // DS1 — Distributed replica tracking (Phase 3 — H23)
  //
  // H23: `replica_ids` is the only distributed-state surface. Phase 1/2 adapters
  // may leave it empty. These methods are optional on the interface so that Phase
  // 1/2 adapter implementations do not need to implement them; they become
  // mandatory only for Phase 3 distributed adapters (PG1, RL1).
  // ---------------------------------------------------------------------------

  /**
   * Return all snapshot records that list `replicaId` in their `replica_ids`
   * column, ordered by `createdAt` ascending.
   *
   * Optional — Phase 1/2 in-process adapters may omit this method.
   * Required for Phase 3 distributed adapters (PG1).
   *
   * H23: `replica_ids` is the only distributed-state surface.
   *
   * @throws {AdapterError} kind 'snapshot_store_read_failed' on adapter failure.
   */
  listByReplica?(replicaId: string): Promise<SnapshotRecord[]>;

  /**
   * Overwrite the `replica_ids` array for the snapshot identified by `id`.
   *
   * Optional — Phase 1/2 in-process adapters may omit this method.
   * Required for Phase 3 distributed adapters (PG1).
   *
   * H23: `replica_ids` is the only distributed-state surface.
   * Callers must supply a non-empty array; pass `[]` to clear all replica
   * confirmations (e.g., on snapshot deletion pre-flight).
   *
   * @throws {AdapterError} kind 'snapshot_store_write_failed' on adapter failure.
   */
  setReplicaIds?(id: string, replicaIds: string[]): Promise<void>;

  // ---------------------------------------------------------------------------
  // Audit log methods (AL1 — Phase 1.5)
  // H18 enforcement: NO update method exists on this interface for audit log rows.
  // Only INSERT (via appendAuditLog) and DELETE (via gcAuditLog) are allowed.
  // ---------------------------------------------------------------------------

  /**
   * Append an audit log record to hoplon_audit_log.
   *
   * **Append-only — H18.** No update path exists. Idempotent on `id` via
   * INSERT OR IGNORE: if a record with the same UUID already exists, the call
   * is a no-op (no error thrown). This makes the method safe to retry after a
   * transient store failure.
   *
   * H13 enforcement: the `violationKinds` field on the record MUST contain only
   * closed-union kind strings. Callers are responsible for mapping violations
   * to kinds only (see auditDiff integration for reference).
   *
   * @throws {AdapterError} kind 'snapshot_store_write_failed' on adapter failure.
   */
  appendAuditLog(record: AuditLogRecord): Promise<void>;

  /**
   * Retrieve all audit log entries for a given project+run combination,
   * ordered by `createdAt` ascending (oldest first).
   *
   * Returns an empty array if no entries match.
   *
   * @throws {AdapterError} kind 'snapshot_store_read_failed' on adapter failure.
   */
  findAuditLogByProjectAndRun(projectId: string, runId: string): Promise<AuditLogRecord[]>;

  /**
   * Delete audit log rows matching the given filters.
   *
   * Safety guard: if BOTH `projectId` and `olderThan` are omitted (or undefined),
   * throws `ValidationError({ kind: 'invalid_scope' })` to prevent accidental
   * whole-table deletion. At least one filter must be provided.
   *
   * @param opts.projectId  - Delete only rows for this project.
   * @param opts.olderThan  - Delete only rows with `createdAt < olderThan` (ISO 8601).
   * @returns `{ deletedCount }` — number of rows deleted.
   * @throws {ValidationError} kind 'invalid_scope' when both filters are absent.
   * @throws {AdapterError}    kind 'snapshot_store_write_failed' on adapter failure.
   */
  gcAuditLog(opts: { projectId?: string; olderThan?: string }): Promise<{ deletedCount: number }>;

  /**
   * t-089 — bounded read-only retrieval of policy audit rows.
   *
   * Returns at most `request.limit` `AuditLogRecord` rows whose
   * `operation` is one of the `POLICY_*` values, scoped to
   * `request.projectId` and narrowed by the optional folder /
   * principal / outcome / reasonCode / since / until filters.
   *
   * The principal filter is discriminated:
   *   - `kind:'any'`   → no principal narrowing.
   *   - `kind:'none'`  → only rows whose `policyEvent.principalId IS NULL`.
   *   - `kind:'exact'` → only rows whose `policyEvent.principalId` equals
   *                      the supplied id.
   *
   * Adapters MUST return rows in `createdAt DESC, id DESC` order so
   * callers can rely on deterministic time-window paging.
   *
   * This method MUST NOT participate in any access-control decision.
   * It is evidence retrieval only — by construction it can only read,
   * never widen, the policy gate.
   *
   * @throws {AdapterError} kind 'snapshot_store_read_failed' on adapter failure.
   */
  findPolicyAuditEntries(
    request: PolicyAuditQueryRequest,
  ): Promise<AuditLogRecord[]>;

  /**
   * t-134 — Verify the adapter-owned hash chain over hoplon_audit_log.
   *
   * This is read-only evidence generation. It must not write rows, mutate chain
   * metadata, or participate in PASS/BLOCK semantics. Pre-chain rows are not
   * silently trusted: implementations return UNCHECKED when matching rows lack
   * chain metadata.
   */
  verifyAuditLogIntegrity(
    request: AuditLogIntegrityRequest,
  ): Promise<AuditLogIntegrityResult>;
}
