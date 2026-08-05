/**
 * tests/session/t117StagingCeilings.test.ts — t-117 staging-ceiling corpus.
 *
 * Focuses on typed SessionError recovery metadata for the stageContent caps.
 * Existing t-076 tests cover happy-path staging and consume semantics.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { SessionError } from '../../src/hoplon/session/errors.js';
import {
  createSessionStagingStore,
  STAGE_MAX_CHUNK_BYTES,
  STAGE_MAX_ENTRIES_PER_SESSION,
  STAGE_MAX_TOTAL_BYTES,
} from '../../src/hoplon/session/stagingStore.js';

function expectSessionError(fn: () => void): SessionError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    return err as SessionError;
  }
  throw new Error('expected SessionError');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('stageContent ceiling failures (t-117)', () => {
  it('reports per-chunk overflow with recovery metadata', () => {
    const store = createSessionStagingStore();
    const err = expectSessionError(() =>
      store.stage(
        {
          stagingKey: 'chunk-cap',
          seq: 0,
          chunkBytes: new Uint8Array(STAGE_MAX_CHUNK_BYTES + 1),
          isFinal: false,
        },
        'snapshotted',
      ),
    );

    expect(err.kind).toBe('stage_integrity_mismatch');
    expect(err.details?.recoveryClass).toBe('refresh_and_recompute');
    expect(err.details?.prerequisite).toBe('chunkSize');
    expect(store.inspect()).toEqual([]);
  });

  it('reports per-session entry cap with recovery metadata', () => {
    const store = createSessionStagingStore();
    for (let i = 0; i < STAGE_MAX_ENTRIES_PER_SESSION; i += 1) {
      store.stage(
        {
          stagingKey: `entry-${i}`,
          seq: 0,
          chunkBytes: new Uint8Array([0x78]),
          isFinal: false,
        },
        'snapshotted',
      );
    }

    const err = expectSessionError(() =>
      store.stage(
        {
          stagingKey: 'entry-overflow',
          seq: 0,
          chunkBytes: new Uint8Array([0x78]),
          isFinal: false,
        },
        'snapshotted',
      ),
    );

    expect(err.kind).toBe('stage_integrity_mismatch');
    expect(err.details?.recoveryClass).toBe('refresh_and_recompute');
    expect(err.details?.prerequisite).toBe('entryCount');
    expect(store.inspect()).toHaveLength(STAGE_MAX_ENTRIES_PER_SESSION);
  });

  it('reports total staged-byte overflow without truncating the existing entry', () => {
    const store = createSessionStagingStore();
    const chunk = new Uint8Array(STAGE_MAX_CHUNK_BYTES);
    const fullChunks = Math.floor(STAGE_MAX_TOTAL_BYTES / STAGE_MAX_CHUNK_BYTES);

    for (let i = 0; i < fullChunks; i += 1) {
      store.stage(
        { stagingKey: 'total-cap', seq: i, chunkBytes: chunk, isFinal: false },
        'snapshotted',
      );
    }

    const remainder = STAGE_MAX_TOTAL_BYTES - fullChunks * STAGE_MAX_CHUNK_BYTES;
    let nextSeq = fullChunks;
    if (remainder > 0) {
      store.stage(
        {
          stagingKey: 'total-cap',
          seq: nextSeq,
          chunkBytes: new Uint8Array(remainder),
          isFinal: false,
        },
        'snapshotted',
      );
      nextSeq += 1;
    }

    const err = expectSessionError(() =>
      store.stage(
        {
          stagingKey: 'total-cap',
          seq: nextSeq,
          chunkBytes: new Uint8Array([0x78]),
          isFinal: false,
        },
        'snapshotted',
      ),
    );

    expect(err.kind).toBe('stage_integrity_mismatch');
    expect(err.details?.recoveryClass).toBe('refresh_and_recompute');
    expect(err.details?.prerequisite).toBe('totalBytes');
    expect(store.inspect()).toEqual([
      {
        stagingKey: 'total-cap',
        chunks: nextSeq,
        bytesStaged: STAGE_MAX_TOTAL_BYTES,
        complete: false,
      },
    ]);
  }, 30_000);

  it('reports finalized non-UTF-8 bytes as binary rejection metadata', () => {
    const store = createSessionStagingStore();
    const invalidUtf8 = new Uint8Array([0xff]);
    const err = expectSessionError(() =>
      store.stage(
        {
          stagingKey: 'binary',
          seq: 0,
          chunkBytes: invalidUtf8,
          isFinal: true,
          expectedTotalSha256: sha256(invalidUtf8),
          expectedTotalByteLength: invalidUtf8.byteLength,
        },
        'snapshotted',
      ),
    );

    expect(err.kind).toBe('stage_integrity_mismatch');
    expect(err.details?.recoveryClass).toBe('refresh_and_recompute');
    expect(err.details?.prerequisite).toBe('utf8_text');
    expect(store.inspect()).toEqual([]);
  });
});
