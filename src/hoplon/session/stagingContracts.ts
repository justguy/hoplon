import type { StagedContentRef } from '../contracts/requests.js';

export const STAGE_MAX_CHUNK_BYTES = 5 * 1024 * 1024;
/** Hard per-entry raw-byte ceiling (64 MiB) — one staged content body. */
export const STAGE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Hard per-session open-entry ceiling. */
export const STAGE_MAX_ENTRIES_PER_SESSION = 64;
/**
 * Hard aggregate staged-byte ceiling across ALL sessions in this process
 * (hcr-005). The per-session caps above bound one session at
 * `STAGE_MAX_ENTRIES_PER_SESSION * STAGE_MAX_TOTAL_BYTES` (4 GiB) but
 * previously left the process total unbounded across sessions. The default
 * aggregate equals exactly one maxed-out session, so a single session
 * hitting its own per-entry/per-session limits is never rejected earlier
 * than before; concurrent sessions now share this pool.
 */
export const STAGE_MAX_AGGREGATE_BYTES =
  STAGE_MAX_ENTRIES_PER_SESSION * STAGE_MAX_TOTAL_BYTES;

/**
 * Mandatory cross-session accounting for staged bytes (hcr-005). Every
 * staging store draws on one budget: committed chunk bytes reserve, and
 * discard/consume/dispose release exactly what their entries held.
 */
export interface StagingAggregateBudget {
  readonly maxTotalBytes: number;
  /** Bytes currently reserved across every store sharing this budget. */
  usedBytes(): number;
  /** Reserve `bytes`; returns false when the ceiling would be exceeded. */
  tryReserve(bytes: number): boolean;
  /** Return a prior reservation. */
  release(bytes: number): void;
}

/**
 * Optional staging ceilings for one session. Omitting a field preserves the
 * shipped constant for that concern. `maxAggregateBytes` creates a budget for
 * direct session construction; registries materialize it once and share that
 * budget across every session they start. Advanced hosts may instead inject an
 * already-shared `aggregateBudget`.
 */
export interface SessionStagingOptions {
  maxChunkBytes?: number;
  maxEntryBytes?: number;
  maxEntriesPerSession?: number;
  maxAggregateBytes?: number;
  aggregateBudget?: StagingAggregateBudget;
}

export interface StageContentInput {
  stagingKey: string;
  /** 0-based chunk index; must match `entry.chunks.length` exactly. */
  seq: number;
  /** Raw chunk bytes. Pre-decoded from base64 by the transport adapter. */
  chunkBytes: Uint8Array;
  /** True on the last chunk; finalization verifies sha256 + byteLength. */
  isFinal: boolean;
  /** Required when `isFinal === true`; hex lowercase sha256 of the full body. */
  expectedTotalSha256?: string;
  /** Required when `isFinal === true`; finalized byte length. */
  expectedTotalByteLength?: number;
}

export interface StageContentResult {
  stagingKey: string;
  chunks: number;
  bytesStaged: number;
  complete: boolean;
  sha256: string | null;
}

export interface StagingEntryInspection {
  stagingKey: string;
  chunks: number;
  bytesStaged: number;
  complete: boolean;
}

export interface SessionStagingStore {
  /** Append one chunk, optionally finalizing the entry. */
  stage(input: StageContentInput, fromState: string): StageContentResult;
  /**
   * Return the finalized bytes for `stagingKey` without consuming the entry.
   * Used by read-only consumers such as dryRun/review preview and by
   * applyEdits before the write actually succeeds.
   */
  read(
    ref: StagedContentRef,
    fromState: string,
    changeIndex: number,
    attempted?: string,
  ): Uint8Array;
  /**
   * Return the finalized bytes for `stagingKey` and consume the entry.
   * Throws typed `SessionError` when the entry is missing, incomplete, or
   * integrity-mismatched against the caller's expectations.
   */
  consume(
    ref: StagedContentRef,
    fromState: string,
    changeIndex: number,
    attempted?: string,
  ): Uint8Array;
  /** Discard one staged entry after a successful apply. Idempotent. */
  discard(stagingKey: string): void;
  /** Non-consuming inspector for tests + transport observability. */
  inspect(): readonly StagingEntryInspection[];
  /** Drop every entry (called on `session.close`). Idempotent. */
  dispose(): void;
}
