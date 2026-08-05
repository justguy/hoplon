import type { ProposedChange } from '../contracts/requests.js';
import type {
  GetReviewPayloadOptions,
  SessionReviewPayload,
} from '../contracts/reviewPayload.js';
import type {
  VerifyBehaviorOptions,
  VerifyBehaviorResult,
} from '../contracts/verifyBehavior.js';
import { SessionError } from './errors.js';
import { cloneValue } from './internal.js';
import { buildSessionReviewPayload } from './reviewPayload.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { hydrateStagedContent } from './sessionStagedContent.js';
import { composeVerifyBehaviorResult } from './verifyBehavior.js';

export async function getReviewPayload(
  runtime: SessionRuntime,
  opts?: GetReviewPayloadOptions,
): Promise<SessionReviewPayload> {
  const phase = opts?.phase ?? 'post-edit';
  const contextLines = opts?.contextLines ?? 3;
  const includeDependencyImpact = opts?.includeDependencyImpact ?? false;
  const includeViolationRisk = opts?.includeViolationRisk ?? false;
  const includeRelevantTests = opts?.includeRelevantTests ?? false;
  const includePostEditPolicyScan = opts?.includePostEditPolicyScan ?? false;
  if (phase === 'preview' && runtime.state !== 'snapshotted') {
    throw new SessionError({
      kind: 'invalid_state_transition',
      from: runtime.state,
      attempted: 'getReviewPayload',
      detail: 'preview review payload is only legal from state=snapshotted',
      details: {
        recoveryClass: 'inspect_state',
        allowedStates: ['snapshotted'],
      },
    });
  }
  if (
    phase === 'post-edit' &&
    runtime.state !== 'snapshotted' &&
    runtime.state !== 'edited' &&
    runtime.state !== 'audited_pass' &&
    runtime.state !== 'audited_block'
  ) {
    throw new SessionError({
      kind: 'invalid_state_transition',
      from: runtime.state,
      attempted: 'getReviewPayload',
      detail:
        'post-edit review payload is only legal from state=snapshotted, edited, audited_pass, or audited_block',
      details: {
        recoveryClass: 'inspect_state',
        allowedStates: ['snapshotted', 'edited', 'audited_pass', 'audited_block'],
      },
    });
  }
  const proposedChanges = (opts?.proposedChanges ?? []) as readonly ProposedChange[];
  if (phase === 'preview' && proposedChanges.length === 0) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'getReviewPayload',
      detail: 'preview phase requires proposedChanges',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'proposedChanges',
      },
    });
  }
  const previewChanges = phase === 'preview'
    ? hydrateStagedContent(
        runtime,
        proposedChanges,
        'getReviewPayload',
      ).proposedChanges
    : proposedChanges;
  return buildSessionReviewPayload({
    sessionId: runtime.sessionId,
    state: runtime.state,
    phase,
    contextLines,
    generatedAtIso: new Date(runtime.now()).toISOString(),
    changedFiles: runtime.changedFiles,
    snapshotScopePaths: [
      ...new Set(runtime.manifest.entries.map((entry) => entry.path)),
    ].sort(),
    applyEditsChangeKindCounts: runtime.lastApplyEditsChangeKindCounts,
    fs: runtime.fs,
    codeIntelligence: runtime.codeIntelligence,
    capturedBeforeBytes: runtime.capturedBeforeBytes,
    ...(phase === 'preview' ? { proposedChanges: previewChanges } : {}),
    includeDependencyImpact,
    includeViolationRisk,
    includeRelevantTests,
    includePostEditPolicyScan,
    postEditPolicyScanner: runtime.postEditPolicyScanner,
    ...(opts?.dependencyImpactWarnThreshold !== undefined
      ? { dependencyImpactWarnThreshold: opts.dependencyImpactWarnThreshold }
      : {}),
    ...(opts?.dependencyImpactPrecomputedChangedFiles !== undefined
      ? {
          dependencyImpactPrecomputedChangedFiles: [
            ...opts.dependencyImpactPrecomputedChangedFiles,
          ],
        }
      : {}),
    engine: runtime.engine,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
  });
}

export async function verifyBehavior(
  runtime: SessionRuntime,
  verifyOpts?: VerifyBehaviorOptions,
): Promise<VerifyBehaviorResult> {
  const options: VerifyBehaviorOptions = verifyOpts ?? {};
  const result = await composeVerifyBehaviorResult({
    engine: runtime.engine,
    runner: runtime.behaviorTestRunner,
    options,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
    projectRoot: runtime.projectRoot ?? '',
    sessionId: runtime.sessionId,
    snapshotRefId: runtime.snapshotRef?.id ?? null,
    changedFiles: [...runtime.changedFiles],
    attemptNumber: runtime.lastAuditResult ? runtime.attemptCounter : null,
    now: runtime.now,
  });
  runtime.lastVerifyBehaviorResult = cloneValue(result);
  return result;
}
