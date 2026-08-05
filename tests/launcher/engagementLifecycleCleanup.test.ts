/**
 * tests/launcher/engagementLifecycleCleanup.test.ts - revoke, prune, and
 * defensive edge-case proof for the t-084 engagement-token lifecycle.
 */
import { describe, it, expect } from 'vitest';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { issueProjectHandshake } from '../../src/hoplon/launcher/handshake.js';
import {
  pruneExpiredTokens,
  renewEngagementToken,
  revokeEngagementToken,
  verifyEngagementToken,
} from '../../src/hoplon/launcher/engagementLifecycle.js';

const BASE_NOW = new Date('2026-04-23T10:00:00.000Z');

function later(offsetMs: number): Date {
  return new Date(BASE_NOW.getTime() + offsetMs);
}

function makeFolderPolicy(overrides: Partial<FolderPolicy> = {}): FolderPolicy {
  const base: FolderPolicy = {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'docs', access: 'read_only' },
    ],
  };
  return { ...base, ...overrides };
}

function registerProject(policy: FolderPolicy) {
  const registry = createProjectRegistry();
  registry.register({
    projectId: 'p1',
    fsRoot: '/tmp/hoplon-t084-fsroot',
    policy: { folderPolicy: policy },
  });
  return registry;
}

function issueToken(
  registry: ReturnType<typeof createProjectRegistry>,
  folder: string,
  opts: { token?: string; nonce?: string; now?: Date } = {},
) {
  const store = createInMemoryEngagementStore();
  const token = opts.token ?? 't1'.padEnd(64, '1');
  issueProjectHandshake(
    { projectId: 'p1', folder },
    {
      registry,
      store,
      clock: () => opts.now ?? BASE_NOW,
      randomToken: () => token,
      randomNonce: () => opts.nonce ?? 'n'.repeat(32),
    },
  );
  return { store, token };
}

function putBinding(
  store: EngagementStore,
  token: string,
  expiresAtIso: string,
): void {
  store.put(token, {
    projectId: 'p1',
    folder: 'src',
    access: 'read_write',
    principalId: null,
    issuedAtIso: BASE_NOW.toISOString(),
    expiresAtIso,
    nonce: 'n'.repeat(32),
  });
}

describe('renewEngagementToken defensive edges (t-084)', () => {
  it('does not delete the refreshed binding when renewal reuses the same token', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    const outcome = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => later(30_000),
      randomToken: () => token,
      randomNonce: () => '0'.repeat(32),
    });

    expect(outcome.kind).toBe('renewed');
    expect(store.get(token)).not.toBeNull();
    expect(
      verifyEngagementToken(store, token, { now: later(60_001) }).kind,
    ).toBe('valid');
  });

  it('treats a malformed expiry as expired and removes it on renew', () => {
    const registry = registerProject(makeFolderPolicy());
    const store = createInMemoryEngagementStore();
    putBinding(store, 'bad-expiry', 'not-a-date');

    expect(
      verifyEngagementToken(store, 'bad-expiry', { now: BASE_NOW }).kind,
    ).toBe('expired');
    const outcome = renewEngagementToken(store, 'bad-expiry', { registry, store });
    expect(outcome.kind).toBe('reauth_required');
    if (outcome.kind !== 'reauth_required') return;
    expect(outcome.reason).toBe('expired');
    expect(store.get('bad-expiry')).toBeNull();
  });
});

describe('revokeEngagementToken (t-084)', () => {
  it('removes the binding and subsequent verify observes missing', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    expect(revokeEngagementToken(store, token).kind).toBe('revoked');
    expect(verifyEngagementToken(store, token, { now: BASE_NOW }).kind).toBe(
      'missing',
    );
  });

  it('returns missing for an unknown token', () => {
    const store = createInMemoryEngagementStore();
    expect(revokeEngagementToken(store, 'ghost').kind).toBe('missing');
    expect(revokeEngagementToken(store, '').kind).toBe('missing');
  });

  it('revocation does not disturb other live bindings', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store: storeA, token: tokenA } = issueToken(registry, 'src', {
      token: 'a'.repeat(64),
    });
    issueProjectHandshake(
      { projectId: 'p1', folder: 'docs' },
      {
        registry,
        store: storeA,
        clock: () => BASE_NOW,
        randomToken: () => 'b'.repeat(64),
        randomNonce: () => 'x'.repeat(32),
      },
    );

    revokeEngagementToken(storeA, tokenA);
    expect(storeA.get('b'.repeat(64))?.folder).toBe('docs');
  });
});

describe('pruneExpiredTokens (t-084)', () => {
  it('removes every expired binding and returns the count', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store } = issueToken(registry, 'src', { token: 'a'.repeat(64) });
    issueProjectHandshake(
      { projectId: 'p1', folder: 'docs' },
      {
        registry,
        store,
        clock: () => BASE_NOW,
        randomToken: () => 'b'.repeat(64),
        randomNonce: () => '1'.repeat(32),
      },
    );
    issueProjectHandshake(
      { projectId: 'p1', folder: 'docs/arch' },
      {
        registry,
        store,
        clock: () => later(30_000),
        randomToken: () => 'c'.repeat(64),
        randomNonce: () => '2'.repeat(32),
      },
    );

    const report = pruneExpiredTokens(store, later(60_000));
    expect(report.removed).toBe(2);
    expect(store.get('a'.repeat(64))).toBeNull();
    expect(store.get('b'.repeat(64))).toBeNull();
    expect(store.get('c'.repeat(64))).not.toBeNull();
  });

  it('treats malformed expiry as removable', () => {
    const store = createInMemoryEngagementStore();
    putBinding(store, 'bad-expiry', 'not-a-date');

    const report = pruneExpiredTokens(store, BASE_NOW);
    expect(report.removed).toBe(1);
    expect(store.get('bad-expiry')).toBeNull();
  });

  it('returns zero when every binding is still live', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store } = issueToken(registry, 'src');
    const report = pruneExpiredTokens(store, later(0));
    expect(report.removed).toBe(0);
  });

  it('returns zero on an empty store', () => {
    const store = createInMemoryEngagementStore();
    const report = pruneExpiredTokens(store, BASE_NOW);
    expect(report.removed).toBe(0);
  });
});
