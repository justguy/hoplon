/**
 * t-087 hard-gate proof corpus: durable audit and bounded query.
 *
 * Covers H13-safe policy audit rows and bounded retrieval against the real
 * in-memory sqlite SnapshotStore adapter.
 */
import { describe, it, expect } from 'vitest';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import {
  createInMemoryEngagementStore,
  HandshakeError,
  issueProjectHandshake,
} from '../../src/hoplon/launcher/handshake.js';
import { queryPolicyAudit } from '../../src/hoplon/launcher/policyAuditQuery.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import {
  expectSingle,
  FIXED_NONCE_A,
  FIXED_NOW,
  FIXED_TOKEN_A,
  makePolicy,
  registerProject,
} from './t087HardGateFixtures.js';

describe('t-087 / 6. audit content-safety corpus', () => {
  it('records GRANTED handshake row without leaking the token', async () => {
    const store = await createIsolatedTestStore();
    const sink = createPolicyAuditSink({
      store,
      engineId: 't087-engine',
      clock: () => FIXED_NOW,
    });
    const registry = registerProject(makePolicy());
    const engagement = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      {
        registry,
        store: createInMemoryEngagementStore(),
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN_A,
        randomNonce: () => FIXED_NONCE_A,
      },
    );
    await sink.recordHandshakeGrant(
      { projectId: 'p1', runId: 'run-1', correlationId: 'corr-1' },
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      engagement,
      5,
    );
    const row = expectSingle(
      await store.findAuditLogByProjectAndRun('p1', 'run-1'),
      'audit row',
    );
    expect(row.operation).toBe('POLICY_HANDSHAKE');
    expect(row.result).toBe('GRANTED');
    expect(JSON.stringify(row)).not.toContain(FIXED_TOKEN_A);
    expect(row.policyEvent?.engagementId).toBeNull();
  });

  it('records DENIED handshake with canonical-folder only; no raw bad input bytes', async () => {
    const store = await createIsolatedTestStore();
    const sink = createPolicyAuditSink({
      store,
      engineId: 't087-engine',
      clock: () => FIXED_NOW,
    });
    const err = new HandshakeError(
      'invalid_folder',
      'rejected by canonicalization',
      { projectId: 'p1', reason: 'absolute_path' },
    );
    await sink.recordHandshakeDeny(
      { projectId: 'p1', runId: 'run-2', correlationId: 'corr-2' },
      { projectId: 'p1', folder: '/etc/../etc/passwd' },
      err,
      2,
    );
    const row = expectSingle(
      await store.findAuditLogByProjectAndRun('p1', 'run-2'),
      'audit row',
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('/etc/passwd');
    expect(row.policyEvent?.folder).toBeNull();
    expect(row.policyEvent?.reasonCode).toBe('handshake_invalid_folder');
  });
});

describe('t-087 / 7. query surface corpus', () => {
  it('should-fail: request with limit>200 is rejected at the contract layer', async () => {
    await expect(
      queryPolicyAudit({
        store: await createIsolatedTestStore(),
        request: { projectId: 'p1', limit: 201 },
      }),
    ).rejects.toThrow(/invalid_request|limit/);
  });

  it('should-fail: since > until rejected', async () => {
    await expect(
      queryPolicyAudit({
        store: await createIsolatedTestStore(),
        request: {
          projectId: 'p1',
          since: '2026-05-01T00:00:00.000Z',
          until: '2026-04-01T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/invalid_request|until/);
  });

  it('returns createdAt DESC/id DESC order and never leaks engagementId', async () => {
    const store = await createIsolatedTestStore();
    const registry = registerProject(makePolicy());
    const handshake = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      {
        registry,
        store: createInMemoryEngagementStore(),
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN_A,
        randomNonce: () => FIXED_NONCE_A,
      },
    );
    const sinks = [
      ['00000000-0000-0000-0000-000000000001', '2026-04-24T10:00:00.000Z'],
      ['00000000-0000-0000-0000-000000000002', '2026-04-24T10:00:01.000Z'],
      ['00000000-0000-0000-0000-000000000003', '2026-04-24T10:00:02.000Z'],
    ].map(([id, iso]) =>
      createPolicyAuditSink({
        store,
        engineId: 't087-engine',
        idFactory: () => id,
        clock: () => new Date(iso),
      }),
    );

    const grantSink = sinks[0];
    const revokeSink = sinks[1];
    const denySink = sinks[2];
    if (!grantSink || !revokeSink || !denySink) {
      throw new Error('expected three audit sinks');
    }

    await grantSink.recordHandshakeGrant(
      { projectId: 'p1', runId: 'run-q', correlationId: 'c1' },
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      handshake,
      1,
    );
    await revokeSink.recordRevoke(
      { projectId: 'p1', runId: 'run-q', correlationId: 'c1' },
      { kind: 'missing' },
      1,
    );
    await denySink.recordHandshakeDeny(
      { projectId: 'p1', runId: 'run-q', correlationId: 'c1' },
      { projectId: 'p1', folder: 'secrets' },
      new HandshakeError('policy_denied', 'denied', {
        projectId: 'p1',
        access: 'none',
      }),
      1,
    );

    const res = await queryPolicyAudit({
      store,
      request: { projectId: 'p1', limit: 50 },
    });
    expect(res.entries.length).toBe(3);
    expect(res.entries[0]?.createdAtIso >= res.entries[1]?.createdAtIso).toBe(
      true,
    );
    expect(res.entries[1]?.createdAtIso >= res.entries[2]?.createdAtIso).toBe(
      true,
    );
    for (const entry of res.entries) {
      expect(Object.keys(entry)).not.toContain('engagementId');
      expect(JSON.stringify(entry)).not.toContain(FIXED_NONCE_A);
      expect(JSON.stringify(entry)).not.toContain(FIXED_TOKEN_A);
    }
  });
});
