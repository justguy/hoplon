import { describe, expect, it, vi } from 'vitest';

const quickEditSpy = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: 'pass', marker: 'quick-edit-spy' })),
);

vi.mock('../../src/hoplon/session/quickEdit.js', () => ({
  quickEdit: quickEditSpy,
}));

import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createStagingAggregateBudget } from '../../src/hoplon/session/stagingStore.js';
import { MANIFEST, makeMockEngine } from './helpers.js';

describe('target-first registry staging ownership', () => {
  it('forwards the exact registry-shared staging object into apply-mode quickEdit', async () => {
    const aggregateBudget = createStagingAggregateBudget(17);
    const staging = { aggregateBudget };
    const registry = createSessionRegistry({
      engine: makeMockEngine(),
      staging,
    });

    const result = await registry.targetFirstScopedEdit({
      request: {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'file', path: 'src/foo.ts' },
        apply: true,
        acceptedManifest: MANIFEST,
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const x = 1;\n' },
        ],
      },
    });

    expect(result.status).toBe('applied');
    expect(quickEditSpy).toHaveBeenCalledTimes(1);
    const forwarded = quickEditSpy.mock.calls[0]?.[0] as {
      staging?: unknown;
    } | undefined;
    expect(forwarded?.staging).toBe(staging);
    expect(forwarded?.staging).toEqual({ aggregateBudget });

    registry.dispose();
  });
});
