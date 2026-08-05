/**
 * tests/session/quickEdit.test.ts — unit proofs for the t-079 single-shot
 * convenience wrapper over the shipped session path.
 *
 * These tests drive `quickEdit` against a mock engine + memfs `HoplonFsAdapter`
 * and assert:
 *
 *   - PASS path: preflight → createSnapshot → applyEdits → audit PASS → close
 *     runs in one call. Result envelope carries session + snapshot artifacts
 *     (sessionId, snapshotRef, changedFiles, auditResult, full history).
 *   - BLOCK audit: revert + extractRollbackTemplate run by default. The
 *     envelope names `phase: 'audit'` and carries revertResult +
 *     rollbackTemplate; the session still closes.
 *   - BLOCK preflight: the wrapper stops before applyEdits, names `phase:
 *     'preflight'`, and never advances past preflighted_block.
 *   - Failure paths: when any phase throws, the envelope names exactly one
 *     phase and preserves the underlying error shape. The session still
 *     closes honestly.
 *   - Safety gate: input validation rejects mismatched editMode /
 *     proposedChanges pairings without constructing a session.
 *
 * No second write contract is introduced — the wrapper composes
 * `createHoplonEditSession.applyEdits` / `markEdited` verbatim, which these
 * tests verify by reading the session history transitions carried in the
 * result envelope.
 */

import { describe, expect, it } from 'vitest';

import { quickEdit } from '../../src/hoplon/session/quickEdit.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import {
  BLOCK_AUDIT,
  BLOCK_PREFLIGHT,
  MANIFEST,
  makeMockEngine,
} from './helpers.js';

describe('quickEdit — PASS path', () => {
  it('runs preflight → snapshot → applyEdits → audit PASS → close in one call', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const ok = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('pass');
    if (result.outcome !== 'pass') throw new Error('unreachable');
    expect(result.finalState).toBe('closed');

    // Session + snapshot artifacts remain reachable on the envelope so
    // review/audit evidence is not hidden behind the wrapper.
    expect(result.sessionId).toMatch(/.+/);
    expect(result.snapshotRef).not.toBeNull();
    expect(result.snapshotRef?.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.auditResult.status).toBe('PASS');
    expect(result.changedFiles).toEqual(['src/foo.ts']);
    expect(result.applyEdits).not.toBeNull();
    expect(result.applyEdits?.changeKindCounts).toEqual({
      full_file: 1,
      patch: 0,
      structural: 0,
    });

    // The supervised write path actually wrote bytes (we went through
    // session.applyEdits, not a second mechanism).
    const written = new TextDecoder().decode(await fs.read('src/foo.ts'));
    expect(written).toBe('export const ok = 1;\n');

    // History proves the wrapper drove the full ordered loop.
    const ops = result.history.map((h) => h.op);
    expect(ops).toEqual([
      'created',
      'preflight',
      'createSnapshot',
      'applyEdits',
      'audit',
      'close',
    ]);
  });

  it('supports markEdited (host-owned compatibility path) through the same wrapper', async () => {
    const engine = makeMockEngine();
    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      editMode: 'markEdited',
      markEditedFiles: ['src/foo.ts'],
    });

    expect(result.outcome).toBe('pass');
    if (result.outcome !== 'pass') throw new Error('unreachable');
    expect(result.changedFiles).toEqual(['src/foo.ts']);
    // markEdited never produced bytesWritten; the wrapper normalizes it to
    // zero so assertions stay uniform.
    expect(result.applyEdits?.bytesWritten).toBe(0);
    expect(result.applyEdits?.changeKindCounts).toEqual({
      full_file: 0,
      patch: 0,
      structural: 0,
    });
    const ops = result.history.map((h) => h.op);
    expect(ops).toContain('markEdited');
    expect(ops).not.toContain('applyEdits');
  });
});

describe('quickEdit — BLOCK paths preserve safety', () => {
  it('audit BLOCK: runs revert + extractRollbackTemplate, closes, and names the failing phase', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ auditDiff: async () => BLOCK_AUDIT });

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const bad = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('block');
    if (result.outcome !== 'block') throw new Error('unreachable');
    expect(result.phase).toBe('audit');
    if (result.phase !== 'audit') throw new Error('unreachable');

    expect(result.auditResult.status).toBe('BLOCK');
    expect(result.revertResult).not.toBeNull();
    expect(result.revertResult?.reverted).toContain('src/foo.ts');
    expect(result.rollbackTemplate).not.toBeNull();
    expect(result.rollbackTemplate?.files.length).toBeGreaterThan(0);

    expect(result.finalState).toBe('closed');
    const ops = result.history.map((h) => h.op);
    expect(ops).toEqual([
      'created',
      'preflight',
      'createSnapshot',
      'applyEdits',
      'audit',
      'revert',
      'extractRollbackTemplate',
      'close',
    ]);
  });

  it('audit BLOCK with revertOnBlock=false: stops after audit and leaves rollback evidence null', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ auditDiff: async () => BLOCK_AUDIT });

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const bad = 1;\n' },
      ],
      revertOnBlock: false,
    });

    expect(result.outcome).toBe('block');
    if (result.outcome !== 'block') throw new Error('unreachable');
    expect(result.phase).toBe('audit');
    if (result.phase !== 'audit') throw new Error('unreachable');

    expect(result.revertResult).toBeNull();
    expect(result.rollbackTemplate).toBeNull();
    // Session still closes even without revert.
    expect(result.finalState).toBe('closed');
  });

  it('preflight BLOCK: does not advance past preflighted_block and never runs applyEdits', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({ preflight: async () => BLOCK_PREFLIGHT });

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const forbidden = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('block');
    if (result.outcome !== 'block') throw new Error('unreachable');
    expect(result.phase).toBe('preflight');
    if (result.phase !== 'preflight') throw new Error('unreachable');
    expect(result.preflightResult.status).toBe('BLOCK');
    expect(result.snapshotRef).toBeNull();
    expect(result.applyEdits).toBeNull();
    expect(result.finalState).toBe('closed');

    const ops = result.history.map((h) => h.op);
    expect(ops).not.toContain('applyEdits');
    expect(ops).not.toContain('createSnapshot');
    expect(ops).toContain('preflight');
    expect(ops).toContain('close');
  });
});

describe('quickEdit — failure paths are machine-actionable', () => {
  it('adapter throw during applyEdits surfaces phase="applyEdits" and preserves AdapterError', async () => {
    const fs = createMemFsAdapter();
    const failing = {
      read: fs.read.bind(fs),
      list: fs.list.bind(fs),
      stat: fs.stat.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      remove: fs.remove.bind(fs),
      write: async () => {
        throw new AdapterError(
          { kind: 'fs_write_failed', engineId: 'mock', correlationId: 'corr' },
          'synthetic write failure',
        );
      },
    };
    const engine = makeMockEngine();

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs: failing,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const x = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.phase).toBe('applyEdits');
    expect(result.error).toBeInstanceOf(AdapterError);
    expect(result.auditResult).toBeNull();
    expect(result.finalState).toBe('closed');
  });

  it('engine throw during audit surfaces phase="audit" and preserves the thrown error shape', async () => {
    const fs = createMemFsAdapter();
    const auditError = new Error('synthetic audit failure');
    (auditError as Error & { kind: string }).kind = 'engine_boom';
    const engine = makeMockEngine({
      auditDiff: async () => {
        throw auditError;
      },
    });

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const x = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.phase).toBe('audit');
    expect(result.error).toBe(auditError);
    expect(result.finalState).toBe('closed');
  });

  it('revert throw on audit BLOCK: phase="revert", earlier audit result preserved', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine({
      auditDiff: async () => BLOCK_AUDIT,
      revertUncontracted: async () => {
        throw new Error('synthetic revert failure');
      },
    });

    const result = await quickEdit({
      engine,
      manifest: MANIFEST,
      fs,
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const bad = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.phase).toBe('revert');
    expect(result.auditResult?.status).toBe('BLOCK');
    expect(result.revertResult).toBeNull();
    expect(result.finalState).toBe('closed');
  });
});

describe('quickEdit — input validation', () => {
  it('rejects applyEdits mode with an empty proposedChanges list', async () => {
    const engine = makeMockEngine();
    await expect(
      quickEdit({
        engine,
        manifest: MANIFEST,
        fs: createMemFsAdapter(),
        proposedChanges: [],
      }),
    ).rejects.toBeInstanceOf(SessionError);
  });

  it('rejects markEdited mode without markEditedFiles', async () => {
    const engine = makeMockEngine();
    await expect(
      quickEdit({
        engine,
        manifest: MANIFEST,
        editMode: 'markEdited',
      }),
    ).rejects.toBeInstanceOf(SessionError);
  });

  it('rejects applyEdits mode when markEditedFiles is also supplied', async () => {
    const engine = makeMockEngine();
    await expect(
      quickEdit({
        engine,
        manifest: MANIFEST,
        fs: createMemFsAdapter(),
        proposedChanges: [{ file: 'src/foo.ts', content: 'x' }],
        markEditedFiles: ['src/foo.ts'],
      }),
    ).rejects.toBeInstanceOf(SessionError);
  });
});
