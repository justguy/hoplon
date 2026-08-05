/**
 * tests/session/stagingStore.test.ts — unit proof for the t-076 in-memory
 * session-scoped staging store. Exercises ordering, integrity, size
 * ceilings, and consume semantics so the supervised write path can trust
 * the resolver without a live transport.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  createSessionStagingStore,
  STAGE_MAX_CHUNK_BYTES,
  STAGE_MAX_TOTAL_BYTES,
  STAGE_MAX_ENTRIES_PER_SESSION,
} from '../../src/hoplon/session/stagingStore.js';
import { SessionError } from '../../src/hoplon/session/errors.js';

function sha256(bytes: Uint8Array): string {
  const h = createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}

function bytesOf(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe('createSessionStagingStore (t-076)', () => {
  it('accumulates ordered chunks and finalizes with sha256/byteLength match', () => {
    const store = createSessionStagingStore();
    const chunk0 = bytesOf('hello ');
    const chunk1 = bytesOf('world');
    const full = bytesOf('hello world');
    const expectedSha = sha256(full);

    const r0 = store.stage(
      { stagingKey: 'k1', seq: 0, chunkBytes: chunk0, isFinal: false },
      'snapshotted',
    );
    expect(r0).toEqual({
      stagingKey: 'k1',
      chunks: 1,
      bytesStaged: chunk0.byteLength,
      complete: false,
      sha256: null,
    });

    const r1 = store.stage(
      {
        stagingKey: 'k1',
        seq: 1,
        chunkBytes: chunk1,
        isFinal: true,
        expectedTotalSha256: expectedSha,
        expectedTotalByteLength: full.byteLength,
      },
      'snapshotted',
    );
    expect(r1.complete).toBe(true);
    expect(r1.bytesStaged).toBe(full.byteLength);
    expect(r1.sha256).toBe(expectedSha);

    const consumed = store.consume(
      { stagingKey: 'k1', expectedSha256: expectedSha, expectedByteLength: full.byteLength },
      'snapshotted',
      0,
    );
    expect(new TextDecoder().decode(consumed)).toBe('hello world');
    // After consume, the entry is gone.
    expect(store.inspect()).toEqual([]);
  });

  it('rejects out-of-order seq with SessionError.stage_integrity_mismatch', () => {
    const store = createSessionStagingStore();
    store.stage(
      { stagingKey: 'k', seq: 0, chunkBytes: bytesOf('a'), isFinal: false },
      'snapshotted',
    );
    expect(() =>
      store.stage(
        { stagingKey: 'k', seq: 2, chunkBytes: bytesOf('b'), isFinal: false },
        'snapshotted',
      ),
    ).toThrow(SessionError);
    try {
      store.stage(
        { stagingKey: 'k', seq: 2, chunkBytes: bytesOf('b'), isFinal: false },
        'snapshotted',
      );
    } catch (err) {
      expect((err as SessionError).kind).toBe('stage_integrity_mismatch');
      expect((err as SessionError).details?.recoveryClass).toBe(
        'refresh_and_recompute',
      );
    }
  });

  it('rejects sha256 mismatch on finalize', () => {
    const store = createSessionStagingStore();
    const chunk = bytesOf('payload');
    const wrongSha = 'f'.repeat(64);
    expect(() =>
      store.stage(
        {
          stagingKey: 'k',
          seq: 0,
          chunkBytes: chunk,
          isFinal: true,
          expectedTotalSha256: wrongSha,
          expectedTotalByteLength: chunk.byteLength,
        },
        'snapshotted',
      ),
    ).toThrow(/sha256/);
  });

  it('does not poison an existing entry when finalization metadata is wrong', () => {
    const store = createSessionStagingStore();
    const chunk0 = bytesOf('hello ');
    const chunk1 = bytesOf('world');
    store.stage(
      { stagingKey: 'k', seq: 0, chunkBytes: chunk0, isFinal: false },
      'snapshotted',
    );

    expect(() =>
      store.stage(
        {
          stagingKey: 'k',
          seq: 1,
          chunkBytes: chunk1,
          isFinal: true,
          expectedTotalSha256: 'f'.repeat(64),
          expectedTotalByteLength: chunk0.byteLength + chunk1.byteLength,
        },
        'snapshotted',
      ),
    ).toThrow(/sha256/);

    expect(store.inspect()).toEqual([
      {
        stagingKey: 'k',
        chunks: 1,
        bytesStaged: chunk0.byteLength,
        complete: false,
      },
    ]);

    const full = new Uint8Array(chunk0.byteLength + chunk1.byteLength);
    full.set(chunk0, 0);
    full.set(chunk1, chunk0.byteLength);
    const finalized = store.stage(
      {
        stagingKey: 'k',
        seq: 1,
        chunkBytes: chunk1,
        isFinal: true,
        expectedTotalSha256: sha256(full),
        expectedTotalByteLength: full.byteLength,
      },
      'snapshotted',
    );
    expect(finalized.complete).toBe(true);
  });

  it('rejects byteLength mismatch on finalize', () => {
    const store = createSessionStagingStore();
    const chunk = bytesOf('payload');
    expect(() =>
      store.stage(
        {
          stagingKey: 'k',
          seq: 0,
          chunkBytes: chunk,
          isFinal: true,
          expectedTotalSha256: sha256(chunk),
          expectedTotalByteLength: chunk.byteLength + 1,
        },
        'snapshotted',
      ),
    ).toThrow(/expectedTotalByteLength/);
  });

  it('rejects non-UTF-8 staged bodies at finalization without retaining the entry', () => {
    const store = createSessionStagingStore();
    expect(() =>
      store.stage(
        {
          stagingKey: 'utf8-bad',
          seq: 0,
          chunkBytes: new Uint8Array([0xff]),
          isFinal: true,
          expectedTotalSha256: sha256(new Uint8Array([0xff])),
          expectedTotalByteLength: 1,
        },
        'snapshotted',
      ),
    ).toThrow(/UTF-8/);
    expect(store.inspect()).toEqual([]);
  });

  it('rejects a chunk larger than STAGE_MAX_CHUNK_BYTES', () => {
    const store = createSessionStagingStore();
    const tooBig = new Uint8Array(STAGE_MAX_CHUNK_BYTES + 1);
    expect(() =>
      store.stage(
        { stagingKey: 'k', seq: 0, chunkBytes: tooBig, isFinal: false },
        'snapshotted',
      ),
    ).toThrow(/STAGE_MAX_CHUNK_BYTES/);
  });

  it('rejects total bytes beyond STAGE_MAX_TOTAL_BYTES across chunks', () => {
    const store = createSessionStagingStore();
    const chunk = new Uint8Array(STAGE_MAX_CHUNK_BYTES);
    const fullChunks = Math.floor(STAGE_MAX_TOTAL_BYTES / STAGE_MAX_CHUNK_BYTES);
    for (let i = 0; i < fullChunks; i++) {
      store.stage(
        { stagingKey: 'k', seq: i, chunkBytes: chunk, isFinal: false },
        'snapshotted',
      );
    }
    const remainder = STAGE_MAX_TOTAL_BYTES - fullChunks * STAGE_MAX_CHUNK_BYTES;
    // One byte past the ceiling should trip the total-bytes guard.
    const overflow = new Uint8Array(remainder + 1);
    expect(() =>
      store.stage(
        { stagingKey: 'k', seq: fullChunks, chunkBytes: overflow, isFinal: false },
        'snapshotted',
      ),
    ).toThrow(/STAGE_MAX_TOTAL_BYTES/);
  });

  it('rejects more than STAGE_MAX_ENTRIES_PER_SESSION open keys', () => {
    const store = createSessionStagingStore();
    for (let i = 0; i < STAGE_MAX_ENTRIES_PER_SESSION; i++) {
      store.stage(
        {
          stagingKey: `k-${i}`,
          seq: 0,
          chunkBytes: bytesOf('x'),
          isFinal: false,
        },
        'snapshotted',
      );
    }
    expect(() =>
      store.stage(
        {
          stagingKey: 'k-overflow',
          seq: 0,
          chunkBytes: bytesOf('x'),
          isFinal: false,
        },
        'snapshotted',
      ),
    ).toThrow(/staged entries/);
  });

  it('consume throws missing_prerequisite when stagingKey is unknown', () => {
    const store = createSessionStagingStore();
    try {
      store.consume(
        { stagingKey: 'ghost', expectedSha256: 'f'.repeat(64), expectedByteLength: 0 },
        'snapshotted',
        3,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      const e = err as SessionError;
      expect(e.kind).toBe('missing_prerequisite');
      expect(e.details?.recoveryClass).toBe('check_prerequisites');
      expect(e.details?.failedChangeIndex).toBe(3);
    }
  });

  it('consume throws missing_prerequisite when entry is not finalized', () => {
    const store = createSessionStagingStore();
    const chunk = bytesOf('partial');
    store.stage(
      { stagingKey: 'k', seq: 0, chunkBytes: chunk, isFinal: false },
      'snapshotted',
    );
    expect(() =>
      store.consume(
        {
          stagingKey: 'k',
          expectedSha256: sha256(chunk),
          expectedByteLength: chunk.byteLength,
        },
        'snapshotted',
        0,
      ),
    ).toThrow(/finalized/);
  });

  it('consume throws stage_integrity_mismatch when referenced sha/byteLength differ', () => {
    const store = createSessionStagingStore();
    const chunk = bytesOf('match');
    store.stage(
      {
        stagingKey: 'k',
        seq: 0,
        chunkBytes: chunk,
        isFinal: true,
        expectedTotalSha256: sha256(chunk),
        expectedTotalByteLength: chunk.byteLength,
      },
      'snapshotted',
    );
    try {
      store.consume(
        {
          stagingKey: 'k',
          expectedSha256: 'a'.repeat(64),
          expectedByteLength: chunk.byteLength,
        },
        'snapshotted',
        1,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).kind).toBe('stage_integrity_mismatch');
    }
    // Entry is still available for another consume with correct refs.
    const bytes = store.consume(
      {
        stagingKey: 'k',
        expectedSha256: sha256(chunk),
        expectedByteLength: chunk.byteLength,
      },
      'snapshotted',
      1,
    );
    expect(new TextDecoder().decode(bytes)).toBe('match');
  });

  it('dispose clears every entry', () => {
    const store = createSessionStagingStore();
    store.stage(
      { stagingKey: 'a', seq: 0, chunkBytes: bytesOf('x'), isFinal: false },
      'snapshotted',
    );
    store.stage(
      { stagingKey: 'b', seq: 0, chunkBytes: bytesOf('y'), isFinal: false },
      'snapshotted',
    );
    expect(store.inspect().length).toBe(2);
    store.dispose();
    expect(store.inspect()).toEqual([]);
  });
});
