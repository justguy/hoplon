/**
 * tests/adapters/policyAuditLog.test.ts — t-088 policy audit log
 * contract + sqlite round-trip proof.
 *
 * Covers:
 *   - POLICY_* operation + GRANTED/DENIED/REAUTH_REQUIRED/REVOKED result
 *     values survive Zod validation through `appendAuditLog` and
 *     `findAuditLogByProjectAndRun` round-trip on the shipped sqlite
 *     adapter.
 *   - PolicyAuditEvent payload round-trips with all five fields plus
 *     the reason-code closed union.
 *   - Legacy CREATE_SNAPSHOT rows coexist with POLICY_* rows without
 *     breaking either direction.
 *   - Schema rejects a bogus reason code (closed-union enforcement).
 *   - Schema rejects policy rows without `policyEvent` and non-policy rows
 *     that try to carry one.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import {
  AuditLogRecordSchema,
} from '../../src/hoplon/contracts/auditLog.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import {
  PolicyAuditEventSchema,
} from '../../src/hoplon/contracts/policyAudit.js';

function baseLegacyRow(projectId: string, runId: string): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId,
    runId,
    engineId: 'test-engine',
    correlationId: 'test-corr',
    operation: 'CREATE_SNAPSHOT',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 5,
    createdAt: new Date().toISOString(),
  };
}

function policyRow(
  projectId: string,
  runId: string,
  overrides: Partial<AuditLogRecord>,
): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId,
    runId,
    engineId: 'test-engine',
    correlationId: 'test-corr',
    operation: 'POLICY_HANDSHAKE',
    result: 'GRANTED',
    violationCount: 0,
    violationKinds: [],
    durationMs: 3,
    createdAt: new Date().toISOString(),
    policyEvent: {
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

describe('hoplon_audit_log policy extension (t-088)', () => {
  it('round-trips POLICY_HANDSHAKE GRANTED with a full PolicyAuditEvent', async () => {
    const store = await createIsolatedTestStore();
    const row = policyRow('proj-1', 'run-1', {
      policyEvent: {
        reasonCode: 'handshake_granted',
        requestedAction: 'handshake',
        folder: 'src/hoplon',
        principalId: 'principal-a',
        resolvedAccess: 'read_write',
        engagementId: 'engagement-nonce-aaaa',
        detail: null,
      },
    });
    await store.appendAuditLog(row);
    const found = await store.findAuditLogByProjectAndRun('proj-1', 'run-1');
    expect(found.length).toBe(1);
    const back = found[0]!;
    expect(back.operation).toBe('POLICY_HANDSHAKE');
    expect(back.result).toBe('GRANTED');
    expect(back.policyEvent).toEqual(row.policyEvent);
  });

  it('round-trips POLICY_ACCESS_CHECK DENIED with scope_mismatch detail', async () => {
    const store = await createIsolatedTestStore();
    const row = policyRow('proj-2', 'run-2', {
      operation: 'POLICY_ACCESS_CHECK',
      result: 'DENIED',
      policyEvent: {
        reasonCode: 'access_scope_mismatch_folder',
        requestedAction: 'read',
        folder: 'src',
        principalId: null,
        resolvedAccess: null,
        engagementId: 'engagement-nonce-bbbb',
        detail: 'folder',
      },
    });
    await store.appendAuditLog(row);
    const found = await store.findAuditLogByProjectAndRun('proj-2', 'run-2');
    expect(found[0]?.result).toBe('DENIED');
    expect(found[0]?.policyEvent?.reasonCode).toBe('access_scope_mismatch_folder');
    expect(found[0]?.policyEvent?.detail).toBe('folder');
  });

  it('round-trips POLICY_RENEW REAUTH_REQUIRED with typed reauth reason', async () => {
    const store = await createIsolatedTestStore();
    const row = policyRow('proj-3', 'run-3', {
      operation: 'POLICY_RENEW',
      result: 'REAUTH_REQUIRED',
      policyEvent: {
        reasonCode: 'renew_reauth_expired',
        requestedAction: 'renew',
        folder: null,
        principalId: null,
        resolvedAccess: null,
        engagementId: null,
        detail: 'expired',
      },
    });
    await store.appendAuditLog(row);
    const found = await store.findAuditLogByProjectAndRun('proj-3', 'run-3');
    expect(found[0]?.result).toBe('REAUTH_REQUIRED');
    expect(found[0]?.policyEvent?.reasonCode).toBe('renew_reauth_expired');
  });

  it('round-trips POLICY_REVOKE REVOKED with null payload fields', async () => {
    const store = await createIsolatedTestStore();
    const row = policyRow('proj-4', 'run-4', {
      operation: 'POLICY_REVOKE',
      result: 'REVOKED',
      policyEvent: {
        reasonCode: 'revoke_completed',
        requestedAction: 'revoke',
        folder: null,
        principalId: null,
        resolvedAccess: null,
        engagementId: null,
        detail: null,
      },
    });
    await store.appendAuditLog(row);
    const found = await store.findAuditLogByProjectAndRun('proj-4', 'run-4');
    expect(found[0]?.result).toBe('REVOKED');
    expect(found[0]?.policyEvent?.reasonCode).toBe('revoke_completed');
  });

  it('coexists with legacy CREATE_SNAPSHOT rows without null policy_event stomping', async () => {
    const store = await createIsolatedTestStore();
    const legacy = baseLegacyRow('proj-mix', 'run-mix');
    const policy = policyRow('proj-mix', 'run-mix', {});
    await store.appendAuditLog(legacy);
    await store.appendAuditLog(policy);
    const found = await store.findAuditLogByProjectAndRun('proj-mix', 'run-mix');
    expect(found.length).toBe(2);
    const createSnap = found.find((r) => r.operation === 'CREATE_SNAPSHOT');
    const policyRowRead = found.find((r) => r.operation === 'POLICY_HANDSHAKE');
    expect(createSnap?.policyEvent ?? null).toBeNull();
    expect(policyRowRead?.policyEvent).toBeTruthy();
  });

  it('rejects unknown reason codes (closed-union enforcement)', () => {
    const malformed = {
      reasonCode: 'totally_made_up_reason',
      requestedAction: 'handshake',
      folder: null,
      principalId: null,
      resolvedAccess: null,
      engagementId: null,
      detail: null,
    };
    const parsed = PolicyAuditEventSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('accepts diagnostic detail without truncation', () => {
    const detail = 'invalid_folder';
    const parsed = PolicyAuditEventSchema.safeParse({
      reasonCode: 'handshake_granted',
      requestedAction: 'handshake',
      folder: null,
      principalId: null,
      resolvedAccess: null,
      engagementId: null,
      detail,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects AuditLogRecord with POLICY_HANDSHAKE + bogus result enum', () => {
    const record = policyRow('x', 'x', { result: 'bogus' as unknown as 'GRANTED' });
    const parsed = AuditLogRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });

  it('rejects POLICY_* rows without policyEvent', () => {
    const record = policyRow('x', 'x', { policyEvent: undefined });
    const parsed = AuditLogRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });

  it('rejects non-policy rows carrying policyEvent', () => {
    const record = {
      ...baseLegacyRow('x', 'x'),
      policyEvent: policyRow('x', 'x', {}).policyEvent,
    };
    const parsed = AuditLogRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });
});
