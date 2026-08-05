/**
 * tests/session/applyEditsStaleWrite.test.ts — TOCTOU stale-write barrier
 * proofs for the supervised Hoplon-applied write path (t-090).
 *
 * The barrier protects the window between live-base capture (post-lock,
 * pre-resolution) and the final flush in `writeResolvedChanges`. An
 * external writer that mutates / creates / deletes a touched file inside
 * that window must:
 *
 *   - raise a typed `SessionError({ kind: 'stale_write' })`
 *   - leave session state at `snapshotted` (no `applyEdits` history entry,
 *     no partial bytes-written tally exposed as success)
 *   - roll back any earlier writes in the same batch to their captured
 *     live base (no half-applied disk drift)
 *
 * These tests exercise the seam through the public `session.applyEdits`
 * surface using a wrapper adapter that injects external mutations between
 * the resolve loop and the flush via a `beforeWrite` hook. The wrapper
 * never touches `fs` outside the existing `HoplonFsAdapter` contract.
 *
 * Disjoint structural sessions over the same file (re-resolve against
 * post-snapshot bytes after the OTHER session committed first) MUST NOT
 * trip the barrier — the third test asserts that property holds by
 * letting the simulated "external writer" install an in-memory composed
 * output that matches what the second session's resolve loop saw, then
 * letting the second session land on top of it.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { performApplyEdits } from '../../src/hoplon/session/applyEdits.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

interface DriftHook {
  /**
   * Hook invoked at the *flush phase* of the supervised write path,
   * immediately before the stale-write barrier reads the live disk state
   * for `file`. The wrapper triggers the hook the second time a path is
   * stat'd: the first stat happens during live-base capture, the second
   * happens inside `assertLiveBaseUnchanged`. Mutating the underlying
   * memfs (or the wrapper itself) inside the hook simulates an external
   * writer that landed in the resolve→flush window; the barrier's
   * subsequent read then observes the drift and the SessionError fires
   * before any byte is written through the adapter.
   */
  (file: string, statCallIndex: number): Promise<void> | void;
}

function wrapAdapterWithDrift(
  inner: HoplonFsAdapter,
  hook: DriftHook,
): HoplonFsAdapter {
  const statCallsByPath = new Map<string, number>();
  return {
    read: (path) => inner.read(path),
    list: (path) => inner.list(path),
    async stat(path) {
      const idx = statCallsByPath.get(path) ?? 0;
      statCallsByPath.set(path, idx + 1);
      // Fire the drift hook AFTER the first stat (capture phase) but
      // BEFORE the second (barrier phase). i.e., on the second call,
      // mutate before delegating so the stat itself reflects the drift.
      if (idx === 1) {
        await hook(path, idx);
      }
      return inner.stat(path);
    },
    mkdir: (path, opts) => inner.mkdir(path, opts),
    remove: (path) => inner.remove(path),
    write: (path, content) => inner.write(path, content),
  };
}

async function advanceToSnapshotted(session: ReturnType<typeof createHoplonEditSession>) {
  await session.preflight();
  await session.createSnapshot();
}

describe('session.applyEdits stale-write TOCTOU barrier (t-090)', () => {
  it('refuses to overwrite a file mutated by an external writer between resolve and flush', async () => {
    const inner = createMemFsAdapter();
    const baseline = 'export const x = 1;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(baseline));

    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/foo.ts') {
        // External writer mutates the file between Hoplon resolving the
        // output and the flush attempt. The barrier should refuse the
        // write rather than silently overwriting the foreign edit.
        await inner.write(
          'src/foo.ts',
          new TextEncoder().encode('// external writer landed first\n'),
        );
      }
    });

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'export const x = 99;\n' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('stale_write');
    expect((err as SessionError).details?.driftKind).toBe('bytes_diverged');
    expect((err as SessionError).details?.recoveryClass).toBe('refresh_and_recompute');
    expect((err as SessionError).details?.file).toBe('src/foo.ts');
    expect((err as SessionError).details?.failedChangeIndex).toBe(0);
    expect((err as SessionError).details?.byteLengthBefore).toBe(
      Buffer.byteLength(baseline, 'utf8'),
    );
    // Live size carried for telemetry — confirm a non-null number.
    expect(typeof (err as SessionError).details?.byteLengthLive).toBe('number');

    // State is unadvanced; no `applyEdits` transition recorded.
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
    // The external writer's bytes survive — Hoplon never overwrote them.
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(
      '// external writer landed first\n',
    );
  });

  it('detects deletion of a previously-existing target as stale_write/unexpected_deletion', async () => {
    const inner = createMemFsAdapter();
    const baseline = 'export const x = 1;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(baseline));

    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/foo.ts') {
        await inner.remove('src/foo.ts');
      }
    });

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'export const x = 2;\n' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('stale_write');
    expect((err as SessionError).details?.driftKind).toBe('unexpected_deletion');
    expect((err as SessionError).details?.byteLengthBefore).toBe(
      Buffer.byteLength(baseline, 'utf8'),
    );
    expect((err as SessionError).details?.byteLengthLive).toBeNull();
    expect(session.state).toBe('snapshotted');
    // Hoplon refused to materialize bytes; the foreign delete stands.
    await expect(inner.stat('src/foo.ts')).resolves.toEqual({
      exists: false,
      isFile: false,
      size: 0,
    });
  });

  it('detects unexpected creation of a brand-new target file as stale_write/unexpected_creation', async () => {
    const inner = createMemFsAdapter();
    // foo.ts does not exist when the session captures the live base.

    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/foo.ts') {
        // External writer creates the file in the resolve→flush window.
        await inner.write(
          'src/foo.ts',
          new TextEncoder().encode('// foreign creation\n'),
        );
      }
    });

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'export const x = 1;\n' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('stale_write');
    expect((err as SessionError).details?.driftKind).toBe('unexpected_creation');
    expect((err as SessionError).details?.byteLengthBefore).toBeNull();
    // Live size mirrors the foreign write Hoplon refused to overwrite.
    expect((err as SessionError).details?.byteLengthLive).toBe(
      Buffer.byteLength('// foreign creation\n', 'utf8'),
    );
    expect(session.state).toBe('snapshotted');
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(
      '// foreign creation\n',
    );
  });

  it('rolls back already-flushed files in a multi-file batch when one file is stale', async () => {
    const inner = createMemFsAdapter();
    const fooBaseline = 'export const a = 1;\n';
    const barBaseline = 'export const b = 2;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(fooBaseline));
    await inner.write('src/bar.ts', new TextEncoder().encode(barBaseline));

    // First write (foo.ts) lands cleanly. Just before the second write
    // (bar.ts), an external writer mutates bar.ts so its live base no
    // longer matches what Hoplon captured. The barrier raises stale_write
    // and the rollback path must restore foo.ts to its pre-edit bytes.
    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/bar.ts') {
        await inner.write(
          'src/bar.ts',
          new TextEncoder().encode('// foreign mutation\n'),
        );
      }
    });

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([
        { file: 'src/foo.ts', content: 'export const a = 10;\n' },
        { file: 'src/bar.ts', content: 'export const b = 20;\n' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('stale_write');
    expect((err as SessionError).details?.file).toBe('src/bar.ts');

    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
    // foo.ts MUST be restored to its pre-applyEdits bytes — the rollback
    // path is the same one t-063 ships, now reachable from the stale-write
    // barrier.
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(fooBaseline);
    // bar.ts retains the external writer's bytes; Hoplon never overwrote them.
    expect(new TextDecoder().decode(await inner.read('src/bar.ts'))).toBe(
      '// foreign mutation\n',
    );
  });

  it('preserves serialized disjoint structural edits — re-resolution against post-snapshot bytes is NOT stale', async () => {
    /**
     * The barrier compares to the captured live base, NOT to `snapshotRef`.
     * To prove the property, simulate a serialized sequence:
     *
     *   1. Session A captures the file at version V0, resolves an edit, and
     *      flushes it to V1.
     *   2. Session B starts AFTER A committed, captures V1 as its live
     *      base, resolves its edit against V1, and flushes to V2.
     *
     * No external writer fires inside B's resolve→flush window, so the
     * barrier must let the second flush land. If the barrier wrongly
     * compared to `snapshotRef` (which is shared across both sessions) it
     * would reject B's write — that is precisely the scenario this test
     * disproves.
     */
    const inner = createMemFsAdapter();
    const v0 = 'const a = 1;\nconst b = 2;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(v0));

    const engine = makeMockEngine();

    // Session A — lands first.
    const sessionA = createHoplonEditSession({ engine, manifest: MANIFEST, fs: inner });
    await advanceToSnapshotted(sessionA);
    await sessionA.applyEdits([
      {
        kind: 'patch',
        file: 'src/foo.ts',
        hunks: [{ search: 'const a = 1;', replace: 'const a = 10;' }],
      },
    ]);
    expect(sessionA.state).toBe('edited');
    const v1 = 'const a = 10;\nconst b = 2;\n';
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(v1);

    // Session B — sees v1 as its live base (post-snapshot bytes), resolves
    // a disjoint hunk against it, and flushes. No drift inside B's window.
    const sessionB = createHoplonEditSession({ engine, manifest: MANIFEST, fs: inner });
    await advanceToSnapshotted(sessionB);
    const result = await sessionB.applyEdits([
      {
        kind: 'patch',
        file: 'src/foo.ts',
        hunks: [{ search: 'const b = 2;', replace: 'const b = 20;' }],
      },
    ]);
    expect(sessionB.state).toBe('edited');
    expect(result.changedFiles).toEqual(['src/foo.ts']);
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(
      'const a = 10;\nconst b = 20;\n',
    );
  });

  it('round-trips the stale_write recovery metadata through SessionErrorTransportDetails', async () => {
    /**
     * A retry harness consuming the typed transport envelope must see the
     * full content-free recovery shape: kind, recoveryClass, file,
     * driftKind, byteLengthBefore, byteLengthLive, and failedChangeIndex.
     * The transport mapper is shared with the rest of the SessionError
     * surface, so we exercise it directly here rather than going through
     * the HTTP transport (which is not the kernel invariant we're
     * proving).
     */
    const inner = createMemFsAdapter();
    const baseline = 'export const x = 1;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(baseline));

    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/foo.ts') {
        await inner.write(
          'src/foo.ts',
          new TextEncoder().encode('// drift\n'),
        );
      }
    });

    const err = (await performApplyEdits({
      fs,
      proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 2;\n' }],
      fromState: 'snapshotted',
    }).catch((e: unknown) => e)) as SessionError;
    expect(err).toBeInstanceOf(SessionError);
    expect(err.kind).toBe('stale_write');

    const { toSessionErrorTransportDetails } = await import(
      '../../src/hoplon/session/errors.js'
    );
    const transport = toSessionErrorTransportDetails(err);
    expect(transport.recoveryClass).toBe('refresh_and_recompute');
    expect(transport.file).toBe('src/foo.ts');
    expect(transport.driftKind).toBe('bytes_diverged');
    expect(transport.failedChangeIndex).toBe(0);
    expect(transport.byteLengthBefore).toBe(Buffer.byteLength(baseline, 'utf8'));
    expect(transport.byteLengthLive).toBe(Buffer.byteLength('// drift\n', 'utf8'));

    // Confirm the transport schema accepts the round-tripped payload —
    // failure here would mean the new fields were not wired through the
    // session-error envelope.
    const { SessionErrorTransportDetailsSchema } = await import(
      '../../src/hoplon/session/transportContracts.js'
    );
    const parsed = SessionErrorTransportDetailsSchema.safeParse(transport);
    expect(parsed.success).toBe(true);
  });
});
