import type { WritableManifest } from '../contracts/manifest.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import type { AuditResult } from '../contracts/audit.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { RepairContext } from '../contracts/repairContext.js';
import { SessionError } from './errors.js';
import type { SessionSnapshot, SessionState, SessionTransition } from './types.js';

export interface SessionRuntimeState {
  sessionId: string;
  state: SessionState;
  manifest: WritableManifest;
  correlationId: string;
  snapshotRef: SnapshotRef | null;
  changedFiles: readonly string[];
  lastPreflightResult: PreflightResult | null;
  lastDryRunResult: AuditResult | null;
  lastAuditResult: AuditResult | null;
  lastRevertResult: RevertResult | null;
  lastRollbackTemplate: RollbackTemplate | null;
  priorRepairContext: RepairContext | null;
  nextAttemptNumber: number;
  history: readonly SessionTransition[];
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function buildSessionSnapshot(state: SessionRuntimeState): SessionSnapshot {
  return {
    sessionId: state.sessionId,
    state: state.state,
    manifest: cloneValue(state.manifest),
    correlationId: state.correlationId,
    projectId: state.manifest.projectId,
    runId: state.manifest.runId,
    engineId: state.snapshotRef?.engineId ?? 'local-0',
    snapshotRef: cloneValue(state.snapshotRef),
    changedFiles: [...state.changedFiles],
    lastPreflightResult: cloneValue(state.lastPreflightResult),
    lastDryRunResult: cloneValue(state.lastDryRunResult),
    lastAuditResult: cloneValue(state.lastAuditResult),
    lastRevertResult: cloneValue(state.lastRevertResult),
    lastRollbackTemplate: cloneValue(state.lastRollbackTemplate),
    priorRepairContext: cloneValue(state.priorRepairContext),
    nextAttemptNumber: state.nextAttemptNumber,
    history: cloneValue(state.history),
  };
}

export function recordTransition(
  history: SessionTransition[],
  transition: SessionTransition,
): void {
  history.push(cloneValue(transition));
}

export function assertSessionState(
  state: SessionState,
  op: string,
  allowed: readonly SessionState[],
): void {
  if (state === 'closed') {
    throw new SessionError({
      kind: 'session_closed',
      from: state,
      attempted: op,
      details: {
        recoveryClass: 'restart_session',
      },
    });
  }
  if (!allowed.includes(state)) {
    throw new SessionError({
      kind: 'invalid_state_transition',
      from: state,
      attempted: op,
      detail: `legal states: ${allowed.join(', ')}`,
      details: {
        recoveryClass: 'inspect_state',
        allowedStates: [...allowed],
      },
    });
  }
}

export function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `hoplon-session-${time}-${rand}`;
}
