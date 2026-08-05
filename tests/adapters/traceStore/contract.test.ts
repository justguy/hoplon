/**
 * tests/adapters/traceStore/contract.test.ts — parametric contract tests
 * for TraceStore (t-068).
 *
 * The same test body runs against three adapters: in-memory, SQLite (sql.js),
 * and Postgres (pg-mem). This is the single source of truth for the
 * TraceStore contract: idempotent puts, append-only attempts, monotonic
 * attemptNumber, blocked-attempts-stay-visible, raw proof round-trip, and
 * search filters (status, auditRef, snapshotRef, path, project/run,
 * createdAfter).
 */

import { describe, it, expect } from 'vitest';

import { createInMemoryTraceStore } from '../../../src/hoplon/adapters/trace-store-memory.js';
import { createInMemorySqliteTraceStore } from '../../../src/hoplon/adapters/trace-store-sqlite.js';
import { createIsolatedPgTestTraceStore } from '../../../src/hoplon/adapters/traceStore/postgres.js';
import type { TraceStore } from '../../../src/hoplon/adapters/traceStore.js';
import type { ExecutionTrace } from '../../../src/hoplon/contracts/executionTrace.js';
import type { Attempt } from '../../../src/hoplon/contracts/attempt.js';
import type {
  ProofBundle,
  ProofViolation,
} from '../../../src/hoplon/contracts/proofBundle.js';
import type { DecisionProvenance } from '../../../src/hoplon/contracts/decisionProvenance.js';
import type { AuditResult } from '../../../src/hoplon/contracts/audit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = 'proj-trace';
const RUN = 'run-trace-1';
const CORR = 'corr-trace-1';
const ENGINE = 'session';
const ENGINE_VERSION = '1.0.0';
const SNAPSHOT_REF = 'sha256:aaaa';

function makeExecution(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    executionId: 'exec_sess-1',
    projectId: PROJECT,
    runId: RUN,
    engineId: ENGINE,
    correlationId: CORR,
    planRef: null,
    baselineSnapshotRef: SNAPSHOT_REF,
    currentStatus: 'IN_PROGRESS',
    origin: 'session',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

const PASS_AUDIT: AuditResult = {
  status: 'PASS',
  correlationId: CORR,
  checked: 1,
  auditSchemaVersion: 1,
};

const BLOCK_AUDIT: AuditResult = {
  status: 'BLOCK',
  correlationId: CORR,
  auditSchemaVersion: 1,
  violations: [
    {
      kind: 'uncontracted_file',
      path: 'src/forbidden.ts',
      firstChangedLine: 0,
      sourceSlice: '',
      message: 'uncontracted mutation',
      correction: 'revert file',
    },
  ],
};

interface AttemptBundle {
  attempt: Attempt;
  bundle: ProofBundle;
  violations: ProofViolation[];
  provenance: DecisionProvenance;
}

function makeAttemptBundle(opts: {
  executionId: string;
  attemptNumber: number;
  status: 'PASS' | 'BLOCK';
  at: string;
  auditRef?: string | null;
  path?: string | null;
}): AttemptBundle {
  const { executionId, attemptNumber, status, at } = opts;
  const attemptId = `att_${executionId}_${attemptNumber}`;
  const proofBundleRef = `proof_${attemptId}`;
  const auditRef = opts.auditRef ?? null;
  const auditResult: AuditResult = status === 'PASS' ? PASS_AUDIT : BLOCK_AUDIT;
  const violations: ProofViolation[] = status === 'BLOCK'
    ? [
        {
          violationId: `vio_${attemptId}_0`,
          proofBundleRef,
          attemptId,
          executionId,
          projectId: PROJECT,
          runId: RUN,
          kind: 'uncontracted_file',
          path: opts.path ?? 'src/forbidden.ts',
          symbolName: null,
          nodeKind: null,
          byteRangeStart: null,
          byteRangeEnd: null,
          indexInBundle: 0,
          createdAt: at,
        },
      ]
    : [];
  const bundle: ProofBundle = {
    proofBundleRef,
    attemptId,
    executionId,
    projectId: PROJECT,
    runId: RUN,
    snapshotRefBefore: SNAPSHOT_REF,
    snapshotRefAfter: null,
    auditRef,
    violationRefs: violations.map((v) => v.violationId),
    manifestRef: null,
    engineVersion: ENGINE_VERSION,
    engineId: ENGINE,
    schemaVersion: 1,
    correlationId: CORR,
    auditResult,
    createdAt: at,
  };
  const attempt: Attempt = {
    attemptId,
    executionId,
    attemptNumber,
    contractRef: null,
    basedOnSnapshotRef: SNAPSHOT_REF,
    resultSnapshotRef: null,
    auditRef,
    proofBundleRef,
    status,
    actorType: 'session',
    actorRef: 'sess-1',
    repairPlanRef: null,
    startedAt: at,
    completedAt: at,
  };
  const provenance: DecisionProvenance = {
    provenanceId: `prov_${attemptId}`,
    executionId,
    attemptId,
    category: 'hoplon_proved',
    summary: `Hoplon audit ${status} attempt ${attemptNumber}`,
    detail: { status },
    createdAt: at,
  };
  return { attempt, bundle, violations, provenance };
}

// ---------------------------------------------------------------------------
// Parametric adapter suite
// ---------------------------------------------------------------------------

interface AdapterFactory {
  name: string;
  create: () => Promise<TraceStore>;
}

const ADAPTERS: AdapterFactory[] = [
  { name: 'memory', create: async () => createInMemoryTraceStore() },
  { name: 'sqlite', create: () => createInMemorySqliteTraceStore() },
  { name: 'postgres', create: () => createIsolatedPgTestTraceStore() },
];

for (const { name, create } of ADAPTERS) {
  describe(`TraceStore contract (${name})`, () => {
    it('put+get execution round-trips and is idempotent', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);
      await store.putExecution(exec); // idempotent

      const got = await store.getExecution(exec.executionId);
      expect(got).not.toBeNull();
      expect(got?.projectId).toBe(PROJECT);
      expect(got?.currentStatus).toBe('IN_PROGRESS');
    });

    it('getExecution returns null for unknown id', async () => {
      const store = await create();
      expect(await store.getExecution('exec_unknown')).toBeNull();
    });

    it('updateExecution mutates currentStatus + updatedAt only', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);
      await store.updateExecution(exec.executionId, {
        currentStatus: 'BLOCK',
        updatedAt: '2026-04-20T10:05:00.000Z',
      });
      const got = await store.getExecution(exec.executionId);
      expect(got?.currentStatus).toBe('BLOCK');
      expect(got?.updatedAt).toBe('2026-04-20T10:05:00.000Z');
      expect(got?.projectId).toBe(exec.projectId);
    });

    it('blocked attempt stays visible after a later PASS', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);

      const blocked = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 1,
        status: 'BLOCK',
        at: '2026-04-20T10:01:00.000Z',
      });
      await store.putProofBundle(blocked.bundle, blocked.violations);
      await store.appendAttempt(blocked.attempt);
      await store.appendDecisionProvenance(blocked.provenance);

      const passed = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 2,
        status: 'PASS',
        at: '2026-04-20T10:02:00.000Z',
      });
      await store.putProofBundle(passed.bundle, passed.violations);
      await store.appendAttempt(passed.attempt);
      await store.appendDecisionProvenance(passed.provenance);

      const attempts = await store.listAttempts(exec.executionId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.attemptNumber).toBe(1);
      expect(attempts[0]?.status).toBe('BLOCK');
      expect(attempts[1]?.attemptNumber).toBe(2);
      expect(attempts[1]?.status).toBe('PASS');
    });

    it('searchAttempts status filters Attempt.status, not execution currentStatus', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);

      const blocked = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 1,
        status: 'BLOCK',
        at: '2026-04-20T10:01:00.000Z',
      });
      await store.putProofBundle(blocked.bundle, blocked.violations);
      await store.appendAttempt(blocked.attempt);

      const passed = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 2,
        status: 'PASS',
        at: '2026-04-20T10:02:00.000Z',
      });
      await store.putProofBundle(passed.bundle, passed.violations);
      await store.appendAttempt(passed.attempt);

      await store.updateExecution(exec.executionId, {
        currentStatus: 'PASS',
        updatedAt: '2026-04-20T10:03:00.000Z',
      });

      const blockedMatches = await store.searchAttempts({ status: 'BLOCK' });
      expect(blockedMatches.map((a) => a.attemptId)).toEqual([blocked.attempt.attemptId]);

      const passMatches = await store.searchAttempts({ status: 'PASS' });
      expect(passMatches.map((a) => a.attemptId)).toEqual([passed.attempt.attemptId]);
    });

    it('raw AuditResult round-trips through ProofBundle retrieval', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);

      const blocked = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 1,
        status: 'BLOCK',
        at: '2026-04-20T10:01:00.000Z',
      });
      await store.putProofBundle(blocked.bundle, blocked.violations);

      const got = await store.getProofBundle(blocked.bundle.proofBundleRef);
      expect(got).not.toBeNull();
      expect(got?.auditResult.status).toBe('BLOCK');
      if (got?.auditResult.status === 'BLOCK') {
        expect(got.auditResult.violations).toHaveLength(1);
        expect(got.auditResult.violations[0]?.kind).toBe('uncontracted_file');
      }
    });

    it('searchAttempts by path uses the violation index', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);

      const a = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 1,
        status: 'BLOCK',
        at: '2026-04-20T10:01:00.000Z',
        path: 'src/a.ts',
      });
      const b = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 2,
        status: 'BLOCK',
        at: '2026-04-20T10:02:00.000Z',
        path: 'src/b.ts',
      });
      await store.putProofBundle(a.bundle, a.violations);
      await store.appendAttempt(a.attempt);
      await store.putProofBundle(b.bundle, b.violations);
      await store.appendAttempt(b.attempt);

      const matches = await store.searchAttempts({ path: 'src/b.ts' });
      expect(matches.map((m) => m.attemptId)).toEqual([b.attempt.attemptId]);
    });

    it('searchAttempts composes auditRef + projectId + createdAfter', async () => {
      const store = await create();
      const exec1 = makeExecution({ executionId: 'exec_one' });
      const exec2 = makeExecution({
        executionId: 'exec_two',
        projectId: 'other-project',
      });
      await store.putExecution(exec1);
      await store.putExecution(exec2);

      const bundles = [
        makeAttemptBundle({
          executionId: exec1.executionId,
          attemptNumber: 1,
          status: 'PASS',
          at: '2026-04-20T10:01:00.000Z',
          auditRef: 'audit-1',
        }),
        makeAttemptBundle({
          executionId: exec1.executionId,
          attemptNumber: 2,
          status: 'PASS',
          at: '2026-04-20T10:02:00.000Z',
          auditRef: 'audit-2',
        }),
        makeAttemptBundle({
          executionId: exec2.executionId,
          attemptNumber: 1,
          status: 'PASS',
          at: '2026-04-20T10:03:00.000Z',
          auditRef: 'audit-2',
        }),
      ];
      for (const ab of bundles) {
        await store.putProofBundle(ab.bundle, ab.violations);
        await store.appendAttempt(ab.attempt);
      }

      const byAudit = await store.searchAttempts({ auditRef: 'audit-2' });
      expect(byAudit.map((a) => a.executionId).sort()).toEqual(
        [exec1.executionId, exec2.executionId].sort(),
      );

      const byProject = await store.searchAttempts({
        auditRef: 'audit-2',
        projectId: PROJECT,
      });
      expect(byProject.map((a) => a.executionId)).toEqual([exec1.executionId]);

      const byCreatedAfter = await store.searchAttempts({
        createdAfter: '2026-04-20T10:02:00.000Z',
      });
      expect(byCreatedAfter).toHaveLength(2);
    });

    it('exportExecution returns the full durable bundle', async () => {
      const store = await create();
      const exec = makeExecution();
      await store.putExecution(exec);

      const ab = makeAttemptBundle({
        executionId: exec.executionId,
        attemptNumber: 1,
        status: 'BLOCK',
        at: '2026-04-20T10:01:00.000Z',
      });
      await store.putProofBundle(ab.bundle, ab.violations);
      await store.appendAttempt(ab.attempt);
      await store.appendDecisionProvenance(ab.provenance);

      const exportBundle = await store.exportExecution(exec.executionId);
      expect(exportBundle).not.toBeNull();
      expect(exportBundle?.execution.executionId).toBe(exec.executionId);
      expect(exportBundle?.attempts).toHaveLength(1);
      expect(exportBundle?.proofBundles).toHaveLength(1);
      expect(exportBundle?.violations).toHaveLength(1);
      expect(exportBundle?.provenance).toHaveLength(1);
      expect(exportBundle?.schemaVersion).toBe(1);
    });

    it('exportExecution returns null for unknown execution', async () => {
      const store = await create();
      expect(await store.exportExecution('exec_missing')).toBeNull();
    });
  });
}
