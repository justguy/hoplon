/**
 * tests/launcher/policyAuditQuery.test.ts — t-089 launcher fn proof.
 *
 * Covers contract validation (PolicyAuditQueryError) and the
 * content-safety projection: even when the underlying audit row
 * carries a `policyEvent.engagementId`, the projected response
 * `PolicyAuditEntry` has no engagement nonce field and no other
 * H13-sensitive payload (raw tokens, secret patterns, rule bodies are
 * never persisted by t-088 in the first place — engagementId is the
 * only correlation handle worth scrubbing here).
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import {
  queryPolicyAudit,
  PolicyAuditQueryError,
} from '../../src/hoplon/launcher/policyAuditQuery.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';

function policyRow(
  projectId: string,
  createdAtIso: string,
  overrides: Partial<AuditLogRecord> = {},
): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: null,
    projectId,
    runId: 'run-l',
    engineId: 'launcher-test',
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
      engagementId: 'server-private-nonce-AAAA',
      detail: 'mapper-detail',
    },
    ...overrides,
  };
}

function queryOnlyStore(rows: AuditLogRecord[]): SnapshotStore {
  return {
    findPolicyAuditEntries: async () => rows,
  } as unknown as SnapshotStore;
}

describe('queryPolicyAudit (t-089 launcher fn)', () => {
  it('rejects malformed requests with PolicyAuditQueryError(invalid_request)', async () => {
    const store = await createIsolatedTestStore();
    await expect(
      queryPolicyAudit({ store, request: { projectId: '' } }),
    ).rejects.toBeInstanceOf(PolicyAuditQueryError);
    await expect(
      queryPolicyAudit({
        store,
        request: {
          projectId: 'p',
          since: '2026-04-02T10:00:00.000Z',
          until: '2026-04-02T09:00:00.000Z',
        },
      }),
    ).rejects.toBeInstanceOf(PolicyAuditQueryError);
    await expect(
      queryPolicyAudit({
        store,
        request: { projectId: 'p', limit: 9999 },
      }),
    ).rejects.toBeInstanceOf(PolicyAuditQueryError);
    await expect(
      queryPolicyAudit({
        store,
        request: {
          projectId: 'p',
          since: '2026-04-02T10:00:00.000+02:00',
        },
      }),
    ).rejects.toBeInstanceOf(PolicyAuditQueryError);
  });

  it('projects entries with no engagement nonce and no extra fields', async () => {
    const store = await createIsolatedTestStore();
    await store.appendAuditLog(policyRow('p', '2026-04-10T10:00:00.000Z'));

    const resp = await queryPolicyAudit({
      store,
      request: { projectId: 'p' },
    });
    expect(resp.projectId).toBe('p');
    expect(resp.entries.length).toBe(1);
    const entry = resp.entries[0]!;
    // Field-presence regression: every t-089 DoD field is preserved...
    expect(typeof entry.id).toBe('string');
    expect(entry.createdAtIso).toBe('2026-04-10T10:00:00.000Z');
    expect(typeof entry.correlationId).toBe('string');
    expect(entry.requestedAction).toBe('handshake');
    expect(entry.resolvedAccess).toBe('read_write');
    expect(entry.outcome).toBe('GRANTED');
    expect(entry.reasonCode).toBe('handshake_granted');
    expect(entry.folder).toBe('src');
    expect(entry.principalId).toBe('alice');
    expect(entry.detail).toBe('mapper-detail');
    // ...and the server-private nonce is absent.
    expect(Object.keys(entry)).not.toContain('engagementId');
    expect(JSON.stringify(entry)).not.toContain('server-private-nonce');
  });

  it('returns honest empty entries for a registered-but-quiet project', async () => {
    const store = await createIsolatedTestStore();
    const resp = await queryPolicyAudit({
      store,
      request: { projectId: 'never-touched' },
    });
    expect(resp.entries).toEqual([]);
    expect(resp.limit).toBe(50);
  });

  it('echoes the resolved limit in the response', async () => {
    const store = await createIsolatedTestStore();
    const resp = await queryPolicyAudit({
      store,
      request: { projectId: 'p', limit: 7 },
    });
    expect(resp.limit).toBe(7);
  });

  it('validates each projected entry against the response contract', async () => {
    const store = queryOnlyStore([policyRow('p', 'not-a-utc-timestamp')]);
    await expect(
      queryPolicyAudit({ store, request: { projectId: 'p' } }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
