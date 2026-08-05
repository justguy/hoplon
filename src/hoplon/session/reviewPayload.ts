/** Compose the advisory session review payload from existing session facts. */

import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { HoplonEngine } from '../engine/types.js';
import type { PostEditPolicyScanner } from '../contracts/postEditPolicy.js';
import type { ProposedChange } from '../contracts/requests.js';
import type {
  ReviewBoundary,
  ReviewFile,
  ReviewPayloadNote,
  ReviewPayloadPhase,
  SessionReviewPayload,
} from '../contracts/reviewPayload.js';
import type { ApplyEditsChangeKindCounts, SessionState } from './types.js';
import { resolveReviewBoundaries } from './reviewBoundaries.js';
import { composeDependencyImpactSidecar, deriveReviewSubjects } from './dependencyImpactSidecar.js';
import { composeWritePreviewAdvisoryIntelligence } from '../contracts/writePreviewIntelligence.js';
import { composePostEditPolicySidecar } from './postEditPolicy.js';
import { SessionError } from './errors.js';
import { gatherFileSides, mirrorCounts } from './reviewPayloadFileSides.js';
import { resolveRelevantTestsImpact } from './reviewPayloadRelevantTests.js';

export interface BuildSessionReviewPayloadInput {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly phase: ReviewPayloadPhase;
  readonly contextLines: number;
  readonly generatedAtIso: string;
  readonly changedFiles: readonly string[];
  /**
   * Contracted writable-scope paths (deduped, sorted) from the session
   * manifest. Used ONLY by the `state === 'snapshotted'` post-edit fallback to
   * discover the real on-disk files to review when no `applyEdits` /
   * `markEdited` transition was ever recorded (so `changedFiles` is empty).
   * Ignored in every other state.
   */
  readonly snapshotScopePaths?: readonly string[];
  readonly applyEditsChangeKindCounts: ApplyEditsChangeKindCounts | null;
  readonly fs: HoplonFsAdapter | null;
  readonly codeIntelligence: CodeIntelligenceAdapter | null;
  /**
   * Before-bytes map captured by the supervised write path for post-edit
   * review. Null for markEdited-driven sessions (surfaces an explicit note).
   */
  readonly capturedBeforeBytes: ReadonlyMap<string, Uint8Array | null> | null;
  /** Proposed changes for preview-phase composition. */
  readonly proposedChanges?: readonly ProposedChange[];
  readonly includeDependencyImpact: boolean;
  readonly includeViolationRisk: boolean;
  readonly includeRelevantTests: boolean;
  readonly includePostEditPolicyScan: boolean;
  readonly postEditPolicyScanner: PostEditPolicyScanner | null;
  readonly dependencyImpactWarnThreshold?: number;
  readonly dependencyImpactPrecomputedChangedFiles?: readonly string[];
  readonly engine: HoplonEngine | null;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal | undefined;
}

export async function buildSessionReviewPayload(
  input: BuildSessionReviewPayloadInput,
): Promise<SessionReviewPayload> {
  const notes: ReviewPayloadNote[] = [];

  if (input.fs === null) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: input.state,
      attempted: 'getReviewPayload',
      detail: 'review payload requires an fs adapter to read before/after bytes',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'fs',
      },
    });
  }

  const { filesInReview, byFile, markEditedBeforeBytesUnavailable } =
    await gatherFileSides(input, notes);
  const fileBlocks: ReviewFile[] = [];

  for (const path of filesInReview) {
    const { before, after } = byFile.get(path)!;
    const resolved = await resolveReviewBoundaries({
      path,
      before,
      after,
      codeIntelligence: input.codeIntelligence,
      contextLines: input.contextLines,
      signal: input.signal,
    });
    fileBlocks.push({
      path,
      boundaries: resolved.boundaries,
      fallback: resolved.fallback,
    });
  }

  if (input.codeIntelligence === null) {
    notes.push('code_intelligence_unavailable');
  }
  if (!input.includeDependencyImpact) {
    notes.push('impact_dependencyImpact_opted_out');
  }
  if (!input.includeViolationRisk) {
    notes.push('impact_violationRisk_opted_out');
  }
  if (!input.includeRelevantTests) {
    notes.push('impact_relevantTests_opted_out');
  }

  const reviewSubjects = deriveReviewSubjects(fileBlocks, {
    markEditedBeforeBytesUnavailable,
  });

  const dependencyImpact = await composeDependencyImpactSidecar({
    subjects: reviewSubjects,
    includeDependencyImpact: input.includeDependencyImpact,
    engine: input.engine,
    correlationId: input.correlationId,
    projectId: input.projectId,
    ...(input.dependencyImpactWarnThreshold !== undefined
      ? { warnThreshold: input.dependencyImpactWarnThreshold }
      : {}),
    ...(input.dependencyImpactPrecomputedChangedFiles !== undefined
      ? {
          precomputedChangedFiles: [
            ...input.dependencyImpactPrecomputedChangedFiles,
          ],
        }
      : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const relevantTests = await resolveRelevantTestsImpact(input, filesInReview);
  const postEditPolicy = await composePostEditPolicySidecar({
    includePostEditPolicyScan: input.includePostEditPolicyScan,
    scanner: input.postEditPolicyScanner,
    phase: input.phase,
    files: filesInReview.map((path) => {
      const sides = byFile.get(path)!;
      return { path, before: sides.before, after: sides.after };
    }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const advisoryIntelligence = await composeWritePreviewAdvisoryIntelligence({
    dependencyImpact,
    includeViolationRisk: input.includeViolationRisk,
    predictViolationRisk:
      input.engine === null
        ? null
        : (req, signal) => input.engine!.predictViolationRisk(req, signal),
    correlationId: input.correlationId,
    projectId: input.projectId,
    changedFileCount: filesInReview.length,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const payload: SessionReviewPayload = {
    version: 1,
    sessionId: input.sessionId,
    state: input.state,
    phase: input.phase,
    generatedAt: input.generatedAtIso,
    changedFiles: filesInReview,
    changeKindCounts: mirrorCounts(input.applyEditsChangeKindCounts),
    files: fileBlocks,
    impact: {
      dependencyImpact,
      relevantTests,
      advisoryIntelligence,
      postEditPolicy,
    },
    notes,
  };
  return payload;
}

// ---------------------------------------------------------------------------
// File-side gathering (before/after bytes per path)

export function touchedBoundariesHaveContent(
  boundaries: readonly ReviewBoundary[],
): boolean {
  return boundaries.some((b) => b.unifiedDiff.length > 0);
}
