import type { SnapshotStore } from '../adapters/snapshotStore.js';
import {
  GcResultSchema,
  type GcRequest,
  type GcResult,
} from '../contracts/gc.js';
import type { SemanticSessionOverlayStore } from './semanticSessionOverlay.js';

export interface GcDeps {
  readonly snapshotStore: SnapshotStore;
  readonly sessionOverlayStore?: SemanticSessionOverlayStore;
}

export async function gc(deps: GcDeps, opts: GcRequest): Promise<GcResult> {
  const snapshotOpts = {
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    ...(opts.olderThan !== undefined ? { olderThan: opts.olderThan } : {}),
    ...(opts.expiredBefore !== undefined
      ? { expiredBefore: opts.expiredBefore }
      : {}),
  };
  const hasSnapshotFilter = Object.keys(snapshotOpts).length > 0;
  const hasSemanticFilter =
    opts.semanticCache === true ||
    opts.semanticOverlays === true ||
    opts.semanticTombstones === true;
  if (!hasSnapshotFilter && !hasSemanticFilter) {
    return deps.snapshotStore.gc(snapshotOpts);
  }

  const snapshotResult = hasSnapshotFilter
    ? await deps.snapshotStore.gc(snapshotOpts)
    : { deletedCount: 0 };
  const reasons: string[] = [];
  const result: GcResult = { deletedCount: snapshotResult.deletedCount };

  if (opts.semanticCache === true) {
    result.semanticCacheEntriesDeleted = 0;
    reasons.push('semantic_cache_maintenance_provider_not_bound');
  }
  if (opts.semanticOverlays === true) {
    result.semanticOverlaysReaped =
      deps.sessionOverlayStore?.gc().semanticOverlaysReaped ?? 0;
    if (deps.sessionOverlayStore === undefined) {
      reasons.push('semantic_overlay_store_not_bound');
    }
  }
  if (opts.semanticTombstones === true) {
    result.semanticTombstonesDeleted = 0;
    reasons.push('semantic_tombstone_maintenance_provider_not_bound');
  }
  if (reasons.length > 0) {
    result.degradationReasons = [...new Set(reasons)];
  }
  return GcResultSchema.parse(result);
}
