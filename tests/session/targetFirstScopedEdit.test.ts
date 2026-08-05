import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { targetFirstScopedEdit } from '../../src/hoplon/session/targetFirstScopedEdit.js';
import { DraftWritableManifestResultSchema } from '../../src/hoplon/contracts/writableManifestDraft.js';
import { TargetFirstScopedEditRequestSchema } from '../../src/hoplon/contracts/targetFirstScopedEdit.js';
import {
  MANIFEST,
  makeMockEngine,
} from './helpers.js';

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('targetFirstScopedEdit', () => {
  it('previews a non-authoritative manifest draft plus exact edit slice', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', enc('one\ntwo\nthree\n'));

    const result = await targetFirstScopedEdit({
      engine: makeMockEngine(),
      fs,
      root: '/',
      request: {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'symbol', file: 'src/foo.ts', symbol: 'foo' },
        editSlice: { startLine: 2, endLine: 2 },
        apply: false,
      },
    });

    expect(result.status).toBe('preview');
    expect(result.manifestDraft.requiresConfirmation).toBe(true);
    expect(result.manifestDraft.manifest.entries).toEqual([
      { path: 'src/foo.ts', scope: { kind: 'symbols', symbols: ['foo'] } },
    ]);
    expect(result.editSlice?.content).toBe('two\n');
    expect(result.proofPlan.phases).toContain('await_manifest_confirmation');
    expect(DraftWritableManifestResultSchema.safeParse(result.manifestDraft).success).toBe(true);
  });

  it('apply=true is rejected at the wire schema until a manifest is accepted', () => {
    const parsed = TargetFirstScopedEditRequestSchema.safeParse({
      projectId: 'proj-session',
      runId: 'run-session-1',
      correlationId: 'corr-session-1',
      target: { kind: 'file', path: 'src/foo.ts' },
      apply: true,
      proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) =>
      issue.path.join('.') === 'acceptedManifest',
    )).toBe(true);
  });

  it('apply=true delegates to quickEdit with the accepted manifest', async () => {
    const fs = createMemFsAdapter();
    const result = await targetFirstScopedEdit({
      engine: makeMockEngine(),
      fs,
      root: '/',
      request: {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'file', path: 'src/foo.ts' },
        apply: true,
        acceptedManifest: MANIFEST,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
      },
    });

    expect(result.status).toBe('applied');
    expect((result.quickEditResult as { outcome?: string }).outcome).toBe('pass');
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
      'export const x = 1;\n',
    );
  });
});

describe('closeout proof bundle', () => {
  it('packages session proof pointers and statuses without advancing state', async () => {
    const fs = createMemFsAdapter();
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      now: () => Date.UTC(2026, 4, 10, 12, 0, 0),
    });

    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([
      { file: 'src/foo.ts', content: 'export const ok = 1;\n' },
    ]);
    await session.audit();

    const bundle = await session.getCloseoutProofBundle({
      proofVerbosity: 'compact',
    });

    expect(session.state).toBe('audited_pass');
    expect(bundle.closeoutProofBundleSchemaVersion).toBe(1);
    expect(bundle.proofVerbosity).toBe('compact');
    expect(bundle.results.auditStatus).toBe('PASS');
    expect(bundle.changedFiles).toEqual(['src/foo.ts']);
    expect(bundle.proofRefs.snapshotRef).toMatch(/^sha256:/u);
  });
});
