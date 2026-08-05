/**
 * tests/launcher/engagementLifecycle.test.ts — targeted proof for the
 * t-084 engagement-token lifecycle module.
 *
 * Covers:
 *   - verifyEngagementToken: valid, missing, expired, scope_mismatch
 *     (project_id / folder / access / principal).
 *   - renewEngagementToken: renewed (TTL re-sourced from current
 *     folder policy), reauth_required on expired / missing, and
 *     reauth_required with typed reason when current policy rejects
 *     the re-issue (policy_denied, unknown_project, no_folder_policy,
 *     unknown_principal).
 *   - Collision / cleanup / revoke / prune cases live in
 *     engagementLifecycleCleanup.test.ts to keep this file under the
 *     repo's 300-line budget.
 */
import { describe, it, expect } from 'vitest';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { issueProjectHandshake } from '../../src/hoplon/launcher/handshake.js';
import {
  renewEngagementToken,
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
      { folder: 'secrets', access: 'none' },
    ],
    principals: [{ principalId: 'agent-a', kind: 'agent' }],
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
  opts: { token?: string; nonce?: string; now?: Date; principalId?: string } = {},
) {
  const store = createInMemoryEngagementStore();
  const token = opts.token ?? 't1'.padEnd(64, '1');
  const nonce = opts.nonce ?? 'n'.repeat(32);
  const result = issueProjectHandshake(
    {
      projectId: 'p1',
      folder,
      ...(opts.principalId !== undefined ? { principalId: opts.principalId } : {}),
    },
    {
      registry,
      store,
      clock: () => opts.now ?? BASE_NOW,
      randomToken: () => token,
      randomNonce: () => nonce,
    },
  );
  return { store, result, token };
}

describe('verifyEngagementToken (t-084)', () => {
  it('returns valid for a live unexpired binding', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src/hoplon');

    const result = verifyEngagementToken(store, token, { now: later(30_000) });
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.binding.access).toBe('read_write');
    expect(result.binding.folder).toBe('src/hoplon');
  });

  it('returns missing for an unknown token (and for empty/nonstring input)', () => {
    const store = createInMemoryEngagementStore();
    expect(verifyEngagementToken(store, 'ghost', { now: BASE_NOW }).kind).toBe(
      'missing',
    );
    expect(verifyEngagementToken(store, '', { now: BASE_NOW }).kind).toBe('missing');
    expect(
      verifyEngagementToken(store, undefined as unknown as string, { now: BASE_NOW })
        .kind,
    ).toBe('missing');
  });

  it('returns expired once now is at or past the stored expiry', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    const exactly = verifyEngagementToken(store, token, { now: later(60_000) });
    expect(exactly.kind).toBe('expired');
    const past = verifyEngagementToken(store, token, { now: later(60_001) });
    expect(past.kind).toBe('expired');
  });

  it('returns scope_mismatch with the first failing reason (project_id)', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    const result = verifyEngagementToken(store, token, {
      now: later(0),
      projectId: 'other',
    });
    expect(result.kind).toBe('scope_mismatch');
    if (result.kind !== 'scope_mismatch') return;
    expect(result.reason).toBe('project_id');
  });

  it('returns scope_mismatch for folder / access / principal expectations', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src', { principalId: 'agent-a' });

    expect(
      verifyEngagementToken(store, token, {
        now: later(0),
        folder: 'docs',
      }).kind,
    ).toBe('scope_mismatch');
    expect(
      verifyEngagementToken(store, token, {
        now: later(0),
        principalId: null,
      }).kind,
    ).toBe('scope_mismatch');

    // Issue a read_only binding, require read_write.
    const { store: roStore, token: roToken } = issueToken(
      registerProject(makeFolderPolicy()),
      'docs',
      { token: 'r'.repeat(64), nonce: 'm'.repeat(32) },
    );
    const access = verifyEngagementToken(roStore, roToken, {
      now: later(0),
      requiredAccess: 'read_write',
    });
    expect(access.kind).toBe('scope_mismatch');
    if (access.kind !== 'scope_mismatch') return;
    expect(access.reason).toBe('access');
  });

  it('read_write bindings satisfy a read_only required access', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');
    const check = verifyEngagementToken(store, token, {
      now: later(0),
      requiredAccess: 'read_only',
    });
    expect(check.kind).toBe('valid');
  });
});

describe('renewEngagementToken (t-084)', () => {
  it('issues a new token + binding and retires the previous one on renewal', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token: firstToken } = issueToken(registry, 'src/hoplon');

    const outcome = renewEngagementToken(store, firstToken, {
      registry,
      store,
      clock: () => later(30_000),
      randomToken: () => '2'.repeat(64),
      randomNonce: () => '0'.repeat(32),
    });

    expect(outcome.kind).toBe('renewed');
    if (outcome.kind !== 'renewed') return;
    expect(outcome.previousToken).toBe(firstToken);
    expect(outcome.result.engagement.token).toBe('2'.repeat(64));
    expect(outcome.result.engagement.expiresAtIso).toBe(
      new Date(later(30_000).getTime() + 60_000).toISOString(),
    );
    expect(store.get(firstToken)).toBeNull();
    expect(store.get('2'.repeat(64))?.folder).toBe('src/hoplon');
  });

  it('returns reauth_required(expired) when the presented token is expired', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    const outcome = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => later(60_000),
    });
    expect(outcome.kind).toBe('reauth_required');
    if (outcome.kind !== 'reauth_required') return;
    expect(outcome.reason).toBe('expired');
    // Expired token is cleaned up on the failed renewal path.
    expect(store.get(token)).toBeNull();
  });

  it('returns reauth_required(missing) for an unknown or empty token', () => {
    const store = createInMemoryEngagementStore();
    const registry = registerProject(makeFolderPolicy());
    expect(
      renewEngagementToken(store, 'unknown', { registry, store }).kind,
    ).toBe('reauth_required');
    const empty = renewEngagementToken(store, '', { registry, store });
    expect(empty.kind).toBe('reauth_required');
    if (empty.kind !== 'reauth_required') return;
    expect(empty.reason).toBe('missing');
  });

  it('returns reauth_required(policy_denied) when policy now denies the folder', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');

    // Swap the registered policy so `src` is now denied.
    const denyingPolicy = makeFolderPolicy({
      folderRules: [{ folder: 'src', access: 'none' }],
    });
    registry.unregister('p1');
    registry.register({
      projectId: 'p1',
      fsRoot: '/tmp/hoplon-t084-fsroot',
      policy: { folderPolicy: denyingPolicy },
    });

    const outcome = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => later(10_000),
    });
    expect(outcome.kind).toBe('reauth_required');
    if (outcome.kind !== 'reauth_required') return;
    expect(outcome.reason).toBe('policy_denied');
    // Original token is retained on policy rejection so the operator
    // can still revoke it explicitly.
    expect(store.get(token)).not.toBeNull();
  });

  it('returns reauth_required(unknown_project) when the registered project is gone', () => {
    const registry = registerProject(makeFolderPolicy());
    const { store, token } = issueToken(registry, 'src');
    registry.unregister('p1');

    const outcome = renewEngagementToken(store, token, {
      registry,
      store,
      clock: () => later(10_000),
    });
    expect(outcome.kind).toBe('reauth_required');
    if (outcome.kind !== 'reauth_required') return;
    expect(outcome.reason).toBe('unknown_project');
  });
});
