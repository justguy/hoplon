import type {
  SemanticCorpusDocument,
  SemanticDegradationReason,
  SemanticSearchStatus,
} from '../contracts/semanticSearch.js';

const DEFAULT_OVERLAY_TTL_MS = 60 * 60 * 1000;

export interface SemanticOverlayDocument extends SemanticCorpusDocument {
  readonly vector?: readonly number[];
}

export interface SemanticSessionOverlay {
  readonly projectId: string;
  readonly sessionId: string;
  readonly worktreeId?: string;
  readonly generation: number;
  readonly status: SemanticSearchStatus;
  readonly degradationReasons: readonly SemanticDegradationReason[];
  readonly documents: readonly SemanticOverlayDocument[];
  readonly maskedPaths: readonly string[];
}

export interface SemanticSessionOverlayStore {
  reserve(projectId: string, sessionId: string, worktreeId?: string): number;
  publish(overlay: SemanticSessionOverlay): boolean;
  get(projectId: string, sessionId: string, worktreeId?: string): SemanticSessionOverlay | null;
  clear(projectId: string, sessionId: string, worktreeId?: string): boolean;
  stats(): SemanticSessionOverlayStoreStats;
  gc(): SemanticSessionOverlayGcResult;
  reapReason(
    projectId: string,
    sessionId: string,
    worktreeId?: string,
  ): SemanticDegradationReason | null;
}

export interface SemanticSessionOverlayStoreStats {
  readonly activeOverlayCount: number;
  readonly reapedOverlayCount: number;
  readonly documentCount: number;
  readonly vectorCount: number;
  readonly maskCount: number;
}

export interface SemanticSessionOverlayGcResult {
  readonly semanticOverlaysReaped: number;
}

export interface SemanticSessionOverlayStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface OverlaySlot {
  pendingGeneration: number;
  overlay: SemanticSessionOverlay | null;
  lastActiveAtMs: number;
  reapedReason: SemanticDegradationReason | null;
}

export function createInMemorySemanticSessionOverlayStore(
  opts: SemanticSessionOverlayStoreOptions = {},
): SemanticSessionOverlayStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_OVERLAY_TTL_MS;
  const slots = new Map<string, OverlaySlot>();
  return {
    reserve(projectId, sessionId, worktreeId) {
      const key = overlayKey(projectId, sessionId, worktreeId);
      const slot = slots.get(key) ?? {
        pendingGeneration: 0,
        overlay: null,
        lastActiveAtMs: now(),
        reapedReason: null,
      };
      const nextGeneration = slot.pendingGeneration + 1;
      slots.set(key, { ...slot, pendingGeneration: nextGeneration });
      return nextGeneration;
    },
    publish(overlay) {
      const key = overlayKey(overlay.projectId, overlay.sessionId, overlay.worktreeId);
      const slot = slots.get(key);
      if (slot === undefined || slot.pendingGeneration !== overlay.generation) {
        return false;
      }
      slots.set(key, {
        pendingGeneration: overlay.generation,
        overlay,
        lastActiveAtMs: now(),
        reapedReason: null,
      });
      return true;
    },
    get(projectId, sessionId, worktreeId) {
      const key = overlayKey(projectId, sessionId, worktreeId);
      const slot = reapExpired(slots.get(key), ttlMs, now());
      if (slot === undefined) return null;
      slots.set(key, slot);
      return slot.overlay;
    },
    clear(projectId, sessionId, worktreeId) {
      return slots.delete(overlayKey(projectId, sessionId, worktreeId));
    },
    stats() {
      return overlayStats(slots);
    },
    gc() {
      let semanticOverlaysReaped = 0;
      for (const [key, slot] of slots) {
        const next = reapExpired(slot, ttlMs, now());
        if (next === undefined) continue;
        if (next.overlay === null && next.reapedReason !== null) {
          slots.delete(key);
          semanticOverlaysReaped += 1;
          continue;
        }
        slots.set(key, next);
      }
      return { semanticOverlaysReaped };
    },
    reapReason(projectId, sessionId, worktreeId) {
      const key = overlayKey(projectId, sessionId, worktreeId);
      const slot = reapExpired(slots.get(key), ttlMs, now());
      if (slot === undefined) return null;
      slots.set(key, slot);
      return slot.reapedReason;
    },
  };
}

function overlayStats(
  slots: ReadonlyMap<string, OverlaySlot>,
): SemanticSessionOverlayStoreStats {
  const stats = {
    activeOverlayCount: 0,
    reapedOverlayCount: 0,
    documentCount: 0,
    vectorCount: 0,
    maskCount: 0,
  };
  for (const slot of slots.values()) {
    if (slot.overlay === null) {
      if (slot.reapedReason !== null) stats.reapedOverlayCount += 1;
      continue;
    }
    stats.activeOverlayCount += 1;
    stats.documentCount += slot.overlay.documents.length;
    stats.vectorCount += slot.overlay.documents.filter(
      (doc) => doc.vector !== undefined,
    ).length;
    stats.maskCount += slot.overlay.maskedPaths.length;
  }
  return stats;
}

function overlayKey(projectId: string, sessionId: string, worktreeId?: string): string {
  return `${projectId}\0${worktreeId ?? ''}\0${sessionId}`;
}

function reapExpired(
  slot: OverlaySlot | undefined,
  ttlMs: number,
  nowMs: number,
): OverlaySlot | undefined {
  if (slot === undefined || slot.overlay === null) return slot;
  if (nowMs - slot.lastActiveAtMs <= ttlMs) return slot;
  return {
    pendingGeneration: slot.pendingGeneration,
    overlay: null,
    lastActiveAtMs: slot.lastActiveAtMs,
    reapedReason: 'overlay_reaped_inactive_ttl',
  };
}
