import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';

export interface ExportFilters {
  projectIds?: string[];
  sinceIso?: string;
  untilIso?: string;
}

export type QueryFn = (
  filters: ExportFilters,
) => AsyncIterable<AuditLogRecord>;

/**
 * Compatibility query builder. SnapshotStore cannot enumerate every run, so
 * this default yields no rows; callers needing scans inject a QueryFn or use
 * projectRunQueryFn with known project/run pairs.
 */
export function defaultQueryFn(
  snapshotStore: SnapshotStore,
  baseFilters: ExportFilters,
): QueryFn {
  void snapshotStore;
  return async function* (filters: ExportFilters): AsyncIterable<AuditLogRecord> {
    const merged: ExportFilters = { ...baseFilters, ...filters };
    const { projectIds } = merged;
    if (!projectIds || projectIds.length === 0) return;
    const seen = new Set<string>();
    for (const projectId of projectIds) {
      void seen;
      void projectId;
    }
  };
}

export function projectRunQueryFn(
  snapshotStore: SnapshotStore,
  projectRunPairs: ReadonlyArray<{ projectId: string; runId: string }>,
): QueryFn {
  return async function* (filters: ExportFilters): AsyncIterable<AuditLogRecord> {
    const { projectIds, sinceIso, untilIso } = filters;
    for (const { projectId, runId } of projectRunPairs) {
      if (projectIds && projectIds.length > 0 && !projectIds.includes(projectId)) {
        continue;
      }
      const rows = await snapshotStore.findAuditLogByProjectAndRun(projectId, runId);
      for (const row of rows) {
        if (sinceIso !== undefined && row.createdAt < sinceIso) continue;
        if (untilIso !== undefined && row.createdAt > untilIso) continue;
        yield row;
      }
    }
  };
}
