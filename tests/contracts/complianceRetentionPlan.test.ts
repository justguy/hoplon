import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import {
  finalizeAuditLogChainRecord,
  verifyAuditLogChain,
} from '../../src/hoplon/contracts/compliance.js';
import {
  auditLogRecordToRetentionCandidate,
  enforceRetention,
  planRetention,
} from '../../src/hoplon/contracts/complianceRetention.js';

function makeAuditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId: 'proj-retention',
    runId: 'run-retention',
    engineId: 'engine-retention',
    correlationId: 'corr-retention',
    operation: 'AUDIT_DIFF',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 1,
    createdAt: '2026-03-01T00:00:00.000Z',
    astNodeCount: null,
    fileLineCount: null,
    manifestScopeRatio: null,
    ...overrides,
  };
}

function chain(rows: AuditLogRecord[]): AuditLogRecord[] {
  let previousChainHash: string | null = null;
  return rows.map((row, index) => {
    const finalized = finalizeAuditLogChainRecord(row, {
      auditSequence: index + 1,
      previousChainHash,
    });
    previousChainHash = finalized.chainHash ?? null;
    return finalized;
  });
}

describe('SOC2 retention planning (t-135)', () => {
  it('keeps all candidates before the policy effectiveAt', () => {
    const [row] = chain([
      makeAuditRecord({ createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    const summary = planRetention(
      {
        projectId: 'proj-retention',
        evidenceClass: 'audit_log',
        horizonDays: 1,
        disposalMode: 'delete',
        effectiveAt: '2026-03-01T00:00:00.000Z',
      },
      [auditLogRecordToRetentionCandidate(row!)],
      '2026-02-01T00:00:00.000Z',
    );

    expect(summary.kept).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(summary.actions[0]?.reasonCode).toBe('policy_not_effective');
    expect(summary.checkpoints).toEqual([]);
  });

  it('keeps candidates inside the retention horizon', () => {
    const [row] = chain([
      makeAuditRecord({ createdAt: '2026-03-30T00:00:00.000Z' }),
    ]);

    const summary = planRetention(
      {
        projectId: 'proj-retention',
        evidenceClass: 'audit_log',
        horizonDays: 30,
        disposalMode: 'tombstone',
        effectiveAt: '2026-01-01T00:00:00.000Z',
      },
      [auditLogRecordToRetentionCandidate(row!)],
      '2026-04-01T00:00:00.000Z',
    );

    expect(summary.kept).toBe(1);
    expect(summary.tombstoned).toBe(0);
    expect(summary.actions[0]?.reasonCode).toBe('within_horizon');
  });

  it('tombstones expired audit rows and emits a prefix checkpoint', () => {
    const [oldRow, retainedRow] = chain([
      makeAuditRecord({ createdAt: '2026-01-01T00:00:00.000Z' }),
      makeAuditRecord({ createdAt: '2026-03-30T00:00:00.000Z' }),
    ]);

    const summary = planRetention(
      {
        projectId: 'proj-retention',
        evidenceClass: 'audit_log',
        horizonDays: 30,
        disposalMode: 'tombstone',
        effectiveAt: '2026-01-01T00:00:00.000Z',
      },
      [
        auditLogRecordToRetentionCandidate(oldRow!),
        auditLogRecordToRetentionCandidate(retainedRow!),
      ],
      '2026-04-01T00:00:00.000Z',
    );

    expect(summary.tombstoned).toBe(1);
    expect(summary.checkpoints).toMatchObject([
      {
        projectId: 'proj-retention',
        runId: 'run-retention',
        lastAuditSequence: 1,
        terminalChainHash: oldRow!.chainHash,
        rowCount: 1,
      },
    ]);

    const retainedOnly = verifyAuditLogChain(
      [retainedRow!],
      { projectId: 'proj-retention', runId: 'run-retention' },
      summary.checkpoints,
    );
    expect(retainedOnly.status).toBe('PASS');
  });

  it('deletes expired candidates through the executor seam', async () => {
    const [oldRow] = chain([
      makeAuditRecord({ createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const calls: string[] = [];

    const summary = await enforceRetention(
      {
        projectId: 'proj-retention',
        evidenceClass: 'audit_log',
        horizonDays: 1,
        disposalMode: 'delete',
        effectiveAt: '2026-01-01T00:00:00.000Z',
      },
      [auditLogRecordToRetentionCandidate(oldRow!)],
      {
        checkpoint: async () => { calls.push('checkpoint'); },
        delete: async (action) => { calls.push(`delete:${action.objectRef}`); },
      },
      '2026-04-01T00:00:00.000Z',
    );

    expect(summary.deleted).toBe(1);
    expect(calls).toEqual(['checkpoint', `delete:${oldRow!.id}`]);
  });

  it('keep mode evaluates candidates without deleting or checkpointing', () => {
    const [oldRow] = chain([
      makeAuditRecord({ createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    const summary = planRetention(
      {
        projectId: 'proj-retention',
        evidenceClass: 'all',
        horizonDays: 1,
        disposalMode: 'keep',
        effectiveAt: '2026-01-01T00:00:00.000Z',
      },
      [auditLogRecordToRetentionCandidate(oldRow!)],
      '2026-04-01T00:00:00.000Z',
    );

    expect(summary.kept).toBe(1);
    expect(summary.checkpoints).toEqual([]);
    expect(summary.actions[0]?.reasonCode).toBe('policy_keep_mode');
  });
});
