import type { DeclarativeInvariantBinding } from '../contracts/invariantBinding.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { ProposedChange } from '../contracts/requests.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import { SessionError } from './errors.js';
import { assertSessionState, cloneValue, recordTransition } from './internal.js';
import {
  documentsFromProposedChanges,
  refreshOverlay,
  touchedFilesFromChanges,
} from './sessionOverlay.js';
import {
  resetSessionTraceWriter,
} from './sessionRuntime.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { hydrateStagedContent } from './sessionStagedContent.js';
import type {
  DryRunResult,
  SessionState,
  SessionTransition,
} from './types.js';

export function advanceSession(
  runtime: SessionRuntime,
  op: SessionTransition['op'],
  toState: SessionState,
  outcome?: SessionTransition['outcome'],
): void {
  recordTransition(runtime.history, {
    op,
    fromState: runtime.state,
    toState,
    timestampMs: runtime.now(),
    ...(outcome !== undefined ? { outcome } : {}),
  });
  runtime.state = toState;
}

export async function preflight(
  runtime: SessionRuntime,
): Promise<PreflightResult> {
  assertSessionState(runtime.state, 'preflight', ['created']);
  const result = await runtime.engine.preflight({
    manifest: runtime.manifest,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
  });
  runtime.lastPreflightResult = cloneValue(result);
  const violationCount = result.gates.reduce(
    (sum, gate) => sum + gate.violations.length,
    0,
  );
  const nextState: SessionState =
    result.status === 'PASS' ? 'preflighted_pass' : 'preflighted_block';
  advanceSession(runtime, 'preflight', nextState, {
    kind: 'preflight',
    status: result.status,
    violationCount,
  });
  return result;
}

export async function createSnapshot(
  runtime: SessionRuntime,
): Promise<SnapshotRef> {
  if (runtime.state === 'preflighted_block') {
    throw new SessionError({
      kind: 'preflight_not_passed',
      from: runtime.state,
      attempted: 'createSnapshot',
      details: { recoveryClass: 'inspect_state' },
    });
  }
  assertSessionState(runtime.state, 'createSnapshot', ['preflighted_pass']);
  const result = await runtime.engine.createSnapshot({
    manifest: runtime.manifest,
  });
  runtime.snapshotRef = cloneValue(result.snapshotRef);
  runtime.traceEngineId = result.snapshotRef.engineId;
  resetSessionTraceWriter(runtime);
  advanceSession(runtime, 'createSnapshot', 'snapshotted', {
    kind: 'createSnapshot',
    snapshotRefId: result.snapshotRef.id,
  });
  if (!runtime.traceOpened) {
    runtime.traceExecutionId = await runtime.traceWriter.openExecution(
      result.snapshotRef.id,
      new Date(runtime.now()).toISOString(),
    );
    runtime.traceOpened = true;
  }
  return result.snapshotRef;
}

export async function dryRun(
  runtime: SessionRuntime,
  proposedChanges: readonly ProposedChange[],
  opts?: { invariantBindings?: readonly DeclarativeInvariantBinding[] },
): Promise<DryRunResult> {
  assertSessionState(runtime.state, 'dryRun', ['snapshotted']);
  if (proposedChanges.length === 0) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'dryRun',
      detail: 'proposedChanges must not be empty',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'proposedChanges',
      },
    });
  }
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'dryRun',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }
  const hydrated = hydrateStagedContent(runtime, proposedChanges, 'dryRun');
  const result = await runtime.engine.dryRun({
    snapshotRefId: snapshotRef.id,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
    proposedChanges: [...hydrated.proposedChanges],
    ...(opts?.invariantBindings !== undefined
      ? { invariantBindings: [...opts.invariantBindings] }
      : {}),
  });
  await refreshOverlay(runtime, {
    mode: 'dry_run',
    inputSource: 'proposed_changes',
    touchedFiles: touchedFilesFromChanges(hydrated.proposedChanges),
    documents: documentsFromProposedChanges(
      runtime,
      hydrated.proposedChanges,
      'dry_run',
    ),
  });
  runtime.lastDryRunResult = cloneValue(result);
  const violationCount = result.status === 'BLOCK' ? result.violations.length : 0;
  recordTransition(runtime.history, {
    op: 'dryRun',
    fromState: runtime.state,
    toState: runtime.state,
    timestampMs: runtime.now(),
    outcome: { kind: 'dryRun', status: result.status, violationCount },
  });
  return result;
}
