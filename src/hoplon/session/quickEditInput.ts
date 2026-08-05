import type { ProposedChange } from '../contracts/requests.js';
import { SessionError } from './errors.js';
import type { QuickEditOptions } from './quickEditTypes.js';
import type { CreateHoplonEditSessionOptions } from './types.js';

export interface ValidatedQuickEditInput {
  editMode: 'applyEdits' | 'markEdited';
  proposedChanges: readonly ProposedChange[];
  markEditedFiles: readonly string[];
}

export function assertQuickEditInput(
  opts: QuickEditOptions,
): ValidatedQuickEditInput {
  const editMode = opts.editMode ?? 'applyEdits';
  if (editMode === 'applyEdits') {
    if (!opts.proposedChanges || opts.proposedChanges.length === 0) {
      throw new SessionError(
        {
          kind: 'missing_prerequisite',
          from: 'created',
          attempted: 'quickEdit',
          detail: 'proposedChanges must be non-empty when editMode is applyEdits',
          details: {
            recoveryClass: 'check_prerequisites',
            prerequisite: 'proposedChanges',
          },
        },
        'Hoplon quickEdit: proposedChanges must be non-empty for applyEdits editMode',
      );
    }
    if (opts.markEditedFiles !== undefined && opts.markEditedFiles.length > 0) {
      throw new SessionError(
        {
          kind: 'missing_prerequisite',
          from: 'created',
          attempted: 'quickEdit',
          detail: 'markEditedFiles must be omitted when editMode is applyEdits',
          details: {
            recoveryClass: 'check_prerequisites',
            prerequisite: 'editMode',
          },
        },
        'Hoplon quickEdit: markEditedFiles ignored under applyEdits editMode; pass editMode=markEdited if you intend the compatibility path',
      );
    }
    return {
      editMode,
      proposedChanges: opts.proposedChanges,
      markEditedFiles: [],
    };
  }
  if (!opts.markEditedFiles) {
    throw new SessionError(
      {
        kind: 'missing_prerequisite',
        from: 'created',
        attempted: 'quickEdit',
        detail: 'markEditedFiles must be supplied when editMode is markEdited',
        details: {
          recoveryClass: 'check_prerequisites',
          prerequisite: 'markEditedFiles',
        },
      },
      'Hoplon quickEdit: markEditedFiles must be supplied for markEdited editMode',
    );
  }
  if (opts.proposedChanges !== undefined && opts.proposedChanges.length > 0) {
    throw new SessionError(
      {
        kind: 'missing_prerequisite',
        from: 'created',
        attempted: 'quickEdit',
        detail: 'proposedChanges must be omitted when editMode is markEdited',
        details: {
          recoveryClass: 'check_prerequisites',
          prerequisite: 'editMode',
        },
      },
      'Hoplon quickEdit: proposedChanges ignored under markEdited editMode; pass editMode=applyEdits if you intend the Hoplon-owned write path',
    );
  }
  return {
    editMode,
    proposedChanges: [],
    markEditedFiles: opts.markEditedFiles,
  };
}

export function buildQuickEditSessionOptions(
  opts: QuickEditOptions,
): CreateHoplonEditSessionOptions {
  return {
    engine: opts.engine,
    manifest: opts.manifest,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
    ...(opts.codeIntelligence !== undefined
      ? { codeIntelligence: opts.codeIntelligence }
      : {}),
    ...(opts.behaviorTestRunner !== undefined
      ? { behaviorTestRunner: opts.behaviorTestRunner }
      : {}),
    ...(opts.lockProvider !== undefined ? { lockProvider: opts.lockProvider } : {}),
    ...(opts.staging !== undefined ? { staging: opts.staging } : {}),
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
    ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
    ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
    ...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
    ...(opts.priorRepairContext !== undefined
      ? { priorRepairContext: opts.priorRepairContext }
      : {}),
    ...(opts.versioning !== undefined ? { versioning: opts.versioning } : {}),
    ...(opts.snapshotStore !== undefined ? { snapshotStore: opts.snapshotStore } : {}),
    ...(opts.gitRepoDir !== undefined ? { gitRepoDir: opts.gitRepoDir } : {}),
    ...(opts.revertAllowlist !== undefined
      ? { revertAllowlist: opts.revertAllowlist }
      : {}),
  };
}
