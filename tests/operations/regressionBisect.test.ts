import { describe, expect, it } from 'vitest';

import { runRegressionBisect } from '../../src/hoplon/operations/regressionBisect.js';
import type {
  RegressionBisectRevision,
  RegressionBisectRunner,
  RegressionBisectVerifierVerdict,
} from '../../src/hoplon/contracts/regressionBisect.js';

const REVISIONS: RegressionBisectRevision[] = Array.from({ length: 8 }, (_, i) => ({
  revision: `rev-${i}`,
  ordinal: i,
}));

function runnerFor(
  verdictForOrdinal: (ordinal: number) => RegressionBisectVerifierVerdict,
): RegressionBisectRunner & { cleaned: () => boolean } {
  let cleaned = false;
  return {
    async runAtRevision(revision) {
      return {
        verdict: verdictForOrdinal(revision.ordinal),
        transcriptRef: `transcripts/${revision.revision}.json`,
      };
    },
    async cleanup() {
      cleaned = true;
    },
    cleaned: () => cleaned,
  };
}

describe('runRegressionBisect — t-126 isolated macro', () => {
  it('identifies the first failing revision in a clean regression range', async () => {
    const runner = runnerFor((ordinal) => (ordinal < 5 ? 'pass' : 'fail'));
    const result = await runRegressionBisect({ revisions: REVISIONS, runner });

    expect(result.outcome).toBe('REGRESSION_FOUND');
    expect(result.firstFailingRevision).toEqual({ revision: 'rev-5', ordinal: 5 });
    expect(result.lastPassingRevision).toEqual({ revision: 'rev-4', ordinal: 4 });
    expect(result.transcript.every((entry) => entry.transcriptRef)).toBe(true);
    expect(runner.cleaned()).toBe(true);
  });

  it('returns NO_REGRESSION when the range end still passes', async () => {
    const runner = runnerFor(() => 'pass');
    const result = await runRegressionBisect({ revisions: REVISIONS, runner });

    expect(result.outcome).toBe('NO_REGRESSION');
    expect(result.firstFailingRevision).toBeNull();
    expect(result.lastPassingRevision).toEqual({ revision: 'rev-7', ordinal: 7 });
    expect(runner.cleaned()).toBe(true);
  });

  it('classifies flaky verifier output as inconclusive', async () => {
    const runner = runnerFor((ordinal) => {
      if (ordinal === 7) return 'fail';
      if (ordinal === 3) return 'inconclusive';
      return ordinal < 5 ? 'pass' : 'fail';
    });
    const result = await runRegressionBisect({ revisions: REVISIONS, runner });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.reason).toBe('verifier_inconclusive');
    expect(result.firstFailingRevision).toBeNull();
    expect(result.transcript).toContainEqual({
      revision: 'rev-3',
      ordinal: 3,
      verdict: 'inconclusive',
      transcriptRef: 'transcripts/rev-3.json',
    });
    expect(runner.cleaned()).toBe(true);
  });

  it('cleans up isolated runner state when verifier throws', async () => {
    let cleaned = false;
    const runner: RegressionBisectRunner = {
      async runAtRevision() {
        throw new Error('sandbox checkout failed');
      },
      async cleanup() {
        cleaned = true;
      },
    };

    await expect(runRegressionBisect({ revisions: REVISIONS, runner })).rejects.toThrow(
      'sandbox checkout failed',
    );
    expect(cleaned).toBe(true);
  });
});
