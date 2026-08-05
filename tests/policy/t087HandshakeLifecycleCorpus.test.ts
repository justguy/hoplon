/**
 * t-087 hard-gate proof corpus: handshake and lifecycle.
 *
 * Covers typed handshake outcomes plus verify, renew, revoke, expiry, and
 * cleanup behavior against the shipped launcher lifecycle implementation.
 */
import { describe, it, expect } from 'vitest';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import {
  HandshakeError,
  createInMemoryEngagementStore,
  issueProjectHandshake,
} from '../../src/hoplon/launcher/handshake.js';
import {
  pruneExpiredTokens,
  renewEngagementToken,
  revokeEngagementToken,
  verifyEngagementToken,
} from '../../src/hoplon/launcher/engagementLifecycle.js';
import {
  FIXED_NONCE_A,
  FIXED_NONCE_B,
  FIXED_NOW,
  FIXED_TOKEN_A,
  FIXED_TOKEN_B,
  issueTestToken,
  makePolicy,
  registerProject,
} from './t087HardGateFixtures.js';

describe('t-087 / 4. handshake denial corpus', () => {
  const policy = makePolicy();

  function deps() {
    const store = createInMemoryEngagementStore();
    return { store, registry: registerProject(policy) };
  }

  it('should-pass: matched read_write folder issues token', () => {
    const { store, registry } = deps();
    const res = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      {
        registry,
        store,
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN_A,
        randomNonce: () => FIXED_NONCE_A,
      },
    );
    expect(res.access).toBe('read_write');
    expect(res.engagement.token).toBe(FIXED_TOKEN_A);
    expect(Object.keys(res.engagement)).not.toContain('nonce');
  });

  it('should-fail: unknown_project surfaces typed HandshakeError', () => {
    const { store, registry } = deps();
    expect(() =>
      issueProjectHandshake(
        { projectId: 'does-not-exist', folder: 'src' },
        { registry, store },
      ),
    ).toThrow(HandshakeError);
  });

  it('should-fail: no_folder_policy on a project without folderPolicy', () => {
    const registry = createProjectRegistry();
    registry.register({ projectId: 'p2', fsRoot: '/tmp/p2', policy: {} });
    expect(() =>
      issueProjectHandshake(
        { projectId: 'p2', folder: 'src' },
        { registry, store: createInMemoryEngagementStore() },
      ),
    ).toThrow(/no_folder_policy|has no folder-scoped policy/);
  });

  it('should-fail: invalid_folder carries the canonicalization reason', () => {
    const { store, registry } = deps();
    try {
      issueProjectHandshake(
        { projectId: 'p1', folder: '/etc/passwd' },
        { registry, store },
      );
      throw new Error('expected handshake to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      if (err instanceof HandshakeError) {
        expect(err.kind).toBe('invalid_folder');
        expect(err.reason).toBe('absolute_path');
      }
    }
  });

  it('should-fail: policy_denied when resolved access is none', () => {
    const { store, registry } = deps();
    try {
      issueProjectHandshake(
        { projectId: 'p1', folder: 'secrets', principalId: 'agent-a' },
        { registry, store },
      );
      throw new Error('expected handshake to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      if (err instanceof HandshakeError) {
        expect(err.kind).toBe('policy_denied');
        expect(err.access).toBe('none');
      }
    }
  });

  it('should-fail: unknown_principal rejected before resolution', () => {
    const { store, registry } = deps();
    expect(() =>
      issueProjectHandshake(
        { projectId: 'p1', folder: 'src', principalId: 'ghost' },
        { registry, store },
      ),
    ).toThrow(/unknown_principal|not declared/);
  });
});

describe('t-087 / 5. lifecycle corpus', () => {
  it('should-pass: valid token verifies', () => {
    const { store, token } = issueTestToken();
    expect(verifyEngagementToken(store, token, { now: FIXED_NOW }).kind).toBe(
      'valid',
    );
  });

  it('should-fail: missing token surfaces missing (not a grant)', () => {
    const { store } = issueTestToken();
    expect(verifyEngagementToken(store, 'nonexistent', { now: FIXED_NOW }).kind)
      .toBe('missing');
  });

  it('should-fail: expired token surfaces expired with ISO now', () => {
    const { store, token } = issueTestToken();
    const later = new Date(FIXED_NOW.getTime() + 10 * 60_000);
    expect(verifyEngagementToken(store, token, { now: later }).kind).toBe(
      'expired',
    );
  });

  it('should-fail: scope mismatch on each narrow field', () => {
    const { store, token } = issueTestToken();
    expect(
      verifyEngagementToken(store, token, {
        now: FIXED_NOW,
        projectId: 'other',
      }).kind,
    ).toBe('scope_mismatch');
    expect(
      verifyEngagementToken(store, token, { now: FIXED_NOW, folder: 'docs' })
        .kind,
    ).toBe('scope_mismatch');
    expect(
      verifyEngagementToken(store, token, {
        now: FIXED_NOW,
        principalId: 'agent-a',
      }).kind,
    ).toBe('scope_mismatch');
    expect(
      verifyEngagementToken(store, token, {
        now: FIXED_NOW,
        requiredAccess: 'read_write',
      }).kind,
    ).toBe('valid');
    expect(
      verifyEngagementToken(store, token, {
        now: FIXED_NOW,
        requiredAccess: 'none' as never,
      }).kind,
    ).toBe('scope_mismatch');
  });

  it('should-pass: renewal returns a fresh binding under the same policy', () => {
    const { registry, store, token } = issueTestToken();
    const renewal = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => new Date(FIXED_NOW.getTime() + 30_000),
      randomToken: () => FIXED_TOKEN_B,
      randomNonce: () => FIXED_NONCE_B,
    });
    expect(renewal.kind).toBe('renewed');
  });

  it('should-fail: renewal after expiry forces reauth_required/expired', () => {
    const { registry, store, token } = issueTestToken();
    const renewal = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => new Date(FIXED_NOW.getTime() + 10 * 60_000),
    });
    expect(renewal).toEqual({ kind: 'reauth_required', reason: 'expired' });
  });

  it('should-pass: revoke then verify returns missing', () => {
    const { store, token } = issueTestToken();
    expect(revokeEngagementToken(store, token).kind).toBe('revoked');
    expect(verifyEngagementToken(store, token, { now: FIXED_NOW }).kind).toBe(
      'missing',
    );
  });

  it('should-pass: pruneExpiredTokens removes expired bindings only', () => {
    const { store, token } = issueTestToken();
    const report = pruneExpiredTokens(
      store,
      new Date(FIXED_NOW.getTime() + 10 * 60_000),
    );
    expect(report.removed).toBe(1);
    expect(verifyEngagementToken(store, token, { now: FIXED_NOW }).kind).toBe(
      'missing',
    );
  });
});
