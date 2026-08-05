import { describe, expect, it } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { BLOCK_AUDIT, MANIFEST, makeMockEngine } from './helpers.js';

describe('HoplonEditSession — durable snapshot and history', () => {
  it('history records every transition in order with fromState/toState', async () => {
    let clock = 1_000;
    const session = createHoplonEditSession({
      engine: makeMockEngine({ auditDiff: async () => BLOCK_AUDIT }),
      manifest: MANIFEST,
      now: () => ++clock,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.dryRun([{ file: 'src/foo.ts', content: 'x' }]);
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    await session.revert();
    await session.extractRollbackTemplate();
    session.close();

    const ops = session.snapshot.history.map((h) => h.op);
    expect(ops).toEqual([
      'created',
      'preflight',
      'createSnapshot',
      'dryRun',
      'markEdited',
      'audit',
      'revert',
      'extractRollbackTemplate',
      'close',
    ]);

    for (let i = 1; i < session.snapshot.history.length; i++) {
      const prev = session.snapshot.history[i - 1]!;
      const curr = session.snapshot.history[i]!;
      if (curr.op !== 'dryRun') {
        expect(curr.fromState).toBe(prev.toState);
      }
    }

    const ts = session.snapshot.history.map((h) => h.timestampMs);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    }
  });

  it('illegal transition does NOT append to history or mutate state', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    const historyLenBefore = session.snapshot.history.length;
    const stateBefore = session.state;
    await session.audit().catch(() => undefined);
    expect(session.state).toBe(stateBefore);
    expect(session.snapshot.history.length).toBe(historyLenBefore);
  });

  it('snapshot exposes projectId/runId/correlationId from the manifest', () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    expect(session.snapshot.projectId).toBe('proj-session');
    expect(session.snapshot.runId).toBe('run-session-1');
    expect(session.snapshot.correlationId).toBe('corr-session-1');
  });

  it('sessionId override is honored', () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      sessionId: 'my-session-id',
    });
    expect(session.sessionId).toBe('my-session-id');
  });

  it('snapshot returns defensive copies rather than live mutable references', async () => {
    const session = createHoplonEditSession({ engine: makeMockEngine(), manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();

    const first = session.snapshot;
    first.manifest.projectId = 'mutated';
    (first.changedFiles as string[]).push('src/evil.ts');
    (first.history as { op: string }[])[0]!.op = 'tampered';
    first.snapshotRef!.engineId = 'tampered-engine';

    const second = session.snapshot;
    expect(second.projectId).toBe('proj-session');
    expect(second.changedFiles).toEqual([]);
    expect(second.history[0]!.op).toBe('created');
    expect(second.snapshotRef!.engineId).toBe('mock-engine');
  });
});
