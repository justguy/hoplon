/**
 * t-087 hard-gate proof corpus: false blocks and gated-access seam.
 *
 * Documents live false-block classes and proves the helper seam emits durable
 * access-check audit rows without changing TokenVerification. The helper is
 * not claimed to be on the default read/search/edit hot path on this branch.
 */
import { describe, it, expect } from 'vitest';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import { validateFolderPolicy } from '../../src/hoplon/concurrency/projectPolicyValidation.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import {
  HandshakeError,
  createInMemoryEngagementStore,
  issueProjectHandshake,
} from '../../src/hoplon/launcher/handshake.js';
import {
  renewEngagementToken,
  verifyEngagementToken,
} from '../../src/hoplon/launcher/engagementLifecycle.js';
import {
  auditedVerifyEngagementToken,
  createPolicyAuditSink,
} from '../../src/hoplon/transport/policyAuditSink.js';
import {
  brokenAuditStore,
  expectSingle,
  FIXED_NONCE_A,
  FIXED_NOW,
  FIXED_TOKEN_A,
  issueTestToken,
  makePolicy,
  registerProject,
} from './t087HardGateFixtures.js';

describe('t-087 / 8. false-block corpus', () => {
  it('FB-1: missing folderPolicy would deny every strict-gated read', () => {
    const registry = createProjectRegistry();
    registry.register({ projectId: 'p1', fsRoot: '/tmp/p1', policy: {} });
    expect(() =>
      issueProjectHandshake(
        { projectId: 'p1', folder: 'src' },
        { registry, store: createInMemoryEngagementStore() },
      ),
    ).toThrow(/has no folder-scoped policy/);
  });

  it('FB-2: renewal after principal removal returns reauth_required', () => {
    const registry = registerProject(makePolicy());
    const store = createInMemoryEngagementStore();
    const issued = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      {
        registry,
        store,
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN_A,
        randomNonce: () => FIXED_NONCE_A,
      },
    );
    registry.unregister('p1');
    registry.register({
      projectId: 'p1',
      fsRoot: '/tmp/p1',
      policy: {
        folderPolicy: validateFolderPolicy({
          defaultAccess: 'read_only',
          engagementTokenTtlMs: 60_000,
          folderRules: [{ folder: 'src', access: 'read_write' }],
          principals: [{ principalId: 'agent-a', kind: 'agent' }],
        }),
      },
    });
    const renewal = renewEngagementToken(store, issued.engagement.token, {
      registry,
      store,
      clock: () => new Date(FIXED_NOW.getTime() + 30_000),
    });
    expect(renewal).toEqual({
      kind: 'reauth_required',
      reason: 'unknown_principal',
    });
  });

  it('FB-3: client clock skew makes a server-valid binding look expired', () => {
    const { store, token } = issueTestToken();
    const skewedNow = new Date(FIXED_NOW.getTime() + 2 * 60_000);
    expect(verifyEngagementToken(store, token, { now: skewedNow }).kind).toBe(
      'expired',
    );
  });

  it('FB-4: narrower sub-path expectation mismatches coarse binding', () => {
    const { store, token } = issueTestToken();
    const r = verifyEngagementToken(store, token, {
      now: FIXED_NOW,
      folder: 'src/hoplon',
    });
    expect(r.kind).toBe('scope_mismatch');
  });

  it('FB-5: best-effort audit write survives store failure', async () => {
    const sink = createPolicyAuditSink({
      store: brokenAuditStore(),
      engineId: 't087-engine',
      clock: () => FIXED_NOW,
      onWriteFailure: () => {
        /* observability hook only */
      },
    });
    await expect(
      sink.recordHandshakeDeny(
        { projectId: 'p1', runId: 'run-fb5', correlationId: 'c' },
        { projectId: 'p1', folder: 'src' },
        new HandshakeError('unknown_project', 'missing', { projectId: 'p1' }),
        1,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('t-087 / 9. gated-access seam', () => {
  it('auditedVerifyEngagementToken writes one GRANTED access-check row', async () => {
    const store = await createIsolatedTestStore();
    const sink = createPolicyAuditSink({
      store,
      engineId: 't087-engine',
      clock: () => FIXED_NOW,
    });
    const { store: engagementStore, token } = issueTestToken();
    const verification = await auditedVerifyEngagementToken({
      sink,
      store: engagementStore,
      token,
      expectation: {
        now: FIXED_NOW,
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-b',
        requiredAccess: 'read_only',
      },
      action: 'read',
      context: { projectId: 'p1', runId: 'run-acc', correlationId: 'c' },
    });
    expect(verification.kind).toBe('valid');
    const row = expectSingle(
      await store.findAuditLogByProjectAndRun('p1', 'run-acc'),
      'access-check row',
    );
    expect(row.operation).toBe('POLICY_ACCESS_CHECK');
    expect(row.result).toBe('GRANTED');
    expect(row.policyEvent?.reasonCode).toBe('access_granted');
    expect(row.policyEvent?.engagementId).toBe(FIXED_NONCE_A);
    expect(JSON.stringify(row)).not.toContain(FIXED_TOKEN_A);
  });

  it('auditedVerifyEngagementToken returns expired and writes REAUTH_REQUIRED', async () => {
    const store = await createIsolatedTestStore();
    const sink = createPolicyAuditSink({
      store,
      engineId: 't087-engine',
      clock: () => new Date(FIXED_NOW.getTime() + 10 * 60_000),
    });
    const { store: engagementStore, token } = issueTestToken();
    const verification = await auditedVerifyEngagementToken({
      sink,
      store: engagementStore,
      token,
      expectation: {
        now: new Date(FIXED_NOW.getTime() + 10 * 60_000),
        projectId: 'p1',
        folder: 'src',
      },
      action: 'read',
      context: { projectId: 'p1', runId: 'run-exp', correlationId: 'c' },
    });
    expect(verification.kind).toBe('expired');
    const row = expectSingle(
      await store.findAuditLogByProjectAndRun('p1', 'run-exp'),
      'access-check row',
    );
    expect(row.result).toBe('REAUTH_REQUIRED');
    expect(row.policyEvent?.reasonCode).toBe('access_expired_token');
  });
});
