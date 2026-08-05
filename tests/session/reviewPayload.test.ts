/**
 * tests/session/reviewPayload.test.ts — unit proofs for session.getReviewPayload.
 *
 * Drives the t-072 review payload through a mock engine + memfs adapter. A
 * fake `CodeIntelligenceAdapter` that exposes a fixed list of top-level
 * symbols with byte ranges exercises boundary resolution without needing
 * tree-sitter WASM. The real tree-sitter adapter is exercised in the
 * selfhost proof.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type {
  CodeIntelligenceAdapter,
  Symbol as CiSymbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { SessionReviewPayloadSchema } from '../../src/hoplon/contracts/reviewPayload.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

function fakeCodeIntelligence(
  bySource: (text: string) => CiSymbol[],
): CodeIntelligenceAdapter {
  return {
    async parse(_file, bytes) {
      return {
        rootNode: { kind: 'program', children: [new TextDecoder().decode(bytes)] },
      } as unknown as SyntaxTree;
    },
    getTopLevelSymbols(tree) {
      const text = (tree as unknown as { rootNode: { children: unknown[] } }).rootNode
        .children[0] as string;
      return bySource(text);
    },
  };
}

/**
 * Helper: compute the byte offsets of a marker substring in a UTF-8 source,
 * returning the range that covers the full function/class this test uses.
 */
function rangeOfBlock(source: string, start: string, end: string): [number, number] {
  const idx = source.indexOf(start);
  if (idx < 0) throw new Error(`block start "${start}" not found`);
  const close = source.indexOf(end, idx);
  if (close < 0) throw new Error(`block end "${end}" not found`);
  const startByte = Buffer.byteLength(source.slice(0, idx), 'utf8');
  const endByte = Buffer.byteLength(source.slice(0, close + end.length), 'utf8');
  return [startByte, endByte];
}

describe('session.getReviewPayload — t-072', () => {
  it('resolves each touched edit to its enclosing logical boundary and emits a bounded unified diff', async () => {
    const fs = createMemFsAdapter();
    const before =
      '// file header comment (unchanged)\n' +
      'export function alpha() {\n  return 1;\n}\n' +
      'export function beta() {\n  return 2;\n}\n';
    const afterAlpha =
      '// file header comment (unchanged)\n' +
      'export function alpha() {\n  return 42; /* t-072 bounded edit */\n}\n' +
      'export function beta() {\n  return 2;\n}\n';
    await fs.write('src/sample.ts', new TextEncoder().encode(before));

    const ci = fakeCodeIntelligence((text) => [
      { name: 'alpha', kind: 'function_declaration', byteRange: rangeOfBlock(text, 'export function alpha() {', '}') },
      { name: 'beta', kind: 'function_declaration', byteRange: rangeOfBlock(text, 'export function beta() {', '}') },
    ]);

    const engine = makeMockEngine();
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/sample.ts', content: afterAlpha }]);

    const payload = await session.getReviewPayload();
    const validated = SessionReviewPayloadSchema.safeParse(payload);
    expect(validated.success).toBe(true);

    expect(payload.phase).toBe('post-edit');
    expect(payload.state).toBe('edited');
    expect(payload.changedFiles).toEqual(['src/sample.ts']);
    expect(payload.changeKindCounts).toEqual({ full_file: 1, patch: 0, structural: 0 });
    expect(payload.files).toHaveLength(1);

    const file = payload.files[0]!;
    expect(file.path).toBe('src/sample.ts');
    expect(file.fallback).toBeNull();
    expect(file.boundaries).toHaveLength(1);

    const boundary = file.boundaries[0]!;
    expect(boundary.symbol).toBe('alpha');
    expect(boundary.symbolKind).toBe('function_declaration');
    expect(boundary.changeMode).toBe('modified');
    expect(boundary.unifiedDiff).toContain('-  return 1;');
    expect(boundary.unifiedDiff).toContain('+  return 42; /* t-072 bounded edit */');
    // The untouched `beta` symbol must NOT leak into any boundary's diff.
    expect(boundary.unifiedDiff).not.toContain('return 2;');
    expect(boundary.lineRange[0]).toBeGreaterThanOrEqual(1);
    expect(boundary.lineRange[1]).toBeGreaterThanOrEqual(boundary.lineRange[0]);
  });

  it('falls back honestly with reason=no_code_intelligence when no adapter is injected', async () => {
    const fs = createMemFsAdapter();
    const before = 'const x = 1;\n';
    const after = 'const x = 2;\n';
    await fs.write('src/thing.ts', new TextEncoder().encode(before));
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/thing.ts', content: after }]);

    const payload = await session.getReviewPayload();
    expect(payload.notes).toContain('code_intelligence_unavailable');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.boundaries).toHaveLength(0);
    expect(payload.files[0]!.fallback?.reason).toBe('no_code_intelligence');
    expect(payload.files[0]!.fallback?.unifiedDiff).toContain('-const x = 1;');
    expect(payload.files[0]!.fallback?.unifiedDiff).toContain('+const x = 2;');
  });

  it('surfaces new-file and removed-symbol boundaries with correct changeMode', async () => {
    const fs = createMemFsAdapter();
    const initial = 'export function keep() {\n  return 0;\n}\nexport function gone() {\n  return 9;\n}\n';
    await fs.write('src/mod.ts', new TextEncoder().encode(initial));
    const afterRemovedGone =
      'export function keep() {\n  return 0;\n}\nexport function shiny() {\n  return 42;\n}\n';

    const ci = fakeCodeIntelligence((text) => {
      const syms: CiSymbol[] = [];
      if (text.includes('export function keep()')) {
        syms.push({
          name: 'keep',
          kind: 'function_declaration',
          byteRange: rangeOfBlock(text, 'export function keep() {', '}'),
        });
      }
      if (text.includes('export function gone()')) {
        syms.push({
          name: 'gone',
          kind: 'function_declaration',
          byteRange: rangeOfBlock(text, 'export function gone() {', '}'),
        });
      }
      if (text.includes('export function shiny()')) {
        syms.push({
          name: 'shiny',
          kind: 'function_declaration',
          byteRange: rangeOfBlock(text, 'export function shiny() {', '}'),
        });
      }
      return syms;
    });

    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/mod.ts', content: afterRemovedGone }]);

    const payload = await session.getReviewPayload();
    const boundaries = payload.files[0]!.boundaries;
    const modes = boundaries.map((b) => `${b.symbol}:${b.changeMode}`).sort();
    expect(modes).toContain('gone:removed');
    expect(modes).toContain('shiny:added');
  });

  it('includes optional dependency-impact pane only when requested AND provider available', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() { return 1; }\n';
    const after = 'export function alpha() { return 7; }\n';
    await fs.write('src/sample.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);

    let analyzed = 0;
    const engine = makeMockEngine({
      analyzeBlastRadius: async (req) => {
        analyzed += 1;
        return {
          correlationId: req.correlationId,
          advisory: true,
          status: 'SAFE',
          providerAvailable: true,
          warnThreshold: 10,
          entries: req.symbols.map((s) => ({
            symbol: s,
            classification: 'safe',
            referenceCount: 0,
            affectedFileCount: 0,
            affectedFiles: [],
            thresholdUsed: 10,
          })),
        };
      },
    });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/sample.ts', content: after }]);

    const optedOut = await session.getReviewPayload();
    expect(optedOut.impact.dependencyImpact.status).toBe('UNAVAILABLE');
    expect(optedOut.impact.dependencyImpact.reason).toBe('not_requested');
    // Subjects are still derived so hosts can see what would have been
    // analyzed even on opt-out; the analyzer itself is never called.
    expect(optedOut.impact.dependencyImpact.subjectCounts.symbol).toBeGreaterThan(0);
    expect(optedOut.impact.dependencyImpact.blastRadius).toBeNull();
    expect(analyzed).toBe(0);

    const withPane = await session.getReviewPayload({ includeDependencyImpact: true });
    expect(analyzed).toBe(1);
    expect(withPane.impact.dependencyImpact.status).toBe('AVAILABLE');
    expect(withPane.impact.dependencyImpact.reason).toBeNull();
    expect(withPane.impact.dependencyImpact.subjectCounts.symbol).toBeGreaterThan(0);
    expect(withPane.impact.dependencyImpact.blastRadius?.entries[0]?.symbol.name).toBe('alpha');
    expect(withPane.impact.dependencyImpact.subjects[0]).toMatchObject({
      kind: 'symbol',
      symbolName: 'alpha',
      origin: 'review_boundary',
    });
  });

  it('reports dependency-impact DEGRADED with reason=no_provider when the adapter returns UNAVAILABLE', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() { return 1; }\n';
    const after = 'export function alpha() { return 7; }\n';
    await fs.write('src/sample.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const engine = makeMockEngine({
      analyzeBlastRadius: async (req) => ({
        correlationId: req.correlationId,
        advisory: true,
        status: 'UNAVAILABLE',
        providerAvailable: false,
        warnThreshold: 10,
        entries: [],
      }),
    });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/sample.ts', content: after }]);

    const payload = await session.getReviewPayload({ includeDependencyImpact: true });
    expect(payload.impact.dependencyImpact.status).toBe('DEGRADED');
    expect(payload.impact.dependencyImpact.reason).toBe('no_provider');
    // The analyzer envelope is preserved (status=UNAVAILABLE) so hosts see
    // "provider answered no" vs "provider never called" — never fabricated.
    expect(payload.impact.dependencyImpact.blastRadius?.status).toBe('UNAVAILABLE');
    expect(payload.impact.dependencyImpact.subjects[0]).toMatchObject({
      kind: 'symbol',
      symbolName: 'alpha',
    });
  });

  it('surfaces markEdited_before_bytes_unavailable when the session used markEdited instead of applyEdits', async () => {
    const fs = createMemFsAdapter();
    const after = 'export const x = 99;\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(after));
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);

    const payload = await session.getReviewPayload();
    expect(payload.notes).toContain('markEdited_before_bytes_unavailable');
    expect(payload.changeKindCounts).toBeNull();
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.fallback?.reason).toBeDefined();
  });

  it('rejects preview phase before snapshotted and requires proposedChanges', async () => {
    const fs = createMemFsAdapter();
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await expect(
      session.getReviewPayload({ phase: 'preview' }),
    ).rejects.toBeInstanceOf(SessionError);

    await session.preflight();
    await session.createSnapshot();
    await expect(
      session.getReviewPayload({ phase: 'preview' }),
    ).rejects.toBeInstanceOf(SessionError);
  });

  it('preview phase materializes proposedChanges against fs bytes and emits a bounded diff', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() {\n  return 1;\n}\n';
    await fs.write('src/sample.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();

    const payload = await session.getReviewPayload({
      phase: 'preview',
      proposedChanges: [
        {
          kind: 'patch',
          file: 'src/sample.ts',
          hunks: [{ search: 'return 1;', replace: 'return 77; // preview' }],
        },
      ],
    });
    expect(payload.phase).toBe('preview');
    expect(payload.notes).toContain('preview_before_bytes_read_from_disk');
    expect(payload.files).toHaveLength(1);
    const boundary = payload.files[0]!.boundaries[0];
    expect(boundary?.symbol).toBe('alpha');
    expect(boundary?.unifiedDiff).toContain('+  return 77; // preview');
    // Preview phase must not leak the applyEdits per-kind tally (no edits yet).
    expect(payload.changeKindCounts).toBeNull();
    expect(session.state).toBe('snapshotted');
  });

  it('preview phase hydrates stagedContent without consuming it (t-076)', async () => {
    const { createHash } = await import('node:crypto');
    const fs = createMemFsAdapter();
    const before = 'export const staged = 1;\n';
    const after = 'export const staged = 2;\n';
    await fs.write('src/sample.ts', new TextEncoder().encode(before));
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();

    const afterBytes = new TextEncoder().encode(after);
    const sha = createHash('sha256').update(afterBytes).digest('hex');
    const mid = Math.floor(afterBytes.byteLength / 2);
    session.stageContent({
      stagingKey: 'preview-staged',
      seq: 0,
      chunkBytes: afterBytes.slice(0, mid),
      isFinal: false,
    });
    session.stageContent({
      stagingKey: 'preview-staged',
      seq: 1,
      chunkBytes: afterBytes.slice(mid),
      isFinal: true,
      expectedTotalSha256: sha,
      expectedTotalByteLength: afterBytes.byteLength,
    });

    const payload = await session.getReviewPayload({
      phase: 'preview',
      proposedChanges: [
        {
          kind: 'full_file',
          file: 'src/sample.ts',
          stagedContent: {
            stagingKey: 'preview-staged',
            expectedSha256: sha,
            expectedByteLength: afterBytes.byteLength,
          },
        },
      ],
    });
    expect(payload.phase).toBe('preview');
    expect(payload.notes).toContain('preview_before_bytes_read_from_disk');
    expect(payload.files[0]!.fallback?.unifiedDiff).toContain('-export const staged = 1;');
    expect(payload.files[0]!.fallback?.unifiedDiff).toContain('+export const staged = 2;');
    expect(session.state).toBe('snapshotted');

    await session.applyEdits([
      {
        kind: 'full_file',
        file: 'src/sample.ts',
        stagedContent: {
          stagingKey: 'preview-staged',
          expectedSha256: sha,
          expectedByteLength: afterBytes.byteLength,
        },
      },
    ]);
    expect(new TextDecoder().decode(await fs.read('src/sample.ts'))).toBe(after);
  });

  it('preview phase surfaces patch_not_applicable instead of silently omitting an invalid proposed change', async () => {
    const fs = createMemFsAdapter();
    await fs.write(
      'src/sample.ts',
      new TextEncoder().encode('export function alpha() {\n  return 1;\n}\n'),
    );
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();

    await expect(
      session.getReviewPayload({
        phase: 'preview',
        proposedChanges: [
          {
            kind: 'patch',
            file: 'src/sample.ts',
            hunks: [{ search: 'return 999;', replace: 'return 7;' }],
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'SessionError',
      kind: 'patch_not_applicable',
      attempted: 'getReviewPayload',
    });
  });

  it('requires an injected fs adapter instead of silently fabricating review bytes', async () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);

    await expect(session.getReviewPayload()).rejects.toMatchObject({
      name: 'SessionError',
      kind: 'missing_prerequisite',
      attempted: 'getReviewPayload',
    });
  });

  // -------------------------------------------------------------------------
  // Snapshotted-state post-edit fallback
  //
  // Regression for gap://hoplon/supervised-edit-review/
  // session-snapshotted-review-payload-2026-06-05: a piece reaches code review
  // while its Hoplon session is still `snapshotted` (no applyEdits/markEdited
  // transition was recorded). Previously getReviewPayload threw
  // invalid_state_transition, the consumer fell back to an EMPTY review, the
  // piece was rejected, and the run dead-ended at NO_EXECUTION_PROGRESS. The
  // review path must instead audit the real on-disk scope files.
  // -------------------------------------------------------------------------

  it('snapshotted session: post-edit review audits real on-disk scope files instead of throwing or returning empty (run 1dd147ca PIECE_2 regression)', async () => {
    const fs = createMemFsAdapter();
    // The SWE wrote the piece's file out-of-band — the bytes are on disk but
    // the session never observed applyEdits/markEdited, so it is still
    // `snapshotted` at review time. This is the exact shape of PIECE_2.
    const written =
      'export function handler() {\n  return doWork();\n}\nfunction doWork() {\n  return 42;\n}\n';
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();
    // NOTE: no applyEdits / markEdited — write straight to the fs adapter.
    await fs.write('src/foo.ts', new TextEncoder().encode(written));
    expect(session.state).toBe('snapshotted');

    const payload = await session.getReviewPayload();
    expect(SessionReviewPayloadSchema.safeParse(payload).success).toBe(true);

    // No throw, real content, honest note — never an empty review.
    expect(payload.state).toBe('snapshotted');
    expect(payload.changedFiles).toEqual(['src/foo.ts']);
    expect(payload.notes).toContain('snapshotted_review_scope_fallback');
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0]!;
    expect(file.path).toBe('src/foo.ts');
    // before=null in this state → full add-diff carrying the real bytes, so a
    // reviewer sees the actual file contents rather than an empty finding.
    expect(file.fallback?.reason).toBe('new_file');
    expect(file.fallback?.unifiedDiff).toContain('+export function handler() {');
    expect(file.fallback?.unifiedDiff).toContain('+  return 42;');
  });

  it('snapshotted session with nothing on disk: review is empty-but-honest (no throw), with a distinct note', async () => {
    const fs = createMemFsAdapter();
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await session.preflight();
    await session.createSnapshot();
    expect(session.state).toBe('snapshotted');

    // No file was ever written for the scope — distinguish "nothing
    // materialized" from "edited but state desynced" instead of both
    // collapsing to a silent empty review.
    const payload = await session.getReviewPayload();
    expect(SessionReviewPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.state).toBe('snapshotted');
    expect(payload.changedFiles).toEqual([]);
    expect(payload.files).toEqual([]);
    expect(payload.notes).toContain('snapshotted_review_no_files_on_disk');
    expect(payload.notes).not.toContain('snapshotted_review_scope_fallback');
  });

  it('snapshotted fallback renders per-symbol added boundaries when code intelligence is available', async () => {
    const fs = createMemFsAdapter();
    const written = 'export function alpha() {\n  return 1;\n}\n';
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      codeIntelligence: ci,
    });
    await session.preflight();
    await session.createSnapshot();
    await fs.write('src/foo.ts', new TextEncoder().encode(written));

    const payload = await session.getReviewPayload();
    expect(payload.notes).toContain('snapshotted_review_scope_fallback');
    expect(payload.files).toHaveLength(1);
    const boundaries = payload.files[0]!.boundaries;
    expect(boundaries.map((b) => `${b.symbol}:${b.changeMode}`)).toContain('alpha:added');
    expect(boundaries[0]!.unifiedDiff).toContain('return 1;');
  });
});
