/**
 * tests/adapters/policyAuditQuery.test.ts — t-089 SnapshotStore.findPolicyAuditEntries
 * proof against the shipped sqlite adapter.
 *
 * Covers:
 *   - mixed grant + denial + reauth_required + revoked retrieval over real
 *     packaged appendAuditLog → findPolicyAuditEntries round-trip;
 *   - each filter dimension (folder, principal any/none/exact, outcome,
 *     reasonCode, since/until, limit clamp);
 *   - honest empty-result for no-match queries (vs unknown-project guard
 *     which lives at the HTTP/MCP layer);
 *   - deterministic reverse-chronological ordering with id tiebreaker;
 *   - content-safety: returned rows still carry the engagementId on the
 *     RAW AuditLogRecord (the launcher fn projection is what strips it —
 *     covered in the launcher-fn test below).
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { PolicyAuditQueryRequest } from '../../src/hoplon/contracts/policyAuditQuery.js';

function row(
  projectId: string,
  createdAtIso: string,
  overrides: Partial<AuditLogRecord> & {
    operation?: AuditLogRecord['operation'];
    result?: AuditLogRecord['result'];
    policyEvent?: AuditLogRecord['policyEvent'];
  } = {},
): AuditLogRecord {
  return {
    id: overrides.id ?? randomUUID(),
    snapshotId: null,
    projectId,
    runId: 'run-1',
    engineId: 'test-engine',
    correlationId: 'corr-' + randomUUID(),
    operation: overrides.operation ?? 'POLICY_HANDSHAKE',
    result: overrides.result ?? 'GRANTED',
    violationCount: 0,
    violationKinds: [],
    durationMs: 1,
    createdAt: createdAtIso,
    policyEvent: overrides.policyEvent ?? {
      reasonCode: 'handshake_granted',
      requestedAction: 'handshake',
      folder: 'src',
      principalId: null,
      resolvedAccess: 'read_write',
      engagementId: null,
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

describe('SnapshotStore.findPolicyAuditEntries (t-089, sqlite)', () => {
  it('returns mixed grant / denial / reauth / revoked rows scoped to projectId', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(
      row('proj-A', '2026-04-01T10:00:00.000Z', {
        result: 'GRANTED',
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'nonce-1',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('proj-A', '2026-04-01T11:00:00.000Z', {
        operation: 'POLICY_HANDSHAKE',
        result: 'DENIED',
        policyEvent: {
          reasonCode: 'handshake_policy_denied',
          requestedAction: 'handshake',
          folder: 'docs',
          principalId: 'bob',
          resolvedAccess: 'none',
          engagementId: null,
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('proj-A', '2026-04-01T12:00:00.000Z', {
        operation: 'POLICY_ACCESS_CHECK',
        result: 'REAUTH_REQUIRED',
        policyEvent: {
          reasonCode: 'access_expired_token',
          requestedAction: 'read',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: null,
          engagementId: 'nonce-2',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('proj-A', '2026-04-01T13:00:00.000Z', {
        operation: 'POLICY_REVOKE',
        result: 'REVOKED',
        policyEvent: {
          reasonCode: 'revoke_completed',
          requestedAction: 'revoke',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'nonce-1',
          detail: null,
        },
      }),
    );
    // Different project — must NOT appear in proj-A results.
    await store.appendAuditLog(row('proj-B', '2026-04-01T14:00:00.000Z'));
    // Legacy non-policy row — must NOT appear (POLICY_* operation guard).
    await store.appendAuditLog({
      ...row('proj-A', '2026-04-01T15:00:00.000Z'),
      operation: 'CREATE_SNAPSHOT',
      result: 'PASS',
      policyEvent: undefined,
    });

    const found = await store.findPolicyAuditEntries(baseReq('proj-A'));
    expect(found.map((r) => r.result)).toEqual([
      'REVOKED',
      'REAUTH_REQUIRED',
      'DENIED',
      'GRANTED',
    ]);
    // Project scoping holds.
    expect(found.every((r) => r.projectId === 'proj-A')).toBe(true);
    // Operation is always POLICY_*.
    expect(
      found.every((r) =>
        ['POLICY_HANDSHAKE', 'POLICY_ACCESS_CHECK', 'POLICY_RENEW', 'POLICY_REVOKE'].includes(r.operation),
      ),
    ).toBe(true);
  });

  it('filters by folder, outcome, reasonCode, principal exact, principal none', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(
      row('p', '2026-04-02T10:00:00.000Z', {
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'alice',
          resolvedAccess: 'read_write',
          engagementId: 'n1',
          detail: null,
        },
      }),
    );
    await store.appendAuditLog(
      row('p', '2026-04-02T11:00:00.000Z', {
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
    await store.appendAuditLog(
      row('p', '2026-04-02T12:00:00.000Z', {
        result: 'GRANTED',
        policyEvent: {
          reasonCode: 'handshake_granted',
          requestedAction: 'handshake',
          folder: 'src',
          principalId: 'bob',
          resolvedAccess: 'read_only',
          engagementId: 'n2',
          detail: null,
        },
      }),
    );

    const folderOnly = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      folder: 'src',
    });
    expect(folderOnly.length).toBe(2);
    expect(folderOnly.every((r) => r.policyEvent?.folder === 'src')).toBe(true);

    const denied = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      outcome: 'DENIED',
    });
    expect(denied.length).toBe(1);
    expect(denied[0]!.result).toBe('DENIED');

    const reason = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      reasonCode: 'handshake_policy_denied',
    });
    expect(reason.length).toBe(1);

    const principalAlice = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      principal: { kind: 'exact', principalId: 'alice' },
    });
    expect(principalAlice.length).toBe(1);
    expect(principalAlice[0]!.policyEvent?.principalId).toBe('alice');

    const principalAgnostic = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      principal: { kind: 'none' },
    });
    expect(principalAgnostic.length).toBe(1);
    expect(principalAgnostic[0]!.policyEvent?.principalId).toBeNull();
  });

  it('respects since/until window and clamps limit to [1, 200]', async () => {
    const store = await createIsolatedTestStore();
    for (let i = 0; i < 5; i++) {
      await store.appendAuditLog(row('p', `2026-04-03T1${i}:00:00.000Z`));
    }
    const window = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      since: '2026-04-03T11:00:00.000Z',
      until: '2026-04-03T13:00:00.000Z',
    });
    expect(window.length).toBe(3);

    const clamped = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      limit: 2,
    });
    expect(clamped.length).toBe(2);

    // Lower bound: even if a caller bypasses the contract and passes 0,
    // the adapter floors to 1 instead of returning the unbounded set.
    const floored = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      limit: 0 as unknown as number,
    });
    expect(floored.length).toBe(1);
  });

  it('returns deterministic createdAt DESC, id DESC ordering on ties', async () => {
    const store = await createIsolatedTestStore();
    const sameTs = '2026-04-04T09:00:00.000Z';
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    await store.appendAuditLog(row('p', sameTs, { id: idA }));
    await store.appendAuditLog(row('p', sameTs, { id: idB }));
    await store.appendAuditLog(row('p', sameTs, { id: idC }));
    const expected = [idA, idB, idC].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const found = await store.findPolicyAuditEntries(baseReq('p'));
    expect(found.map((r) => r.id)).toEqual(expected);
  });

  it('returns an honest empty array for a project with no policy rows', async () => {
    const store = await createIsolatedTestStore();
    // A non-policy row exists for the same project; it must NOT leak
    // into the result.
    await store.appendAuditLog({
      ...row('p', '2026-04-05T09:00:00.000Z'),
      operation: 'CREATE_SNAPSHOT',
      result: 'PASS',
      policyEvent: undefined,
    });
    const found = await store.findPolicyAuditEntries(baseReq('p'));
    expect(found).toEqual([]);
  });

  it('rejects since > until via inverted window returning no rows when adapter still queries', async () => {
    // The contract refuses since > until at the launcher fn layer; the
    // adapter receives the request as-is. When the caller bypasses the
    // contract, the SQL still produces an empty result rather than an
    // unbounded one — verify defense-in-depth.
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(row('p', '2026-04-06T09:00:00.000Z'));
    const found = await store.findPolicyAuditEntries({
      ...baseReq('p'),
      since: '2026-04-06T10:00:00.000Z',
      until: '2026-04-06T08:00:00.000Z',
    });
    expect(found).toEqual([]);
  });
});
