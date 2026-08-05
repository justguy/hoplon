import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import { deriveContractedChangesMap } from './contractedChanges.js';
import { SessionError } from './errors.js';
import { assertSessionState, cloneValue } from './internal.js';
import { clearOverlay } from './sessionOverlay.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { advanceSession } from './sessionStateMethods.js';

export async function revert(runtime: SessionRuntime): Promise<RevertResult> {
  assertSessionState(runtime.state, 'revert', ['audited_block']);
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'revert',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }
  const result = await runtime.engine.revertUncontracted({
    snapshotRefId: snapshotRef.id,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
  });
  await clearOverlay(runtime).catch(() => undefined);
  runtime.lastRevertResult = cloneValue(result);
  advanceSession(runtime, 'revert', 'reverted', {
    kind: 'revert',
    revertedCount: result.reverted.length,
    deletedCount: result.deleted.length,
    allowlistSkippedCount: result.allowlistSkipped.length,
  });
  return result;
}

export async function extractRollbackTemplate(
  runtime: SessionRuntime,
  opts?: {
    files?: readonly string[];
    contractedChangesMap?: Readonly<Record<string, string>>;
  },
): Promise<RollbackTemplate> {
  assertSessionState(runtime.state, 'extractRollbackTemplate', ['reverted']);
  const snapshotRef = runtime.snapshotRef;
  if (!snapshotRef) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'extractRollbackTemplate',
      detail: 'snapshotRef missing',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'snapshotRef',
      },
    });
  }
  const files = opts?.files ? [...opts.files] : [...runtime.changedFiles];
  if (files.length === 0) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: runtime.state,
      attempted: 'extractRollbackTemplate',
      detail: 'no files to extract (markEdited never called and no files override supplied)',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'changedFiles',
      },
    });
  }
  const defaultContractedChangesMap = deriveContractedChangesMap(
    runtime.manifest,
    files,
  );
  const contractedChangesMap = opts?.contractedChangesMap === undefined
    ? defaultContractedChangesMap
    : { ...defaultContractedChangesMap, ...opts.contractedChangesMap };
  const result = await runtime.engine.extractRollbackTemplate({
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    correlationId: runtime.correlationId,
    snapshotRefId: snapshotRef.id,
    files,
    contractedChangesMap,
  });
  runtime.lastRollbackTemplate = cloneValue(result);
  advanceSession(runtime, 'extractRollbackTemplate', 'rollback_extracted', {
    kind: 'extractRollbackTemplate',
    fileCount: result.files.length,
  });
  return result;
}
