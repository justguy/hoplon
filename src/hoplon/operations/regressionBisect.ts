import {
  RegressionBisectResultSchema,
  type RegressionBisectResult,
  type RegressionBisectRevision,
  type RegressionBisectRunner,
  type RegressionBisectTranscriptEntry,
} from '../contracts/regressionBisect.js';

export interface RunRegressionBisectInput {
  readonly revisions: readonly RegressionBisectRevision[];
  readonly runner: RegressionBisectRunner;
  readonly signal?: AbortSignal | undefined;
}

export async function runRegressionBisect(
  input: RunRegressionBisectInput,
): Promise<RegressionBisectResult> {
  const revisions = [...input.revisions].sort((a, b) => a.ordinal - b.ordinal);
  const transcript: RegressionBisectTranscriptEntry[] = [];
  try {
    if (revisions.length < 2) {
      return finalize({
        outcome: 'INCONCLUSIVE',
        firstFailingRevision: null,
        lastPassingRevision: null,
        transcript,
        reason: 'revision_range_too_small',
      });
    }

    const first = await runVerifier(input.runner, revisions[0]!, input.signal);
    transcript.push(first);
    if (first.verdict !== 'pass') {
      return finalize({
        outcome: 'INCONCLUSIVE',
        firstFailingRevision: null,
        lastPassingRevision: null,
        transcript,
        reason:
          first.verdict === 'fail'
            ? 'range_start_already_failing'
            : 'range_start_inconclusive',
      });
    }

    const last = await runVerifier(
      input.runner,
      revisions[revisions.length - 1]!,
      input.signal,
    );
    transcript.push(last);
    if (last.verdict === 'pass') {
      return finalize({
        outcome: 'NO_REGRESSION',
        firstFailingRevision: null,
        lastPassingRevision: revisions[revisions.length - 1]!,
        transcript,
        reason: null,
      });
    }
    if (last.verdict === 'inconclusive') {
      return finalize({
        outcome: 'INCONCLUSIVE',
        firstFailingRevision: null,
        lastPassingRevision: revisions[0]!,
        transcript,
        reason: 'range_end_inconclusive',
      });
    }

    let low = 0;
    let high = revisions.length - 1;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      const result = await runVerifier(input.runner, revisions[mid]!, input.signal);
      transcript.push(result);
      if (result.verdict === 'pass') {
        low = mid;
      } else if (result.verdict === 'fail') {
        high = mid;
      } else {
        return finalize({
          outcome: 'INCONCLUSIVE',
          firstFailingRevision: null,
          lastPassingRevision: revisions[low]!,
          transcript,
          reason: 'verifier_inconclusive',
        });
      }
    }

    return finalize({
      outcome: 'REGRESSION_FOUND',
      firstFailingRevision: revisions[high]!,
      lastPassingRevision: revisions[low]!,
      transcript,
      reason: null,
    });
  } finally {
    await input.runner.cleanup?.();
  }
}

async function runVerifier(
  runner: RegressionBisectRunner,
  revision: RegressionBisectRevision,
  signal: AbortSignal | undefined,
): Promise<RegressionBisectTranscriptEntry> {
  const result = await runner.runAtRevision(revision, signal);
  return {
    revision: revision.revision,
    ordinal: revision.ordinal,
    verdict: result.verdict,
    transcriptRef: result.transcriptRef,
  };
}

function finalize(
  value: Omit<RegressionBisectResult, 'version'>,
): RegressionBisectResult {
  return RegressionBisectResultSchema.parse({ version: 1, ...value });
}
