/**
 * tests/session/applyEdits.test.ts — unit proofs for the Hoplon-applied
 * write step (`session.applyEdits`) under t-063.
 *
 * These tests use a mock engine + a memfs-backed HoplonFsAdapter to prove
 * the seam mechanics in isolation:
 *
 *   - applyEdits writes through the injected adapter and returns the
 *     deterministic {changedFiles, bytesWritten} shape.
 *   - history records an `applyEdits` transition with matching outcome.
 *   - duplicate-path inputs collapse to one adapter write per file after
 *     in-memory resolution, and bytesWritten reflects the final flushed bytes.
 *   - missing adapter (session constructed without `fs`) throws
 *     SessionError, state stays `snapshotted`, history is unchanged.
 *   - empty proposedChanges throws SessionError, state stays `snapshotted`.
 *   - adapter throw restores any already-written bytes and leaves state at
 *     `snapshotted` (no hidden partial write).
 *   - markEdited remains a legal alternative from `snapshotted` (compat
 *     path); it does not require `fs`.
 *
 * Real-engine end-to-end proof lives in tests/selfhost/t063-*.proof.test.ts.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type {
  CodeIntelligenceAdapter,
  Symbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import { makeMockEngine, MANIFEST, SNAPSHOT_RESULT } from './helpers.js';

/**
 * Minimal fake CodeIntelligenceAdapter for the structural-variant proofs.
 * The real tree-sitter adapter is exercised under tests/selfhost; here we
 * stub parse() + getTopLevelSymbols() so the session test stays fast and
 * focused on resolveChange + applyEdits mechanics.
 */
function makeFakeCodeIntelligence(
  symbolsFor: (content: string) => Symbol[],
): CodeIntelligenceAdapter {
  return {
    async parse(_file, content): Promise<SyntaxTree> {
      const text = new TextDecoder().decode(content);
      return {
        rootNode: { kind: 'program', children: [text] },
      } as unknown as SyntaxTree;
    },
    getTopLevelSymbols(tree): Symbol[] {
      const text = (tree.rootNode.children[0] ?? '') as string;
      return symbolsFor(text);
    },
  };
}

async function advanceToSnapshotted(session: ReturnType<typeof createHoplonEditSession>) {
  await session.preflight();
  await session.createSnapshot();
}

describe('session.applyEdits — Hoplon-applied write step (t-063)', () => {
  it('writes through the adapter, records history, and advances to edited', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const result = await session.applyEdits([
      { file: 'src/foo.ts', content: 'export const a = 1;\n' },
      { file: 'src/bar.ts', content: 'export const b = 2;\n' },
    ]);
    expect(result.changedFiles).toEqual(['src/bar.ts', 'src/foo.ts']);
    expect(result.bytesWritten).toBe(
      Buffer.byteLength('export const a = 1;\n', 'utf8') +
        Buffer.byteLength('export const b = 2;\n', 'utf8'),
    );
    expect(session.state).toBe('edited');

    const last = session.snapshot.history.at(-1);
    expect(last?.op).toBe('applyEdits');
    expect(last?.outcome).toEqual({
      kind: 'applyEdits',
      changedFileCount: 2,
      bytesWritten: result.bytesWritten,
      changeKindCounts: { full_file: 2, patch: 0, structural: 0 },
    });
    expect(result.changeKindCounts).toEqual({ full_file: 2, patch: 0, structural: 0 });
    expect(result.overlayRefresh?.status).toBe('AVAILABLE');
    expect(result.overlayRefresh?.documentCount).toBe(2);

    const bytes = await fs.read('src/foo.ts');
    expect(new TextDecoder().decode(bytes)).toBe('export const a = 1;\n');
  });

  it('collapses duplicate paths to one adapter write and reports final bytesWritten', async () => {
    const base = createMemFsAdapter();
    let writes = 0;
    const fs: HoplonFsAdapter = {
      read: (path) => base.read(path),
      list: (path) => base.list(path),
      stat: (path) => base.stat(path),
      mkdir: (path, opts) => base.mkdir(path, opts),
      remove: (path) => base.remove(path),
      write: async (path, content) => {
        writes += 1;
        await base.write(path, content);
      },
    };
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const first = 'export const x = 1;\n';
    const second = 'export const x = 2;\n';
    const result = await session.applyEdits([
      { file: 'src/dup.ts', content: first },
      { file: 'src/dup.ts', content: second },
    ]);
    expect(result.changedFiles).toEqual(['src/dup.ts']);
    expect(result.bytesWritten).toBe(Buffer.byteLength(second, 'utf8'));
    expect(writes).toBe(1);
    const final = new TextDecoder().decode(await base.read('src/dup.ts'));
    expect(final).toBe(second);
  });

  it('rejects when no fs adapter was injected and leaves state untouched', async () => {
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'x' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('missing_prerequisite');
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
  });

  it('rejects empty proposedChanges and leaves state untouched', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session.applyEdits([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('missing_prerequisite');
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
  });

  it('rolls back already-written files when a later adapter write fails', async () => {
    const base = createMemFsAdapter();
    await base.write('src/foo.ts', new TextEncoder().encode('export const before = 1;\n'));

    let writes = 0;
    const failing: HoplonFsAdapter = {
      read: (path) => base.read(path),
      list: (path) => base.list(path),
      stat: (path) => base.stat(path),
      mkdir: (path, opts) => base.mkdir(path, opts),
      remove: (path) => base.remove(path),
      write: async (path, content) => {
        writes += 1;
        await base.write(path, content);
        if (writes === 2) {
          throw new AdapterError(
            { kind: 'fs_write_failed', engineId: 'adapter', correlationId: 'adapter' },
            'simulated adapter failure after mutating disk',
          );
        }
      },
    };
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs: failing });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([
        { file: 'src/foo.ts', content: 'export const after = 2;\n' },
        { file: 'src/bar.ts', content: 'export const created = 3;\n' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
    expect(new TextDecoder().decode(await base.read('src/foo.ts'))).toBe(
      'export const before = 1;\n',
    );
    await expect(base.stat('src/bar.ts')).resolves.toEqual({
      exists: false,
      isFile: false,
      size: 0,
    });
  });

  it('propagates adapter errors and keeps state at snapshotted when nothing was written', async () => {
    const failing: HoplonFsAdapter = {
      read: async () => new Uint8Array(),
      write: async () => {
        throw new AdapterError(
          { kind: 'fs_write_failed', engineId: 'adapter', correlationId: 'adapter' },
          'simulated adapter failure',
        );
      },
      list: async () => [],
      stat: async () => ({ exists: false, isFile: false, size: 0 }),
      mkdir: async () => {},
      remove: async () => {},
    };
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs: failing });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'x' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
  });

  it('keeps markEdited as a legal alternative edit-entry from snapshotted (compat path)', async () => {
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST });
    await advanceToSnapshotted(session);

    const result = await session.markEdited(['src/foo.ts']);
    expect(session.state).toBe('edited');
    expect(session.snapshot.history.at(-1)?.op).toBe('markEdited');
    expect(session.snapshot.changedFiles).toEqual(['src/foo.ts']);
    expect(result.overlayRefresh.status).toBe('UNAVAILABLE');
    expect(result.overlayRefresh.inputSource).toBe('failure_mask');
  });

  // -------------------------------------------------------------------------
  // t-071 widened-variant proofs
  // -------------------------------------------------------------------------

  it('applies a patch variant with multiple hunks against the running intermediate bytes', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const result = await session.applyEdits([
      {
        kind: 'patch',
        file: 'src/foo.ts',
        hunks: [
          { search: 'const a = 1;', replace: 'const a = 10;' },
          { search: 'const c = 3;', replace: 'const c = 30;' },
        ],
      },
    ]);
    expect(result.changedFiles).toEqual(['src/foo.ts']);
    expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 1, structural: 0 });
    expect(session.state).toBe('edited');

    const final = new TextDecoder().decode(await fs.read('src/foo.ts'));
    expect(final).toBe('const a = 10;\nconst b = 2;\nconst c = 30;\n');
  });

  it('rolls back and throws patch_not_applicable when an anchor is missing', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'const a = 1;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([
        {
          kind: 'patch',
          file: 'src/foo.ts',
          hunks: [{ search: 'does-not-exist', replace: 'x' }],
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('patch_not_applicable');
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
  });

  it('rolls back and throws patch_not_applicable when an anchor matches more than once', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'dup\ndup\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        {
          kind: 'patch',
          file: 'src/foo.ts',
          hunks: [{ search: 'dup', replace: 'DUP' }],
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('patch_not_applicable');
    expect(session.state).toBe('snapshotted');
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
  });

  it('applies a structural variant by replacing the matched top-level symbol bytes', async () => {
    const fs = createMemFsAdapter();
    const before = 'before();\n';
    const sym = 'export function foo() { return 1; }\n';
    const after = 'after();\n';
    const baseline = before + sym + after;
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const start = Buffer.byteLength(before, 'utf8');
    const end = start + Buffer.byteLength(sym, 'utf8');
    const codeIntelligence = makeFakeCodeIntelligence(() => [
      { name: 'foo', kind: 'function', byteRange: [start, end] },
    ]);

    const engine = makeMockEngine();
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence,
    });
    await advanceToSnapshotted(session);

    const replacement = 'export function foo() { return 99; }\n';
    const result = await session.applyEdits([
      {
        kind: 'structural',
        file: 'src/foo.ts',
        target: { symbol: 'foo' },
        content: replacement,
      },
    ]);
    expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 0, structural: 1 });
    expect(session.state).toBe('edited');

    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
      before + replacement + after,
    );
  });

  it('throws target_not_resolved and rolls back when the structural target has no match', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'export const x = 1;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));
    const codeIntelligence = makeFakeCodeIntelligence(() => []);

    const engine = makeMockEngine();
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence,
    });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        {
          kind: 'structural',
          file: 'src/foo.ts',
          target: { symbol: 'missing' },
          content: 'x',
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('target_not_resolved');
    expect(session.state).toBe('snapshotted');
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
  });

  it('throws missing_prerequisite when a structural change is submitted without a codeIntelligence adapter', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('x'));

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        {
          kind: 'structural',
          file: 'src/foo.ts',
          target: { symbol: 'foo' },
          content: 'y',
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('missing_prerequisite');
    expect(session.state).toBe('snapshotted');
  });

  it('rolls back an already-written earlier hunk when a later variant fails to resolve', async () => {
    const fs = createMemFsAdapter();
    const foo = 'const a = 1;\n';
    const bar = 'const b = 2;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(foo));
    await fs.write('src/bar.ts', new TextEncoder().encode(bar));

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    const historyLen = session.snapshot.history.length;

    const err = await session
      .applyEdits([
        { file: 'src/foo.ts', content: 'const a = 10;\n' },
        {
          kind: 'patch',
          file: 'src/bar.ts',
          hunks: [{ search: 'no-such-anchor', replace: 'x' }],
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('patch_not_applicable');
    expect(session.state).toBe('snapshotted');
    expect(session.snapshot.history.length).toBe(historyLen);
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(foo);
    expect(new TextDecoder().decode(await fs.read('src/bar.ts'))).toBe(bar);
  });

  it('resolves stagedContent refs to inline bytes before performApplyEdits (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const full = 'export const big = '.concat('x'.repeat(2048), ';\n');
    const fullBytes = new TextEncoder().encode(full);
    const sha = createHash('sha256').update(fullBytes).digest('hex');
    const mid = Math.floor(fullBytes.byteLength / 2);
    const chunk0 = fullBytes.slice(0, mid);
    const chunk1 = fullBytes.slice(mid);

    const stage0 = session.stageContent({
      stagingKey: 'big-1',
      seq: 0,
      chunkBytes: chunk0,
      isFinal: false,
    });
    expect(stage0.complete).toBe(false);
    const stage1 = session.stageContent({
      stagingKey: 'big-1',
      seq: 1,
      chunkBytes: chunk1,
      isFinal: true,
      expectedTotalSha256: sha,
      expectedTotalByteLength: fullBytes.byteLength,
    });
    expect(stage1.complete).toBe(true);
    expect(stage1.sha256).toBe(sha);

    const result = await session.applyEdits([
      {
        kind: 'full_file',
        file: 'src/big.ts',
        stagedContent: {
          stagingKey: 'big-1',
          expectedSha256: sha,
          expectedByteLength: fullBytes.byteLength,
        },
      },
    ]);
    expect(result.changedFiles).toEqual(['src/big.ts']);
    expect(result.bytesWritten).toBe(fullBytes.byteLength);
    expect(result.changeKindCounts).toEqual({ full_file: 1, patch: 0, structural: 0 });
    expect(new TextDecoder().decode(await fs.read('src/big.ts'))).toBe(full);
  });

  it('throws missing_prerequisite when stagedContent references an incomplete entry (t-076)', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    session.stageContent({
      stagingKey: 'partial',
      seq: 0,
      chunkBytes: new TextEncoder().encode('only-chunk'),
      isFinal: false,
    });

    const attempt = session.applyEdits([
      {
        kind: 'full_file',
        file: 'src/a.ts',
        stagedContent: {
          stagingKey: 'partial',
          expectedSha256: 'a'.repeat(64),
          expectedByteLength: 'only-chunk'.length,
        },
      },
    ]);
    await expect(attempt).rejects.toBeInstanceOf(SessionError);
    try {
      await attempt;
    } catch (err) {
      expect((err as SessionError).kind).toBe('missing_prerequisite');
      expect((err as SessionError).details?.prerequisite).toBe(
        'stagedContent.complete',
      );
    }
    expect(session.state).toBe('snapshotted');
  });

  it('does not consume stagedContent when applyEdits fails before landing bytes (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    await fs.write('src/bar.ts', new TextEncoder().encode('export const bar = 1;\n'));
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const body = 'export const staged = true;\n';
    const bodyBytes = new TextEncoder().encode(body);
    const sha = createHash('sha256').update(bodyBytes).digest('hex');
    session.stageContent({
      stagingKey: 'retryable',
      seq: 0,
      chunkBytes: bodyBytes,
      isFinal: true,
      expectedTotalSha256: sha,
      expectedTotalByteLength: bodyBytes.byteLength,
    });

    await expect(
      session.applyEdits([
        {
          kind: 'full_file',
          file: 'src/retryable.ts',
          stagedContent: {
            stagingKey: 'retryable',
            expectedSha256: sha,
            expectedByteLength: bodyBytes.byteLength,
          },
        },
        {
          kind: 'patch',
          file: 'src/bar.ts',
          hunks: [{ search: 'does-not-exist', replace: 'x' }],
        },
      ]),
    ).rejects.toMatchObject({
      kind: 'patch_not_applicable',
    });

    expect(session.state).toBe('snapshotted');
    const retry = await session.applyEdits([
      {
        kind: 'full_file',
        file: 'src/retryable.ts',
        stagedContent: {
          stagingKey: 'retryable',
          expectedSha256: sha,
          expectedByteLength: bodyBytes.byteLength,
        },
      },
    ]);
    expect(retry.changedFiles).toEqual(['src/retryable.ts']);
    expect(new TextDecoder().decode(await fs.read('src/retryable.ts'))).toBe(body);
  });

  it('close() disposes staged entries so no residue survives session end (t-076)', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    session.stageContent({
      stagingKey: 'a',
      seq: 0,
      chunkBytes: new TextEncoder().encode('x'),
      isFinal: false,
    });
    session.close();
    expect(session.state).toBe('closed');
    expect(() =>
      session.stageContent({
        stagingKey: 'b',
        seq: 0,
        chunkBytes: new TextEncoder().encode('x'),
        isFinal: false,
      }),
    ).toThrow(SessionError);
  });

  it('treats applyEdits and markEdited as mutually exclusive after either lands', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);
    await session.applyEdits([{ file: 'src/foo.ts', content: 'x' }]);
    expect(session.state).toBe('edited');

    // Both edit-entries legal only from `snapshotted`; calling the second
    // after the first already advanced must throw invalid_state_transition.
    await expect(session.markEdited(['src/bar.ts'])).rejects.toThrow(SessionError);
    await expect(
      session.applyEdits([{ file: 'src/bar.ts', content: 'y' }]),
    ).rejects.toBeInstanceOf(SessionError);
  });
});

// Silence unused import lint if SNAPSHOT_RESULT isn't referenced directly.
void SNAPSHOT_RESULT;
