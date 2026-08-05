/**
 * tests/session/stagingAggregate.test.ts — hcr-005 GAP fix: aggregate
 * cross-session staging ceiling.
 *
 * The per-session caps (64 entries x 64 MiB) previously left total staged
 * memory unbounded across sessions. The fix adds a mandatory aggregate byte
 * budget shared by every staging store: exceeding it is a typed rejection
 * (`stage_integrity_mismatch`, prerequisite `aggregateStagedBytes`) and every
 * discard/consume/dispose releases its reservation exactly.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { SessionError } from '../../src/hoplon/session/errors.js';
import {
  createSessionStagingStore,
  createStagingAggregateBudget,
  STAGE_MAX_AGGREGATE_BYTES,
  STAGE_MAX_ENTRIES_PER_SESSION,
  STAGE_MAX_TOTAL_BYTES,
} from '../../src/hoplon/session/stagingStore.js';
import { createRegistryStagingOptions } from '../../src/hoplon/session/registryStaging.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function finalChunk(stagingKey: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stagingKey,
    seq: 0,
    chunkBytes: bytes,
    isFinal: true,
    expectedTotalSha256: sha256(bytes),
    expectedTotalByteLength: bytes.byteLength,
  };
}

function expectSessionError(fn: () => void): SessionError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    return err as SessionError;
  }
  throw new Error('expected SessionError');
}

describe('aggregate staging budget (hcr-005 staging-bounds gap)', () => {
  it('registries materialize one default-size budget even when staging options are omitted', () => {
    const firstRegistryStaging = createRegistryStagingOptions(undefined);
    const secondRegistryStaging = createRegistryStagingOptions(undefined);

    expect(firstRegistryStaging.aggregateBudget?.maxTotalBytes).toBe(
      STAGE_MAX_AGGREGATE_BYTES,
    );
    expect(firstRegistryStaging.aggregateBudget).not.toBe(
      secondRegistryStaging.aggregateBudget,
    );
  });

  it('REGRESSION: staging beyond the shared aggregate ceiling is rejected with a typed outcome', () => {
    const budget = createStagingAggregateBudget(16);
    const storeA = createSessionStagingStore({ aggregateBudget: budget });
    const storeB = createSessionStagingStore({ aggregateBudget: budget });

    // Session A stages 10 bytes — within both per-session and aggregate caps.
    const staged = storeA.stage(finalChunk('a-1', '0123456789'), 'snapshotted');
    expect(staged.complete).toBe(true);
    expect(budget.usedBytes()).toBe(10);

    // Session B staging 10 more would exceed the 16-byte aggregate ceiling.
    const err = expectSessionError(() =>
      storeB.stage(finalChunk('b-1', '0123456789'), 'snapshotted'),
    );
    expect(err.kind).toBe('stage_integrity_mismatch');
    expect(err.details?.recoveryClass).toBe('refresh_and_recompute');
    expect(err.details?.prerequisite).toBe('aggregateStagedBytes');
    expect(storeB.inspect()).toEqual([]);
    expect(budget.usedBytes()).toBe(10);
  });

  it('discard, consume, and dispose release their aggregate reservation exactly', () => {
    const budget = createStagingAggregateBudget(16);
    const storeA = createSessionStagingStore({ aggregateBudget: budget });
    const storeB = createSessionStagingStore({ aggregateBudget: budget });

    storeA.stage(finalChunk('a-1', '0123456789'), 'snapshotted');
    expect(budget.usedBytes()).toBe(10);

    // discard() releases — the other session can now stage.
    storeA.discard('a-1');
    expect(budget.usedBytes()).toBe(0);
    storeB.stage(finalChunk('b-1', '0123456789'), 'snapshotted');
    expect(budget.usedBytes()).toBe(10);

    // consume() releases.
    const bytes = new TextEncoder().encode('0123456789');
    storeB.consume(
      { stagingKey: 'b-1', expectedSha256: sha256(bytes), expectedByteLength: 10 },
      'snapshotted',
      0,
    );
    expect(budget.usedBytes()).toBe(0);

    // dispose() releases every remaining entry (including unfinalized ones).
    storeA.stage(
      { stagingKey: 'a-2', seq: 0, chunkBytes: new Uint8Array(6), isFinal: false },
      'snapshotted',
    );
    expect(budget.usedBytes()).toBe(6);
    storeA.dispose();
    expect(budget.usedBytes()).toBe(0);
  });

  it('rejected chunks and failed finalization never leak reservation', () => {
    const budget = createStagingAggregateBudget(100);
    const store = createSessionStagingStore({ aggregateBudget: budget });

    store.stage(
      { stagingKey: 'k', seq: 0, chunkBytes: new Uint8Array(10), isFinal: false },
      'snapshotted',
    );
    expect(budget.usedBytes()).toBe(10);

    // Finalization integrity failure throws before the chunk commits.
    expectSessionError(() =>
      store.stage(
        {
          stagingKey: 'k',
          seq: 1,
          chunkBytes: new TextEncoder().encode('hello'),
          isFinal: true,
          expectedTotalSha256: 'f'.repeat(64),
          expectedTotalByteLength: 15,
        },
        'snapshotted',
      ),
    );
    expect(budget.usedBytes()).toBe(10);

    // Out-of-order seq rejection does not reserve either.
    expectSessionError(() =>
      store.stage(
        { stagingKey: 'k', seq: 5, chunkBytes: new Uint8Array(4), isFinal: false },
        'snapshotted',
      ),
    );
    expect(budget.usedBytes()).toBe(10);
  });

  it('default ceiling equals one full session (per-session limits keep working unchanged)', () => {
    // A single session maxing out its own caps (64 entries x 64 MiB) exactly
    // reaches — never exceeds — the default aggregate ceiling.
    expect(STAGE_MAX_AGGREGATE_BYTES).toBe(
      STAGE_MAX_ENTRIES_PER_SESSION * STAGE_MAX_TOTAL_BYTES,
    );
  });

  it('direct stores create independent aggregate budgets unless a host injects one', () => {
    const storeA = createSessionStagingStore({ maxAggregateBytes: 3 });
    const storeB = createSessionStagingStore({ maxAggregateBytes: 3 });

    storeA.stage(finalChunk('direct-a', 'abc'), 'snapshotted');
    expect(() =>
      storeB.stage(finalChunk('direct-b', 'def'), 'snapshotted'),
    ).not.toThrow();

    storeA.dispose();
    storeB.dispose();
  });

  it('enforces caller-configured chunk, entry, and entry-count ceilings with typed failures', () => {
    const chunkStore = createSessionStagingStore({
      maxChunkBytes: 3,
      aggregateBudget: createStagingAggregateBudget(100),
    });
    const chunkError = expectSessionError(() =>
      chunkStore.stage(
        {
          stagingKey: 'chunk',
          seq: 0,
          chunkBytes: new Uint8Array(4),
          isFinal: false,
        },
        'created',
      ),
    );
    expect(chunkError.details?.prerequisite).toBe('chunkSize');

    const entryStore = createSessionStagingStore({
      maxEntryBytes: 5,
      maxEntriesPerSession: 1,
      aggregateBudget: createStagingAggregateBudget(100),
    });
    entryStore.stage(
      {
        stagingKey: 'entry-a',
        seq: 0,
        chunkBytes: new Uint8Array(4),
        isFinal: false,
      },
      'created',
    );
    const bytesError = expectSessionError(() =>
      entryStore.stage(
        {
          stagingKey: 'entry-a',
          seq: 1,
          chunkBytes: new Uint8Array(2),
          isFinal: false,
        },
        'created',
      ),
    );
    expect(bytesError.details?.prerequisite).toBe('totalBytes');
    const countError = expectSessionError(() =>
      entryStore.stage(
        {
          stagingKey: 'entry-b',
          seq: 0,
          chunkBytes: new Uint8Array(1),
          isFinal: false,
        },
        'created',
      ),
    );
    expect(countError.details?.prerequisite).toBe('entryCount');
    entryStore.dispose();
  });

  it('rejects invalid configured ceilings before staging with a typed SessionError', () => {
    for (const options of [
      { maxChunkBytes: 0 },
      { maxEntryBytes: -1 },
      { maxEntriesPerSession: 1.5 },
      { maxAggregateBytes: Number.NaN },
    ]) {
      const error = expectSessionError(() =>
        createSessionStagingStore(options),
      );
      expect(error.attempted).toBe('configureStaging');
      expect(error.details?.recoveryClass).toBe('refresh_and_recompute');
    }
    const mismatch = expectSessionError(() =>
      createSessionStagingStore({
        maxAggregateBytes: 9,
        aggregateBudget: createStagingAggregateBudget(10),
      }),
    );
    expect(mismatch.details?.prerequisite).toBe('aggregateBudget');
  });

  it('does not let invalid aggregate-budget calls mint capacity', () => {
    const budget = createStagingAggregateBudget(10);
    expect(budget.tryReserve(-1)).toBe(false);
    expect(budget.tryReserve(Number.NaN)).toBe(false);
    expect(budget.usedBytes()).toBe(0);

    expect(budget.tryReserve(8)).toBe(true);
    budget.release(-5);
    budget.release(Number.NaN);
    expect(budget.usedBytes()).toBe(8);
  });
});
