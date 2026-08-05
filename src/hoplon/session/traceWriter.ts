/**
 * session/traceWriter.ts — writes ExecutionTrace / Attempt / ProofBundle /
 * DecisionProvenance rows for a Hoplon edit session (t-068).
 *
 * The session state machine owns the lifecycle; this module owns the
 * translation from session events to durable trace records. It is pure
 * glue: no state of its own, just deterministic id derivation and writes
 * to the injected TraceStore.
 *
 * Why the session is the natural writer:
 *   - the session already threads projectId/runId/correlationId/engineId
 *   - the session already has the baseline snapshotRef + AuditResult in
 *     memory when audit() returns
 *   - the session id is durable across multiple audit attempts within one
 *     execution, which lets us record retry visibility correctly
 *
 * What this writer does NOT do:
 *   - it does not change PASS/BLOCK semantics
 *   - it does not widen runtime defaults
 *   - it does not write to the H13-safe hoplon_audit_log
 *
 * Failures are swallowed after logging: trace writes are observability,
 * not enforcement. A failed trace write must never block a PASS or mask a
 * BLOCK. Callers may still pass a missing adapter (null) — in that case
 * the writer is a no-op.
 */

import { randomUUID } from 'node:crypto';
import type { TraceStore } from '../adapters/traceStore.js';
import type { AuditResult, AuditViolation } from '../contracts/audit.js';
import type { ExecutionStatus, ExecutionTrace } from '../contracts/executionTrace.js';
import type { Attempt, AttemptStatus } from '../contracts/attempt.js';
import type { ProofBundle, ProofViolation } from '../contracts/proofBundle.js';
import type { DecisionProvenance } from '../contracts/decisionProvenance.js';

/** Deterministic executionId derivation from a session id. */
export function deriveExecutionId(sessionId: string): string {
  return `exec_${sessionId}`;
}

export interface SessionTraceContext {
  sessionId: string;
  projectId: string;
  runId: string;
  engineId: string;
  correlationId: string;
  engineVersion: string;
  schemaVersion: number;
}

export interface SessionTraceWriter {
  openExecution(baselineSnapshotRef: string | null, now: string): Promise<string | null>;
  recordAttempt(opts: {
    attemptNumber: number;
    basedOnSnapshotRef: string;
    auditResult: AuditResult;
    auditRef: string | null;
    startedAt: string;
    completedAt: string;
  }): Promise<{ executionId: string; attemptId: string } | null>;
  closeExecution(finalStatus: ExecutionStatus, now: string): Promise<void>;
}

/**
 * Build a session trace writer. When `store` is null, returned writer is a
 * no-op — sessions that were constructed without a trace store still work,
 * they just do not produce durable trace records.
 */
export function createSessionTraceWriter(
  store: TraceStore | null,
  ctx: SessionTraceContext,
): SessionTraceWriter {
  if (store == null) {
    return {
      async openExecution() { return null; },
      async recordAttempt() { return null; },
      async closeExecution() { /* no-op */ },
    };
  }

  const liveStore: TraceStore = store;
  const executionId = deriveExecutionId(ctx.sessionId);

  async function openExecution(
    baselineSnapshotRef: string | null,
    now: string,
  ): Promise<string | null> {
    const trace: ExecutionTrace = {
      executionId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      engineId: ctx.engineId,
      correlationId: ctx.correlationId,
      planRef: null,
      baselineSnapshotRef,
      currentStatus: 'IN_PROGRESS',
      origin: 'session',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await liveStore.putExecution(trace);
      return executionId;
    } catch {
      // observability only; never block the session
      return null;
    }
  }

  async function recordAttempt(opts: {
    attemptNumber: number;
    basedOnSnapshotRef: string;
    auditResult: AuditResult;
    auditRef: string | null;
    startedAt: string;
    completedAt: string;
  }): Promise<{ executionId: string; attemptId: string } | null> {
    const attemptId = `att_${executionId}_${opts.attemptNumber}_${randomUUID()}`;
    const proofBundleRef = `proof_${attemptId}`;
    const status: AttemptStatus =
      opts.auditResult.status === 'PASS' ? 'PASS' : 'BLOCK';

    const violations = extractViolations(opts.auditResult);
    const nowIso = opts.completedAt;
    const pv: ProofViolation[] = violations.map((v, idx) => ({
      violationId: `vio_${attemptId}_${idx}`,
      proofBundleRef,
      attemptId,
      executionId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      kind: v.kind,
      path: 'path' in v ? v.path : null,
      symbolName: 'symbolName' in v && typeof v.symbolName === 'string' ? v.symbolName : null,
      nodeKind: 'nodeKind' in v && typeof v.nodeKind === 'string' ? v.nodeKind : null,
      byteRangeStart: 'byteRange' in v && Array.isArray(v.byteRange) ? v.byteRange[0] : null,
      byteRangeEnd: 'byteRange' in v && Array.isArray(v.byteRange) ? v.byteRange[1] : null,
      indexInBundle: idx,
      createdAt: nowIso,
    }));

    const bundle: ProofBundle = {
      proofBundleRef,
      attemptId,
      executionId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      snapshotRefBefore: opts.basedOnSnapshotRef,
      snapshotRefAfter: null,
      auditRef: opts.auditRef,
      violationRefs: pv.map((v) => v.violationId),
      manifestRef: null,
      engineVersion: ctx.engineVersion,
      engineId: ctx.engineId,
      schemaVersion: ctx.schemaVersion,
      correlationId: ctx.correlationId,
      auditResult: opts.auditResult,
      createdAt: nowIso,
    };

    const attempt: Attempt = {
      attemptId,
      executionId,
      attemptNumber: opts.attemptNumber,
      contractRef: null,
      basedOnSnapshotRef: opts.basedOnSnapshotRef,
      resultSnapshotRef: null,
      auditRef: opts.auditRef,
      proofBundleRef,
      status,
      actorType: 'session',
      actorRef: ctx.sessionId,
      repairPlanRef: null,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt,
    };

    const provenance: DecisionProvenance = {
      provenanceId: `prov_${attemptId}`,
      executionId,
      attemptId,
      category: 'hoplon_proved',
      summary: status === 'PASS'
        ? `Hoplon audit PASS on attempt ${opts.attemptNumber}`
        : `Hoplon audit BLOCK on attempt ${opts.attemptNumber} (${pv.length} violations)`,
      detail: {
        status,
        proofBundleRef,
        auditRef: opts.auditRef,
        violationCount: pv.length,
      },
      createdAt: nowIso,
    };

    try {
      await liveStore.putProofBundle(bundle, pv);
      await liveStore.appendAttempt(attempt);
      await liveStore.appendDecisionProvenance(provenance);
      await liveStore.updateExecution(executionId, {
        currentStatus: 'IN_PROGRESS',
        updatedAt: nowIso,
      });
      return { executionId, attemptId };
    } catch {
      // observability only; never block the session
      return null;
    }
  }

  async function closeExecution(finalStatus: ExecutionStatus, now: string): Promise<void> {
    try {
      await liveStore.updateExecution(executionId, { currentStatus: finalStatus, updatedAt: now });
    } catch {
      // observability only
    }
  }

  return { openExecution, recordAttempt, closeExecution };
}

function extractViolations(result: AuditResult): AuditViolation[] {
  return result.status === 'BLOCK' ? [...result.violations] : [];
}
