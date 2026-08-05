/**
 * tests/adapters/policyAuditQueryPostgres.test.ts — t-089 Postgres proof.
 *
 * The sqlite adapter has the broad filter matrix. These tests exercise
 * the Postgres-specific JSONB `->>` retrieval path with pg-mem so the
 * second shipped adapter is covered by a real append/read round-trip.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createIsolatedPgTestStore } from '../../src/hoplon/adapters/snapshotStore/postgres.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { PolicyAuditQueryRequest } from '../../src/hoplon/contracts/policyAuditQuery.js';

function row(
  projectId: string,
  createdAtIso: string,
  overrides: Partial<AuditLogRecord> = {},
): AuditLogRecord {
  return {
    id: overrides.id ?? randomUUID(),
    snapshotId: null,
    projectId,
    runId: 'run-pg-policy',
    engineId: 'pg-policy-test',
    correlationId: 'corr-' + randomUUID(),
    operation: 'POLICY_HANDSHAKE',
    result: 'GRANTED',
    violationCount: 0,
    violationKinds: [],
    durationMs: 1,
    createdAt: createdAtIso,
    policyEvent: {
      reasonCode: 'handshake_granted',
      requestedAction: 'handshake',
      folder: 'src',
      principalId: 'alice',
      resolvedAccess: 'read_write',
      engagementId: 'pg-private-nonce',
      detail: null,
    },
    ...overrides,
  };
}

function baseReq(projectId: string): PolicyAuditQueryRequest {
  return {
    projectId,
    principal: { kind: 'any' },
    limit: 50,
  };
}

describe('SnapshotStore.findPolicyAuditEntries (t-089, postgres)', () => {
  it('round-trips policy rows through JSONB filters and reverse ordering', async () => {
    const store = await createIsolatedPgTestStore();
    await store.appendAuditLog(
      row('pg-proj', '2026-04-07T10:00:00.000Z', {
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'pg-n1',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('pg-proj', '2026-04-07T11:00:00.000Z', {
        result: 'DENIED',
        policyEvent: {
          reasonCode: 'handshake_policy_denied',
          requestedAction: 'handshake',
          folder: 'docs',
          principalId: null,
          resolvedAccess: 'none',
          engagementId: null,
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(row('other-proj', '2026-04-07T12:00:00.000Z'));

    const all = await store.findPolicyAuditEntries(baseReq('pg-proj'));
    expect(all.map((r) => r.result)).toEqual(['DENIED', 'GRANTED']);
    expect(all.every((r) => r.projectId === 'pg-proj')).toBe(true);

    const folder = await store.findPolicyAuditEntries({
      ...baseReq('pg-proj'),
      folder: 'src',
    });
    expect(folder).toHaveLength(1);
    expect(folder[0]!.policyEvent?.principalId).toBe('alice');

    const reason = await store.findPolicyAuditEntries({
      ...baseReq('pg-proj'),
      reasonCode: 'handshake_policy_denied',
      principal: { kind: 'none' },
    });
    expect(reason).toHaveLength(1);
    expect(reason[0]!.policyEvent?.folder).toBe('docs');
  });

  it('applies time-window and limit parameters in the Postgres query', async () => {
    const store = await createIsolatedPgTestStore();
    for (let i = 0; i < 4; i++) {
      await store.appendAuditLog(row('pg-window', `2026-04-08T1${i}:00:00.000Z`));
    }

    const found = await store.findPolicyAuditEntries({
      ...baseReq('pg-window'),
      since: '2026-04-08T11:00:00.000Z',
      until: '2026-04-08T13:00:00.000Z',
      limit: 2,
    });

    expect(found).toHaveLength(2);
    expect(found.map((r) => r.createdAt)).toEqual([
      '2026-04-08T13:00:00.000Z',
      '2026-04-08T12:00:00.000Z',
    ]);
  });
});
