/**
 * Session-scoped staging store runtime and public compatibility facade.
 */
import type { StagedContentRef } from '../contracts/requests.js';
import { SessionError } from './errors.js';
import {
  STAGE_MAX_AGGREGATE_BYTES,
  STAGE_MAX_CHUNK_BYTES,
  STAGE_MAX_ENTRIES_PER_SESSION,
  STAGE_MAX_TOTAL_BYTES,
  type SessionStagingOptions,
  type SessionStagingStore,
  type StageContentInput,
  type StageContentResult,
  type StagingEntryInspection,
} from './stagingContracts.js';
import { createStagingAggregateBudget } from './stagingBudget.js';
import {
  assertPositiveSafeInteger,
  bytesOfEntry,
  invalidStagingConfiguration,
  validatedLimit,
  type StagingEntry,
} from './stagingInternals.js';
import { stageContent } from './stagingStage.js';

export * from './stagingContracts.js';
export { createStagingAggregateBudget } from './stagingBudget.js';

export function createSessionStagingStore(
  opts?: SessionStagingOptions,
): SessionStagingStore {
  const entries = new Map<string, StagingEntry>();
  const maxChunkBytes = validatedLimit(
    'maxChunkBytes',
    opts?.maxChunkBytes,
    STAGE_MAX_CHUNK_BYTES,
  );
  const maxEntryBytes = validatedLimit(
    'maxEntryBytes',
    opts?.maxEntryBytes,
    STAGE_MAX_TOTAL_BYTES,
  );
  const maxEntriesPerSession = validatedLimit(
    'maxEntriesPerSession',
    opts?.maxEntriesPerSession,
    STAGE_MAX_ENTRIES_PER_SESSION,
  );
  if (
    opts?.aggregateBudget !== undefined &&
    opts.maxAggregateBytes !== undefined &&
    opts.aggregateBudget.maxTotalBytes !== opts.maxAggregateBytes
  ) {
    throw invalidStagingConfiguration(
      'aggregateBudget.maxTotalBytes and maxAggregateBytes must match when both are supplied',
      'aggregateBudget',
    );
  }
  const budget =
    opts?.aggregateBudget ??
    createStagingAggregateBudget(
      opts?.maxAggregateBytes ?? STAGE_MAX_AGGREGATE_BYTES,
    );
  assertPositiveSafeInteger('aggregateBudget.maxTotalBytes', budget.maxTotalBytes);

  /**
   * Reserve one committed chunk against the aggregate budget. Called only
   * after every other validation passed, immediately before the chunk is
   * committed to the entry, so a typed rejection never leaks a reservation.
   */
  function reserveAggregate(bytes: number, fromState: string): void {
    if (budget.tryReserve(bytes)) return;
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: `staging ${bytes} more bytes exceeds the aggregate cross-session ceiling (${budget.maxTotalBytes} bytes; ${budget.usedBytes()} in use)`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'aggregateStagedBytes',
      },
    });
  }

  /** Drop one entry and return its bytes to the aggregate budget. */
  function dropEntry(stagingKey: string): void {
    const entry = entries.get(stagingKey);
    if (!entry) return;
    entries.delete(stagingKey);
    budget.release(entry.bytesStaged);
  }

  function stage(input: StageContentInput, fromState: string): StageContentResult {
    return stageContent(
      {
        entries,
        maxChunkBytes,
        maxEntriesPerSession,
        maxEntryBytes,
        reserveAggregate,
      },
      input,
      fromState,
    );
  }

  function read(
    ref: StagedContentRef,
    fromState: string,
    changeIndex: number,
    attempted = 'applyEdits',
  ): Uint8Array {
    const entry = entries.get(ref.stagingKey);
    if (!entry) {
      throw new SessionError({
        kind: 'missing_prerequisite',
        from: fromState,
        attempted,
        detail: `stagingKey "${ref.stagingKey}" not found for this session`,
        details: {
          recoveryClass: 'check_prerequisites',
          prerequisite: 'stagedContent',
          failedChangeIndex: changeIndex,
        },
      });
    }
    if (!entry.complete) {
      throw new SessionError({
        kind: 'missing_prerequisite',
        from: fromState,
        attempted,
        detail: `stagingKey "${ref.stagingKey}" has not been finalized (call stageContent with isFinal=true first)`,
        details: {
          recoveryClass: 'check_prerequisites',
          prerequisite: 'stagedContent.complete',
          failedChangeIndex: changeIndex,
        },
      });
    }
    if (
      entry.expectedTotalByteLength !== ref.expectedByteLength ||
      entry.sha256 !== ref.expectedSha256
    ) {
      throw new SessionError({
        kind: 'stage_integrity_mismatch',
        from: fromState,
        attempted,
        detail: `staged body for "${ref.stagingKey}" does not match referenced expectedSha256/expectedByteLength`,
        details: {
          recoveryClass: 'refresh_and_recompute',
          prerequisite: 'stagedContent.integrity',
          failedChangeIndex: changeIndex,
        },
      });
    }
    return bytesOfEntry(entry);
  }

  function consume(
    ref: StagedContentRef,
    fromState: string,
    changeIndex: number,
    attempted = 'applyEdits',
  ): Uint8Array {
    const bytes = read(ref, fromState, changeIndex, attempted);
    dropEntry(ref.stagingKey);
    return bytes;
  }

  function discard(stagingKey: string): void {
    dropEntry(stagingKey);
  }

  function inspect(): readonly StagingEntryInspection[] {
    return Array.from(entries.values())
      .map((e) => ({
        stagingKey: e.stagingKey,
        chunks: e.chunks.length,
        bytesStaged: e.bytesStaged,
        complete: e.complete,
      }))
      .sort((a, b) => a.stagingKey.localeCompare(b.stagingKey));
  }

  function dispose(): void {
    for (const entry of entries.values()) {
      budget.release(entry.bytesStaged);
    }
    entries.clear();
  }

  return { stage, read, consume, discard, inspect, dispose };
}
