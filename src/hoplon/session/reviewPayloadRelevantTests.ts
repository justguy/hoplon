/** Relevant-tests advisory pane for a session review payload. */

import type { HoplonEngine } from '../engine/types.js';
import type { ReviewImpactRelevantTests } from '../contracts/reviewPayload.js';
import type { BuildSessionReviewPayloadInput } from './reviewPayload.js';

export async function resolveRelevantTestsImpact(
  input: BuildSessionReviewPayloadInput,
  changedFiles: readonly string[],
): Promise<ReviewImpactRelevantTests> {
  if (!input.includeRelevantTests) {
    return { status: 'UNAVAILABLE', reason: 'not_requested' };
  }
  if (input.engine === null) {
    return { status: 'UNAVAILABLE', reason: 'no_provider' };
  }
  if (changedFiles.length === 0) {
    return { status: 'UNAVAILABLE', reason: 'no_modified_files' };
  }
  try {
    const req = {
      correlationId: input.correlationId,
      projectId: input.projectId,
      runId: input.runId,
      modifiedFiles: [...changedFiles],
    } as unknown as Parameters<HoplonEngine['getRelevantTests']>[0];
    const result = await input.engine.getRelevantTests(req, input.signal);
    return { status: 'AVAILABLE', result };
  } catch (err) {
    return {
      status: 'UNAVAILABLE',
      reason: 'oracle_failure',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
