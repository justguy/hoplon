import type { ProposedChange } from '../contracts/requests.js';
import { performApplyEdits } from './applyEdits.js';
import { assertSessionState } from './internal.js';
import {
  documentsFromLiveFiles,
  refreshOverlay,
} from './sessionOverlay.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { hydrateStagedContent } from './sessionStagedContent.js';
import { advanceSession } from './sessionStateMethods.js';
import type { ApplyEditsResult, MarkEditedResult } from './types.js';

export async function applyEdits(
  runtime: SessionRuntime,
  proposedChanges: readonly ProposedChange[],
): Promise<ApplyEditsResult> {
  assertSessionState(runtime.state, 'applyEdits', ['snapshotted']);
  const hydrated = hydrateStagedContent(runtime, proposedChanges, 'applyEdits');
  const result = await performApplyEdits({
    fs: runtime.fs,
    proposedChanges: hydrated.proposedChanges,
    fromState: runtime.state,
    codeIntelligence: runtime.codeIntelligence,
    lockProvider: runtime.lockProvider,
    projectId: runtime.manifest.projectId,
  });
  for (const stagingKey of hydrated.stagedKeys) {
    runtime.stagingStore.discard(stagingKey);
  }
  runtime.changedFiles = result.changedFiles;
  runtime.capturedBeforeBytes = result.capturedBeforeBytes;
  runtime.lastApplyEditsChangeKindCounts = { ...result.changeKindCounts };
  const overlayRefresh = await refreshOverlay(runtime, {
    mode: 'written_bytes',
    inputSource: 'written_bytes',
    touchedFiles: result.changedFiles,
    documents: await documentsFromLiveFiles(
      runtime,
      result.changedFiles,
      'written_bytes',
    ),
  });
  advanceSession(runtime, 'applyEdits', 'edited', {
    kind: 'applyEdits',
    changedFileCount: result.changedFiles.length,
    bytesWritten: result.bytesWritten,
    changeKindCounts: { ...result.changeKindCounts },
  });
  return {
    changedFiles: result.changedFiles,
    bytesWritten: result.bytesWritten,
    changeKindCounts: result.changeKindCounts,
    overlayRefresh,
  };
}

export async function markEdited(
  runtime: SessionRuntime,
  files: readonly string[],
): Promise<MarkEditedResult> {
  assertSessionState(runtime.state, 'markEdited', ['snapshotted']);
  runtime.changedFiles = [...files];
  runtime.capturedBeforeBytes = null;
  runtime.lastApplyEditsChangeKindCounts = null;
  const overlayRefresh = await refreshOverlay(runtime, {
    mode: 'written_bytes',
    inputSource: runtime.fs === null ? 'failure_mask' : 'live_files',
    touchedFiles: runtime.changedFiles,
    documents: await documentsFromLiveFiles(
      runtime,
      runtime.changedFiles,
      'written_bytes',
    ),
    ...(runtime.fs === null
      ? {
          status: 'UNAVAILABLE' as const,
          degradationReasons: ['overlay_refresh_failed' as const],
        }
      : {}),
  });
  advanceSession(runtime, 'markEdited', 'edited', {
    kind: 'markEdited',
    changedFileCount: runtime.changedFiles.length,
  });
  return { changedFiles: runtime.changedFiles, overlayRefresh };
}
