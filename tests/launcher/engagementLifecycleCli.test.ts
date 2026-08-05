/**
 * tests/launcher/engagementLifecycleCli.test.ts — launcher CLI flow
 * proof for the t-084 lifecycle subcommands.
 *
 * Exercises `hoplon project renew|revoke|prune` through the real
 * `runProjectCommand` runner over a registered project + folder
 * policy file. The engagement store is passed in explicitly so the
 * test can pre-seed an expired binding deterministically — the same
 * store used by `handshake` is shared with renewal / revocation /
 * prune, matching the production singleton wiring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseProjectCommand,
  runProjectCommand,
} from '../../src/hoplon/launcher/projectCli.js';
import {
  createInMemoryEngagementStore,
  __resetEngagementStoresForTests,
} from '../../src/hoplon/launcher/engagementStore.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePolicyFile(dir: string, policy: FolderPolicy): string {
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy));
  return file;
}

describe('project renew|revoke|prune CLI parsing (t-084)', () => {
  it('parses renew --token', () => {
    expect(parseProjectCommand(['renew', '--token', 'abc'])).toEqual({
      kind: 'renew',
      token: 'abc',
    });
  });

  it('parses revoke --token', () => {
    expect(parseProjectCommand(['revoke', '--token', 'abc'])).toEqual({
      kind: 'revoke',
      token: 'abc',
    });
  });

  it('parses prune with no flags', () => {
    expect(parseProjectCommand(['prune'])).toEqual({ kind: 'prune' });
  });

  it('rejects renew/revoke without --token', () => {
    expect(parseProjectCommand(['renew'])).toEqual({
      kind: 'error',
      message: 'renew requires --token',
    });
    expect(parseProjectCommand(['revoke'])).toEqual({
      kind: 'error',
      message: 'revoke requires --token',
    });
  });
});

describe('project renew|revoke|prune end-to-end CLI flow (t-084)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('renews a live handshake token and retires the previous one', () => {
    const launcherRoot = tmpDir('hoplon-t084-cli-renew-');
    const projectRoot = tmpDir('hoplon-t084-cli-project-');
    const policy: FolderPolicy = {
      defaultAccess: 'read_only',
      engagementTokenTtlMs: 60_000,
      folderRules: [{ folder: 'src', access: 'read_write' }],
    };
    const policyFile = writePolicyFile(launcherRoot, policy);

    const register = runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'p1',
        fsRoot: projectRoot,
        folderPolicyFile: policyFile,
      },
    );
    expect(register.ok).toBe(true);

    const store = createInMemoryEngagementStore();
    const handshake = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'src/hoplon' },
      { engagementStore: store },
    );
    expect(handshake.ok).toBe(true);
    if (!handshake.ok) return;
    const issuedToken = (
      handshake.body as { engagement: { token: string } }
    ).engagement.token;

    const renew = runProjectCommand(
      { root: launcherRoot },
      { kind: 'renew', token: issuedToken },
      { engagementStore: store },
    );
    expect(renew.ok).toBe(true);
    if (!renew.ok) return;
    const renewed = renew.body as {
      kind: string;
      previousToken: string;
      result: { access: string; engagement: { token: string } };
    };
    expect(renewed.kind).toBe('renewed');
    expect(renewed.previousToken).toBe(issuedToken);
    expect(renewed.result.access).toBe('read_write');
    expect(renewed.result.engagement.token).not.toBe(issuedToken);
    expect(store.get(issuedToken)).toBeNull();
    expect(store.get(renewed.result.engagement.token)).not.toBeNull();
  });

  it('returns reauth_required for an unknown token on renew', () => {
    const launcherRoot = tmpDir('hoplon-t084-cli-renew-missing-');
    const projectRoot = tmpDir('hoplon-t084-cli-project-missing-');
    const policyFile = writePolicyFile(launcherRoot, {
      defaultAccess: 'read_only',
      engagementTokenTtlMs: 60_000,
      folderRules: [],
    });
    runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'p1',
        fsRoot: projectRoot,
        folderPolicyFile: policyFile,
      },
    );

    const store = createInMemoryEngagementStore();
    const outcome = runProjectCommand(
      { root: launcherRoot },
      { kind: 'renew', token: 'ghost' },
      { engagementStore: store },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorKind).toBe('reauth_required');
    expect(outcome.message).toContain('missing');
  });

  it('revokes a live token and prune returns 0 removed for live bindings', () => {
    const launcherRoot = tmpDir('hoplon-t084-cli-revoke-');
    const projectRoot = tmpDir('hoplon-t084-cli-revoke-project-');
    const policyFile = writePolicyFile(launcherRoot, {
      defaultAccess: 'read_write',
      engagementTokenTtlMs: 60_000,
      folderRules: [],
    });
    runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'p1',
        fsRoot: projectRoot,
        folderPolicyFile: policyFile,
      },
    );

    const store = createInMemoryEngagementStore();
    const handshake = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'anywhere' },
      { engagementStore: store },
    );
    if (!handshake.ok) throw new Error('handshake failed');
    const token = (handshake.body as { engagement: { token: string } })
      .engagement.token;

    const revoke = runProjectCommand(
      { root: launcherRoot },
      { kind: 'revoke', token },
      { engagementStore: store },
    );
    expect(revoke.ok).toBe(true);
    expect(store.get(token)).toBeNull();

    const revokeAgain = runProjectCommand(
      { root: launcherRoot },
      { kind: 'revoke', token },
      { engagementStore: store },
    );
    expect(revokeAgain.ok).toBe(false);
    if (revokeAgain.ok) return;
    expect(revokeAgain.errorKind).toBe('missing_token');

    const prune = runProjectCommand(
      { root: launcherRoot },
      { kind: 'prune' },
      { engagementStore: store },
    );
    expect(prune.ok).toBe(true);
    if (!prune.ok) return;
    expect((prune.body as { removed: number }).removed).toBe(0);
  });

  it('prune drops pre-seeded expired bindings but leaves live ones', () => {
    const launcherRoot = tmpDir('hoplon-t084-cli-prune-');
    const store = createInMemoryEngagementStore();

    store.put('live-token'.padEnd(64, '0'), {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2026-04-23T00:00:00.000Z',
      expiresAtIso: '2099-01-01T00:00:00.000Z',
      nonce: 'n'.repeat(32),
    });
    store.put('stale-token'.padEnd(64, '0'), {
      projectId: 'p1',
      folder: 'docs',
      access: 'read_only',
      principalId: null,
      issuedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2025-01-01T00:01:00.000Z',
      nonce: 'm'.repeat(32),
    });

    const prune = runProjectCommand(
      { root: launcherRoot },
      { kind: 'prune' },
      { engagementStore: store },
    );
    expect(prune.ok).toBe(true);
    if (!prune.ok) return;
    expect((prune.body as { removed: number }).removed).toBe(1);
    expect(store.get('live-token'.padEnd(64, '0'))).not.toBeNull();
    expect(store.get('stale-token'.padEnd(64, '0'))).toBeNull();
  });
});
