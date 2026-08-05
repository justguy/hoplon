/**
 * session/parallelBatchBehaviorVerification.ts — t-091 macro composer.
 *
 * Cross-file semantic drift across resolved parallel safe-edit sessions is
 * not visible to `auditDiff` (a per-file structural gate). This macro
 * composes the already-shipped t-067 host-owned behavior-verification seam
 * over the union of changed files in the batch, so behavioral regressions
 * surface at the orchestrator layer:
 *
 *   1. Union the per-session `changedFiles` (sorted, deduped) and record
 *      which session(s) contributed each file.
 *   2. Delegate to `composeVerifyBehaviorResult` (t-067) with the unioned
 *      `changedFiles`. The composer handles `getRelevantTests` selection,
 *      runner availability, override + fallback selection logic, runner
 *      invocation, and the `VerifyBehaviorResult` envelope.
 *   3. Wrap the result in the macro envelope and derive failure linkage:
 *      for each failing test file the runner reports, list the session(s)
 *      whose `changedFiles` overlap with the union (best-effort attribution
 *      via the same `getRelevantTests` oracle echoed on the result).
 *
 * The macro is composition-only:
 *   - It never spawns tests; that lives in `BehaviorTestRunnerAdapter`.
 *   - It never modifies `auditDiff` PASS/BLOCK semantics.
 *   - It never fabricates PASS when the runner is unavailable.
 *   - It never silently truncates evidence; the wrapped
 *     `VerifyBehaviorResult` is verbatim.
 */

import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { HoplonEngine } from '../engine/types.js';
import type {
  BatchBehaviorFailureLinkage,
  BatchBehaviorFailureLinkageEntry,
  BatchBehaviorVerificationOptions,
  BatchBehaviorVerificationOutcome,
  BatchBehaviorVerificationResult,
  BatchBehaviorVerificationSelection,
  BatchBehaviorVerificationSessionInput,
} from '../contracts/parallelBatchBehaviorVerification.js';
import type {
  VerifyBehaviorFailingTest,
  VerifyBehaviorResult,
} from '../contracts/verifyBehavior.js';
import { composeVerifyBehaviorResult } from './verifyBehavior.js';

// ---------------------------------------------------------------------------
// Composer input
// ---------------------------------------------------------------------------

export interface ComposeParallelBatchBehaviorVerificationInput {
  readonly engine: HoplonEngine | null;
  readonly runner: BehaviorTestRunnerAdapter | null;
  readonly sessions: readonly BatchBehaviorVerificationSessionInput[];
  readonly options: BatchBehaviorVerificationOptions;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly projectRoot: string;
  readonly now: () => number;
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// composeParallelBatchBehaviorVerification
// ---------------------------------------------------------------------------

export async function composeParallelBatchBehaviorVerification(
  input: ComposeParallelBatchBehaviorVerificationInput,
): Promise<BatchBehaviorVerificationResult> {
  const generatedAt = new Date(input.now()).toISOString();
  const sortedSessions = [...input.sessions].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  );
  const selection = buildSelection(sortedSessions);

  const verifyResult = await composeVerifyBehaviorResult({
    engine: input.engine,
    runner: input.runner,
    options: input.options.verify ?? {},
    projectId: input.projectId,
    runId: input.runId,
    correlationId: input.correlationId,
    projectRoot: input.projectRoot,
    // Macro-level invocation: no single session owns the call. Linkage is
    // expressed at the macro envelope, not on the wrapped result.
    sessionId: null,
    snapshotRefId: null,
    changedFiles: selection.unionedChangedFiles,
    attemptNumber: null,
    now: input.now,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const outcome = mirrorOutcome(verifyResult);
  const failureLinkage = buildFailureLinkage({
    verifyResult,
    sessions: sortedSessions,
  });

  return {
    version: 1,
    advisory: true,
    outcome,
    sessions: sortedSessions,
    selection,
    verifyBehavior: verifyResult,
    failureLinkage,
    correlationId: input.correlationId,
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers — selection
// ---------------------------------------------------------------------------

function buildSelection(
  sortedSessions: readonly BatchBehaviorVerificationSessionInput[],
): BatchBehaviorVerificationSelection {
  const perFile = new Map<string, Set<string>>();
  for (const session of sortedSessions) {
    for (const file of session.changedFiles) {
      const set = perFile.get(file);
      if (set) {
        set.add(session.sessionId);
      } else {
        perFile.set(file, new Set([session.sessionId]));
      }
    }
  }
  const unioned = [...perFile.keys()].sort();
  const perFileSorted: Record<string, string[]> = {};
  for (const file of unioned) {
    const ids = [...(perFile.get(file) ?? new Set<string>())];
    ids.sort();
    perFileSorted[file] = ids;
  }
  return {
    unionedChangedFiles: unioned,
    sessionIdsInOrder: sortedSessions.map((s) => s.sessionId),
    perFileContributingSessions: perFileSorted,
  };
}

// ---------------------------------------------------------------------------
// Helpers — outcome mirror
// ---------------------------------------------------------------------------

function mirrorOutcome(
  verify: VerifyBehaviorResult,
): BatchBehaviorVerificationOutcome {
  if (verify.outcome === 'PASS') return 'PASS';
  if (verify.outcome === 'FAIL') return 'FAIL';
  return 'NOT_RUN';
}

// ---------------------------------------------------------------------------
// Helpers — failure linkage
// ---------------------------------------------------------------------------

interface BuildFailureLinkageArgs {
  readonly verifyResult: VerifyBehaviorResult;
  readonly sessions: readonly BatchBehaviorVerificationSessionInput[];
}

function buildFailureLinkage(
  args: BuildFailureLinkageArgs,
): BatchBehaviorFailureLinkage {
  if (args.verifyResult.outcome !== 'FAIL') {
    return { entries: [], unattributedFailureIds: [] };
  }
  const failing: readonly VerifyBehaviorFailingTest[] =
    args.verifyResult.evidence.failingTests;

  // Group failures by file (verbatim from the runner).
  const byFile = new Map<string, VerifyBehaviorFailingTest[]>();
  const unattributed: string[] = [];
  for (const failure of failing) {
    if (failure.file === null) {
      unattributed.push(failure.testId);
      continue;
    }
    const existing = byFile.get(failure.file);
    if (existing) {
      existing.push(failure);
    } else {
      byFile.set(failure.file, [failure]);
    }
  }
  unattributed.sort();

  const entries: BatchBehaviorFailureLinkageEntry[] = [];
  for (const [testFile] of byFile) {
    entries.push({
      testFile,
      candidateSessionIds: attributeSessionsForTest({
        testFile,
        verifyResult: args.verifyResult,
        sessions: args.sessions,
      }),
    });
  }
  entries.sort((a, b) => a.testFile.localeCompare(b.testFile));

  return {
    entries,
    unattributedFailureIds: unattributed,
  };
}

interface AttributeArgs {
  readonly testFile: string;
  readonly verifyResult: VerifyBehaviorResult;
  readonly sessions: readonly BatchBehaviorVerificationSessionInput[];
}

/**
 * Best-effort session attribution for a failing test file.
 *
 * Strategy:
 *   1. If the verifyBehavior selection ran the oracle and selected the test
 *      because it imports session changedFiles, we can be precise: every
 *      session whose changedFiles overlap with the unioned input qualifies.
 *      We can't, however, narrow to "this test imports session A's file
 *      specifically" without running the oracle per-session. We surface
 *      every overlapping session as a candidate — never silently fewer.
 *   2. If the test file equals one of a session's `changedFiles` directly
 *      (e.g. test edited together with source), we list that session.
 *   3. If neither applies (override path with no overlap), we leave the
 *      candidates list empty so the reviewer sees the test failed but no
 *      session-level link could be derived. We never invent attribution.
 */
function attributeSessionsForTest(args: AttributeArgs): string[] {
  const direct = new Set<string>();
  for (const session of args.sessions) {
    if (session.changedFiles.includes(args.testFile)) {
      direct.add(session.sessionId);
    }
  }
  if (direct.size > 0) {
    return [...direct].sort();
  }

  // Oracle path: when the wrapped result included an oracleResult that
  // selected this test (relevantTests covers it), attribute every session
  // whose changedFiles intersect the oracle input set. We cannot narrow
  // further without per-session re-runs of the oracle.
  const oracle = args.verifyResult.selection.oracleResult;
  if (oracle && oracle.relevantTests.includes(args.testFile)) {
    const allContributors = new Set<string>();
    for (const session of args.sessions) {
      if (session.changedFiles.length > 0) allContributors.add(session.sessionId);
    }
    return [...allContributors].sort();
  }

  return [];
}
