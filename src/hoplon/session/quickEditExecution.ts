import type { AuditResult } from '../contracts/audit.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import { assertQuickEditInput, buildQuickEditSessionOptions } from './quickEditInput.js';
import type {
  QuickEditOptions,
  QuickEditResult,
  QuickEditSessionTrace,
} from './quickEditTypes.js';
import { createHoplonEditSession } from './session.js';
import type {
  ApplyEditsChangeKindCounts,
  ApplyEditsResult,
  HoplonEditSession,
} from './types.js';

const EMPTY_CHANGE_KIND_COUNTS: ApplyEditsChangeKindCounts = {
  full_file: 0,
  patch: 0,
  structural: 0,
};

function captureTrace(session: HoplonEditSession) {
  const snap = session.snapshot;
  return {
    sessionId: session.sessionId,
    finalState: session.state,
    history: snap.history,
    preflightResult: snap.lastPreflightResult,
    snapshotRef: snap.snapshotRef,
    changedFiles: snap.changedFiles,
  };
}

export async function quickEdit(opts: QuickEditOptions): Promise<QuickEditResult> {
  const { editMode, proposedChanges, markEditedFiles } = assertQuickEditInput(opts);
  const session = createHoplonEditSession(buildQuickEditSessionOptions(opts));
  const revertOnBlock = opts.revertOnBlock ?? true;
  const extractTemplateOnBlock = opts.extractRollbackTemplateOnBlock ?? true;

  let applyEditsResult: ApplyEditsResult | null = null;
  let auditResult: AuditResult | null = null;
  let revertResult: RevertResult | null = null;
  let rollbackTemplate: RollbackTemplate | null = null;

  function closeQuietly(): void {
    try {
      session.close();
    } catch {
      // Preserve the primary phase outcome if a future close implementation throws.
    }
  }

  function buildTrace(): QuickEditSessionTrace {
    return { ...captureTrace(session), applyEdits: applyEditsResult };
  }

  try {
    await session.preflight();
  } catch (err) {
    closeQuietly();
    return {
      outcome: 'failed',
      phase: 'preflight',
      error: err,
      auditResult,
      revertResult,
      rollbackTemplate,
      ...buildTrace(),
    };
  }

  const preflightResult = session.snapshot.lastPreflightResult;
  if (preflightResult && preflightResult.status === 'BLOCK') {
    closeQuietly();
    return {
      ...buildTrace(),
      outcome: 'block',
      phase: 'preflight',
      preflightResult,
    };
  }

  try {
    await session.createSnapshot();
  } catch (err) {
    closeQuietly();
    return {
      outcome: 'failed',
      phase: 'createSnapshot',
      error: err,
      auditResult,
      revertResult,
      rollbackTemplate,
      ...buildTrace(),
    };
  }

  if (editMode === 'applyEdits') {
    try {
      applyEditsResult = await session.applyEdits(proposedChanges);
    } catch (err) {
      closeQuietly();
      return {
        outcome: 'failed',
        phase: 'applyEdits',
        error: err,
        auditResult,
        revertResult,
        rollbackTemplate,
        ...buildTrace(),
      };
    }
  } else {
    try {
      const markEditedResult = await session.markEdited(markEditedFiles);
      applyEditsResult = {
        changedFiles: markEditedResult.changedFiles,
        bytesWritten: 0,
        changeKindCounts: EMPTY_CHANGE_KIND_COUNTS,
        overlayRefresh: markEditedResult.overlayRefresh,
      };
    } catch (err) {
      closeQuietly();
      return {
        outcome: 'failed',
        phase: 'markEdited',
        error: err,
        auditResult,
        revertResult,
        rollbackTemplate,
        ...buildTrace(),
      };
    }
  }

  try {
    auditResult = await session.audit();
  } catch (err) {
    closeQuietly();
    return {
      outcome: 'failed',
      phase: 'audit',
      error: err,
      auditResult,
      revertResult,
      rollbackTemplate,
      ...buildTrace(),
    };
  }

  if (auditResult.status === 'PASS') {
    closeQuietly();
    return { outcome: 'pass', auditResult, ...buildTrace() };
  }

  if (revertOnBlock) {
    try {
      revertResult = await session.revert();
    } catch (err) {
      closeQuietly();
      return {
        outcome: 'failed',
        phase: 'revert',
        error: err,
        auditResult,
        revertResult,
        rollbackTemplate,
        ...buildTrace(),
      };
    }

    if (extractTemplateOnBlock) {
      try {
        rollbackTemplate = await session.extractRollbackTemplate();
      } catch (err) {
        closeQuietly();
        return {
          outcome: 'failed',
          phase: 'extractRollbackTemplate',
          error: err,
          auditResult,
          revertResult,
          rollbackTemplate,
          ...buildTrace(),
        };
      }
    }
  }

  try {
    session.close();
  } catch (err) {
    return {
      outcome: 'failed',
      phase: 'close',
      error: err,
      auditResult,
      revertResult,
      rollbackTemplate,
      ...buildTrace(),
    };
  }

  return {
    outcome: 'block',
    phase: 'audit',
    auditResult,
    revertResult,
    rollbackTemplate,
    ...buildTrace(),
  };
}
