import { describe, expect, it } from 'vitest';

import { SessionError } from '../../src/hoplon/session/errors.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { BLOCK_AUDIT, BLOCK_PREFLIGHT, MANIFEST, makeMockEngine } from './helpers.js';

describe('HoplonEditSession — happy path (PASS)', () => {
  it('traverses created → preflighted_pass → snapshotted → edited → audited_pass → closed', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });

    expect(session.state).toBe('created');
    await session.preflight();
    expect(session.state).toBe('preflighted_pass');
    await session.createSnapshot();
    expect(session.state).toBe('snapshotted');
    await session.markEdited(['src/foo.ts']);
    expect(session.state).toBe('edited');
    const audit = await session.audit();
    expect(audit.status).toBe('PASS');
    expect(session.state).toBe('audited_pass');
    session.close();
    expect(session.state).toBe('closed');
  });

  it('dryRun may be called any number of times while snapshotted without advancing state', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();

    await session.dryRun([{ file: 'src/foo.ts', content: 'x' }]);
    await session.dryRun([{ file: 'src/foo.ts', content: 'y' }]);

    expect(session.state).toBe('snapshotted');
    await session.markEdited(['src/foo.ts']);
    expect(session.state).toBe('edited');
  });
});

describe('HoplonEditSession — BLOCK path', () => {
  it('traverses through audited_block → reverted → rollback_extracted → closed', async () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine({ auditDiff: async () => BLOCK_AUDIT }),
      manifest: MANIFEST,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    const audit = await session.audit();
    expect(audit.status).toBe('BLOCK');
    expect(session.state).toBe('audited_block');

    const revert = await session.revert();
    expect(revert.reverted).toContain('src/foo.ts');
    expect(session.state).toBe('reverted');

    const tmpl = await session.extractRollbackTemplate();
    expect(tmpl.files.length).toBeGreaterThan(0);
    expect(session.state).toBe('rollback_extracted');

    session.close();
    expect(session.state).toBe('closed');
  });

  it('preflighted_block blocks createSnapshot with preflight_not_passed', async () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine({ preflight: async () => BLOCK_PREFLIGHT }),
      manifest: MANIFEST,
    });

    await session.preflight();
    expect(session.state).toBe('preflighted_block');
    await expect(session.createSnapshot()).rejects.toMatchObject({
      kind: 'preflight_not_passed',
    });
  });

  it('derives bounded rollback guidance from the manifest and keeps uncontracted files explicit', async () => {
    let receivedMap: Record<string, string> | undefined;
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        auditDiff: async () => BLOCK_AUDIT,
        extractRollbackTemplate: async (req) => {
          receivedMap = req.contractedChangesMap;
          return {
            files: req.files.map((path) => ({
              path,
              structuralSkeleton: `Skeleton: ${path}`,
              contractedChanges: req.contractedChangesMap?.[path] ?? 'missing',
              injectionHint: 'Return to this structure, then apply ONLY the contracted change.',
            })),
            snapshotRef: req.snapshotRefId,
            generatedAt: '2026-04-21T00:00:00.000Z',
          };
        },
      }),
      manifest: {
        ...MANIFEST,
        entries: [{ path: 'src/foo.ts', scope: { kind: 'symbols', symbols: ['foo'] } }],
      },
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    await session.revert();

    const template = await session.extractRollbackTemplate({
      files: ['src/foo.ts', 'src/uncontracted.ts'],
      contractedChangesMap: {
        'src/foo.ts': 'Override only symbol(s): foo in src/foo.ts.',
      },
    });
    expect(receivedMap).toEqual({
      'src/foo.ts': 'Override only symbol(s): foo in src/foo.ts.',
      'src/uncontracted.ts':
        'No contracted change is allowed in src/uncontracted.ts; keep the file unchanged and move the edit to a manifest-declared target.',
    });
    expect(template.files.find((file) => file.path === 'src/foo.ts')?.contractedChanges).toBe(
      'Override only symbol(s): foo in src/foo.ts.',
    );
    expect(
      template.files.find((file) => file.path === 'src/uncontracted.ts')?.contractedChanges,
    ).toContain('No contracted change is allowed');
  });
});

describe('HoplonEditSession — illegal transitions fail honestly', () => {
  it('createSnapshot from created throws invalid_state_transition', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    const err = await session.createSnapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('invalid_state_transition');
    expect(session.state).toBe('created');
  });

  it('audit before markEdited throws', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();
    await expect(session.audit()).rejects.toBeInstanceOf(SessionError);
  });

  it('revert before audit throws', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await expect(session.revert()).rejects.toBeInstanceOf(SessionError);
  });

  it('revert after audit PASS throws', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    expect(session.state).toBe('audited_pass');
    await expect(session.revert()).rejects.toBeInstanceOf(SessionError);
  });

  it('extractRollbackTemplate before revert throws', async () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine({ auditDiff: async () => BLOCK_AUDIT }),
      manifest: MANIFEST,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    await expect(session.extractRollbackTemplate()).rejects.toBeInstanceOf(SessionError);
  });

  it('dryRun outside snapshotted throws', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await expect(session.dryRun([{ file: 'src/foo.ts', content: 'x' }])).rejects.toBeInstanceOf(
      SessionError,
    );

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await expect(session.dryRun([{ file: 'src/foo.ts', content: 'x' }])).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it('markEdited outside snapshotted throws', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await expect(session.markEdited(['src/foo.ts'])).rejects.toThrow(SessionError);
  });

  it('preflight cannot be called twice', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await expect(session.preflight()).rejects.toBeInstanceOf(SessionError);
  });

  it('any call after close throws session_closed', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    session.close();
    expect(session.state).toBe('closed');
    await expect(session.preflight()).rejects.toMatchObject({ kind: 'session_closed' });
  });

  it('close is idempotent', () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    session.close();
    expect(() => session.close()).not.toThrow();
    expect(session.state).toBe('closed');
  });
});
