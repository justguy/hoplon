import type { AuditResult } from '../contracts/audit.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { ProposedChange } from '../contracts/requests.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import type {
  ApplyEditsResult,
  CreateHoplonEditSessionOptions,
  SessionState,
  SessionTransition,
} from './types.js';

export type QuickEditPhase =
  | 'preflight'
  | 'createSnapshot'
  | 'applyEdits'
  | 'markEdited'
  | 'audit'
  | 'revert'
  | 'extractRollbackTemplate'
  | 'close';

export interface QuickEditOptions extends CreateHoplonEditSessionOptions {
  proposedChanges?: readonly ProposedChange[];
  editMode?: 'applyEdits' | 'markEdited';
  markEditedFiles?: readonly string[];
  revertOnBlock?: boolean;
  extractRollbackTemplateOnBlock?: boolean;
}

export interface QuickEditSessionTrace {
  readonly sessionId: string;
  readonly finalState: SessionState;
  readonly history: readonly SessionTransition[];
  readonly preflightResult: PreflightResult | null;
  readonly snapshotRef: SnapshotRef | null;
  readonly changedFiles: readonly string[];
  readonly applyEdits: ApplyEditsResult | null;
}

export type QuickEditResult =
  | QuickEditPassResult
  | QuickEditBlockResult
  | QuickEditFailureResult;

export interface QuickEditPassResult extends QuickEditSessionTrace {
  readonly outcome: 'pass';
  readonly auditResult: AuditResult;
}

export type QuickEditBlockResult =
  | QuickEditPreflightBlockResult
  | QuickEditAuditBlockResult;

export interface QuickEditPreflightBlockResult extends QuickEditSessionTrace {
  readonly outcome: 'block';
  readonly phase: 'preflight';
  readonly preflightResult: PreflightResult;
}

export interface QuickEditAuditBlockResult extends QuickEditSessionTrace {
  readonly outcome: 'block';
  readonly phase: 'audit';
  readonly auditResult: AuditResult;
  readonly revertResult: RevertResult | null;
  readonly rollbackTemplate: RollbackTemplate | null;
}

export interface QuickEditFailureResult extends QuickEditSessionTrace {
  readonly outcome: 'failed';
  readonly phase: QuickEditPhase;
  readonly error: unknown;
  readonly auditResult: AuditResult | null;
  readonly revertResult: RevertResult | null;
  readonly rollbackTemplate: RollbackTemplate | null;
}
