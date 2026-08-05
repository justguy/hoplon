/**
 * adapters/trace-store-memory.ts — in-process TraceStore (t-068).
 *
 * Map-backed adapter for tests and local default use. No persistence, no
 * cross-process visibility. Behavior contract mirrors the other
 * implementations: idempotent puts, append-only attempts/provenance,
 * writer-supplied monotonic attemptNumber ordering, blocked attempts stay
 * visible.
 */

import type {
  TraceExportBundle,
  TraceSearchFilters,
  TraceStore,
} from './traceStore.js';
import type { ExecutionStatus, ExecutionTrace } from '../contracts/executionTrace.js';
import type { Attempt } from '../contracts/attempt.js';
import type { ProofBundle, ProofViolation } from '../contracts/proofBundle.js';
import type { DecisionProvenance } from '../contracts/decisionProvenance.js';

const TRACE_EXPORT_SCHEMA_VERSION = 1;

interface State {
  executions: Map<string, ExecutionTrace>;
  attempts: Map<string, Attempt>;
  attemptsByExecution: Map<string, string[]>;
  proofBundles: Map<string, ProofBundle>;
  proofBundlesByExecution: Map<string, string[]>;
  violations: Map<string, ProofViolation>;
  violationsByBundle: Map<string, string[]>;
  provenance: DecisionProvenance[];
}

function emptyState(): State {
  return {
    executions: new Map(),
    attempts: new Map(),
    attemptsByExecution: new Map(),
    proofBundles: new Map(),
    proofBundlesByExecution: new Map(),
    violations: new Map(),
    violationsByBundle: new Map(),
    provenance: [],
  };
}

function sortByCreatedAt<T extends { createdAt: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function matchesExecution(
  trace: ExecutionTrace,
  filters: TraceSearchFilters,
): boolean {
  if (filters.projectId !== undefined && trace.projectId !== filters.projectId) return false;
  if (filters.runId !== undefined && trace.runId !== filters.runId) return false;
  if (filters.status !== undefined && trace.currentStatus !== filters.status) return false;
  if (filters.snapshotRef !== undefined && trace.baselineSnapshotRef !== filters.snapshotRef) return false;
  if (filters.createdAfter !== undefined && trace.createdAt < filters.createdAfter) return false;
  return true;
}

export function createInMemoryTraceStore(): TraceStore {
  const state = emptyState();

  function attemptIdsFor(executionId: string): string[] {
    return state.attemptsByExecution.get(executionId) ?? [];
  }

  async function putExecution(trace: ExecutionTrace): Promise<void> {
    if (state.executions.has(trace.executionId)) return; // idempotent
    state.executions.set(trace.executionId, { ...trace });
  }

  async function updateExecution(
    executionId: string,
    patch: { currentStatus: ExecutionStatus; updatedAt: string },
  ): Promise<void> {
    const existing = state.executions.get(executionId);
    if (!existing) return;
    state.executions.set(executionId, {
      ...existing,
      currentStatus: patch.currentStatus,
      updatedAt: patch.updatedAt,
    });
  }

  async function getExecution(executionId: string): Promise<ExecutionTrace | null> {
    const row = state.executions.get(executionId);
    return row ? { ...row } : null;
  }

  async function listExecutions(filters: TraceSearchFilters): Promise<ExecutionTrace[]> {
    const rows = Array.from(state.executions.values()).filter((t) => matchesExecution(t, filters));
    return sortByCreatedAt(rows).map((t) => ({ ...t }));
  }

  async function appendAttempt(attempt: Attempt): Promise<void> {
    if (state.attempts.has(attempt.attemptId)) return; // idempotent
    state.attempts.set(attempt.attemptId, { ...attempt });
    const bucket = state.attemptsByExecution.get(attempt.executionId) ?? [];
    bucket.push(attempt.attemptId);
    state.attemptsByExecution.set(attempt.executionId, bucket);
  }

  async function getAttempt(attemptId: string): Promise<Attempt | null> {
    const row = state.attempts.get(attemptId);
    return row ? { ...row } : null;
  }

  async function listAttempts(executionId: string): Promise<Attempt[]> {
    const ids = attemptIdsFor(executionId);
    const rows = ids
      .map((id) => state.attempts.get(id))
      .filter((a): a is Attempt => a !== undefined);
    return rows
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((a) => ({ ...a }));
  }

  async function putProofBundle(bundle: ProofBundle, violations: ProofViolation[]): Promise<void> {
    if (state.proofBundles.has(bundle.proofBundleRef)) return; // idempotent
    state.proofBundles.set(bundle.proofBundleRef, { ...bundle });
    const bucket = state.proofBundlesByExecution.get(bundle.executionId) ?? [];
    bucket.push(bundle.proofBundleRef);
    state.proofBundlesByExecution.set(bundle.executionId, bucket);
    const vIds: string[] = [];
    for (const v of violations) {
      if (state.violations.has(v.violationId)) continue;
      state.violations.set(v.violationId, { ...v });
      vIds.push(v.violationId);
    }
    state.violationsByBundle.set(bundle.proofBundleRef, vIds);
  }

  async function getProofBundle(proofBundleRef: string): Promise<ProofBundle | null> {
    const row = state.proofBundles.get(proofBundleRef);
    return row ? { ...row } : null;
  }

  async function listProofBundles(executionId: string): Promise<ProofBundle[]> {
    const ids = state.proofBundlesByExecution.get(executionId) ?? [];
    const rows = ids
      .map((id) => state.proofBundles.get(id))
      .filter((b): b is ProofBundle => b !== undefined);
    return sortByCreatedAt(rows).map((b) => ({ ...b }));
  }

  async function getViolation(violationId: string): Promise<ProofViolation | null> {
    const row = state.violations.get(violationId);
    return row ? { ...row } : null;
  }

  async function listViolations(proofBundleRef: string): Promise<ProofViolation[]> {
    const ids = state.violationsByBundle.get(proofBundleRef) ?? [];
    const rows = ids
      .map((id) => state.violations.get(id))
      .filter((v): v is ProofViolation => v !== undefined);
    return sortByCreatedAt(rows).map((v) => ({ ...v }));
  }

  async function appendDecisionProvenance(record: DecisionProvenance): Promise<void> {
    if (state.provenance.some((p) => p.provenanceId === record.provenanceId)) return;
    state.provenance.push({ ...record });
  }

  async function listProvenance(executionId: string): Promise<DecisionProvenance[]> {
    const rows = state.provenance.filter((p) => p.executionId === executionId);
    return sortByCreatedAt(rows).map((p) => ({ ...p }));
  }

  async function searchAttempts(filters: TraceSearchFilters): Promise<Attempt[]> {
    const all = Array.from(state.attempts.values());
    let result = all;
    if (filters.projectId !== undefined) {
      const allowed = new Set(
        Array.from(state.executions.values())
          .filter((t) => t.projectId === filters.projectId)
          .map((t) => t.executionId),
      );
      result = result.filter((a) => allowed.has(a.executionId));
    }
    if (filters.runId !== undefined) {
      const allowed = new Set(
        Array.from(state.executions.values())
          .filter((t) => t.runId === filters.runId)
          .map((t) => t.executionId),
      );
      result = result.filter((a) => allowed.has(a.executionId));
    }
    if (filters.status !== undefined) {
      result = result.filter((a) => a.status === filters.status);
    }
    if (filters.auditRef !== undefined) {
      result = result.filter((a) => a.auditRef === filters.auditRef);
    }
    if (filters.snapshotRef !== undefined) {
      result = result.filter(
        (a) => a.basedOnSnapshotRef === filters.snapshotRef || a.resultSnapshotRef === filters.snapshotRef,
      );
    }
    if (filters.path !== undefined) {
      const bundleRefs = new Set(
        Array.from(state.violations.values())
          .filter((v) => v.path === filters.path)
          .map((v) => v.proofBundleRef),
      );
      const attemptIdsWithPath = new Set(
        Array.from(state.proofBundles.values())
          .filter((b) => bundleRefs.has(b.proofBundleRef))
          .map((b) => b.attemptId),
      );
      result = result.filter((a) => attemptIdsWithPath.has(a.attemptId));
    }
    if (filters.createdAfter !== undefined) {
      result = result.filter((a) => a.startedAt >= filters.createdAfter!);
    }
    return result
      .slice()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((a) => ({ ...a }));
  }

  async function exportExecution(executionId: string): Promise<TraceExportBundle | null> {
    const execution = await getExecution(executionId);
    if (!execution) return null;
    const attempts = await listAttempts(executionId);
    const proofBundles = await listProofBundles(executionId);
    const violations: ProofViolation[] = [];
    for (const b of proofBundles) {
      const vs = await listViolations(b.proofBundleRef);
      violations.push(...vs);
    }
    const provenance = await listProvenance(executionId);
    return {
      execution,
      attempts,
      proofBundles,
      violations,
      provenance,
      exportedAt: new Date().toISOString(),
      schemaVersion: TRACE_EXPORT_SCHEMA_VERSION,
    };
  }

  return {
    putExecution,
    updateExecution,
    getExecution,
    listExecutions,
    appendAttempt,
    getAttempt,
    listAttempts,
    putProofBundle,
    getProofBundle,
    listProofBundles,
    getViolation,
    listViolations,
    appendDecisionProvenance,
    listProvenance,
    searchAttempts,
    exportExecution,
  };
}
