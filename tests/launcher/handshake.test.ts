/**
 * tests/launcher/handshake.test.ts — targeted proof for the t-083 project/
 * folder handshake surface.
 *
 * Covers the single handshake implementation consumed by the launcher CLI,
 * HTTP, and MCP transports:
 *
 *   - `issueProjectHandshake` happy paths: read_only matched rule,
 *     read_write matched rule, default-policy fallback on unmatched folder.
 *   - Envelope invariants: canonical folder, TTL, issuedAt/expiresAt,
 *     principal binding, matched-rule provenance, server-private nonce not
 *     leaked on the agent envelope.
 *   - Engagement store captures the binding (server-private nonce survives)
 *     so t-084 can layer lifecycle / revocation on top.
 *   - Typed failure kinds: unknown_project, no_folder_policy,
 *     invalid_folder (with a reason), policy_denied, unknown_principal.
 *   - Launcher `runProjectCommand` CLI runner: handshake subcommand end to
 *     end over real launcher persistence (register → handshake → list).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HandshakeError,
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
  issueProjectHandshake,
  openEngagementStore,
} from '../../src/hoplon/launcher/handshake.js';
import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import {
  parseProjectCommand,
  runProjectCommand,
} from '../../src/hoplon/launcher/projectCli.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function registerWithPolicy(policy: FolderPolicy) {
  const registry = createProjectRegistry();
  const record = registry.register({
    projectId: 'p1',
    fsRoot: '/tmp/hoplon-test-fsroot',
    policy: { folderPolicy: policy },
  });
  return { registry, record };
}

const FIXED_NOW = new Date('2026-04-23T10:00:00.000Z');
const FIXED_TOKEN = 'f'.repeat(64);
const FIXED_NONCE = '0'.repeat(32);

function fixedDeps(registry: ReturnType<typeof createProjectRegistry>) {
  const store = createInMemoryEngagementStore();
  return {
    store,
    deps: {
      registry,
      store,
      clock: () => FIXED_NOW,
      randomToken: () => FIXED_TOKEN,
      randomNonce: () => FIXED_NONCE,
    },
  };
}

describe('issueProjectHandshake (t-083 core)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('issues a read_write envelope when a folder rule matches', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { store, deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: 'src/hoplon' },
      deps,
    );

    expect(result.access).toBe('read_write');
    expect(result.resolution).toBe('matched');
    expect(result.matchedRule).toEqual({ folder: 'src', index: 0 });
    expect(result.folder).toBe('src/hoplon');
    expect(result.principalId).toBeNull();
    expect(result.engagement.token).toBe(FIXED_TOKEN);
    expect(result.engagement.folder).toBe('src/hoplon');
    expect(result.engagement.access).toBe('read_write');
    expect(result.engagement.issuedAtIso).toBe(FIXED_NOW.toISOString());
    expect(result.engagement.expiresAtIso).toBe(
      new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
    );
    // Server-private nonce is never echoed on the envelope.
    expect(
      (result.engagement as unknown as Record<string, unknown>)['nonce'],
    ).toBeUndefined();

    // But the store retains the full binding including nonce for t-084.
    const binding = store.get(FIXED_TOKEN);
    expect(binding).not.toBeNull();
    expect(binding?.nonce).toBe(FIXED_NONCE);
    expect(binding?.access).toBe('read_write');
    expect(binding?.folder).toBe('src/hoplon');
  });

  it('issues a read_only envelope when a matched rule is read_only', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: 'docs/arch' },
      deps,
    );

    expect(result.access).toBe('read_only');
    expect(result.resolution).toBe('matched');
    expect(result.matchedRule?.folder).toBe('docs');
    expect(result.engagement.access).toBe('read_only');
  });

  it('falls back to defaultAccess when no rule matches', () => {
    const { registry } = registerWithPolicy(
      makeFolderPolicy({ defaultAccess: 'read_only' }),
    );
    const { deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: 'tooling' },
      deps,
    );

    expect(result.resolution).toBe('default_fallback');
    expect(result.access).toBe('read_only');
    expect(result.matchedRule).toBeNull();
    expect(result.engagement.folder).toBe('tooling');
  });

  it('treats an empty folder as the project root', () => {
    const { registry } = registerWithPolicy(
      makeFolderPolicy({
        folderRules: [{ folder: '', access: 'read_write' }],
      }),
    );
    const { deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: '' },
      deps,
    );

    expect(result.resolution).toBe('matched');
    expect(result.access).toBe('read_write');
    expect(result.folder).toBe('');
    expect(result.matchedRule).toEqual({ folder: '', index: 0 });
    expect(result.engagement.folder).toBe('');
  });

  it('treats exact dot as a handshake-only project-root alias', () => {
    const { registry } = registerWithPolicy(
      makeFolderPolicy({
        folderRules: [{ folder: '', access: 'read_write' }],
      }),
    );
    const { deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: '.' },
      deps,
    );

    expect(result.resolution).toBe('matched');
    expect(result.access).toBe('read_write');
    expect(result.folder).toBe('');
    expect(result.matchedRule).toEqual({ folder: '', index: 0 });
    expect(result.engagement.folder).toBe('');
  });

  it('still rejects dot segments inside non-root folders', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);

    try {
      issueProjectHandshake({ projectId: 'p1', folder: 'src/./hoplon' }, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_folder');
      expect((err as HandshakeError).reason).toBe('dot_segment');
    }
  });

  it('binds the envelope to the canonical folder, not the raw input bytes', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);

    const result = issueProjectHandshake(
      { projectId: 'p1', folder: 'src/hoplon/' },
      deps,
    );
    expect(result.folder).toBe('src/hoplon');
    expect(result.engagement.folder).toBe('src/hoplon');
  });

  it('rejects an unknown project with kind unknown_project', () => {
    const registry = createProjectRegistry();
    const { deps } = fixedDeps(registry);
    expect(() =>
      issueProjectHandshake({ projectId: 'missing', folder: 'src' }, deps),
    ).toThrowError(HandshakeError);
    try {
      issueProjectHandshake({ projectId: 'missing', folder: 'src' }, deps);
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('unknown_project');
      expect((err as HandshakeError).registeredProjectIds).toEqual([]);
      expect((err as HandshakeError).recoveryHelp).toContain(
        'Register the target folder',
      );
    }
  });

  it('rejects malformed request fields with kind invalid_request', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);

    try {
      issueProjectHandshake({ projectId: '', folder: 'src' }, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_request');
    }

    try {
      issueProjectHandshake(
        { projectId: 'p1', folder: 'src', principalId: '' },
        deps,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_request');
    }
  });

  it('rejects a registered project that has no folderPolicy', () => {
    const registry = createProjectRegistry();
    registry.register({
      projectId: 'raw',
      fsRoot: '/tmp/raw',
    });
    const { deps } = fixedDeps(registry);
    try {
      issueProjectHandshake({ projectId: 'raw', folder: 'src' }, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('no_folder_policy');
      expect((err as HandshakeError).projectId).toBe('raw');
      expect((err as HandshakeError).recoveryHelp).toContain(
        '--folder-policy-file',
      );
      expect((err as HandshakeError).recoveryHelp).toContain(
        'trusted host-shell authority',
      );
    }
  });

  it('rejects a malformed folder (absolute path) with kind invalid_folder', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      issueProjectHandshake({ projectId: 'p1', folder: '/etc/passwd' }, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_folder');
      expect((err as HandshakeError).reason).toBe('absolute_path');
    }
  });

  it('rejects a folder whose rule resolves to none with policy_denied', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      issueProjectHandshake({ projectId: 'p1', folder: 'secrets' }, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('policy_denied');
      expect((err as HandshakeError).access).toBe('none');
    }
  });

  it('rejects an unknown principalId even when the folder would otherwise match', () => {
    const { registry } = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      issueProjectHandshake(
        { projectId: 'p1', folder: 'src', principalId: 'ghost' },
        deps,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('unknown_principal');
    }
  });

  it('honors principal-specific rules when principalId matches', () => {
    const policy = makeFolderPolicy({
      principals: [
        { principalId: 'agent-a', kind: 'agent' },
        { principalId: 'agent-b', kind: 'agent' },
      ],
      folderRules: [
        { folder: 'src', access: 'read_only' },
        { folder: 'src', access: 'read_write', appliesToPrincipalIds: ['agent-a'] },
      ],
    });
    const { registry } = registerWithPolicy(policy);
    const { deps } = fixedDeps(registry);

    const agentA = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-a' },
      deps,
    );
    expect(agentA.access).toBe('read_write');

    const agentB = issueProjectHandshake(
      { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
      deps,
    );
    expect(agentB.access).toBe('read_only');
  });
});

describe('openEngagementStore (shared-by-launcher-root)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('returns the same instance for the same launcher root', () => {
    const a = openEngagementStore('/tmp/root-a');
    const b = openEngagementStore('/tmp/root-a');
    expect(a).toBe(b);
    const resolvedEquivalent = openEngagementStore('/tmp/root-a/.');
    expect(resolvedEquivalent).toBe(a);
    const c = openEngagementStore('/tmp/root-b');
    expect(c).not.toBe(a);
  });
});

describe('runProjectCommand handshake (launcher CLI flow)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('parses the handshake subcommand flags correctly', () => {
    const parsed = parseProjectCommand([
      'handshake',
      '--project-id',
      'p1',
      '--folder',
      'src/hoplon',
      '--principal-id',
      'agent-a',
    ]);
    expect(parsed).toEqual({
      kind: 'handshake',
      projectId: 'p1',
      folder: 'src/hoplon',
      principalId: 'agent-a',
    });
  });

  it('rejects handshake without --project-id and --folder', () => {
    expect(parseProjectCommand(['handshake'])).toEqual({
      kind: 'error',
      message: 'handshake requires --project-id',
    });
    expect(parseProjectCommand(['handshake', '--project-id', 'p1'])).toEqual({
      kind: 'error',
      message: 'handshake requires --folder',
    });
    expect(
      parseProjectCommand([
        'handshake',
        '--project-id',
        'p1',
        '--folder',
        'src',
        '--principal-id=',
      ]),
    ).toEqual({
      kind: 'error',
      message: 'handshake requires non-empty --principal-id',
    });
  });

  it('parses root-folder handshakes as an explicit empty folder', () => {
    const parsed = parseProjectCommand([
      'handshake',
      '--project-id',
      'p1',
      '--folder=',
    ]);
    expect(parsed).toEqual({
      kind: 'handshake',
      projectId: 'p1',
      folder: '',
    });
  });

  it('runs a handshake end-to-end over a registered project + folder policy file', () => {
    const launcherRoot = tmpDir('hoplon-t083-cli-');
    const projectRoot = tmpDir('hoplon-t083-project-');
    const policyFile = path.join(launcherRoot, 'policy.json');
    const policyBody = {
      defaultAccess: 'read_only',
      engagementTokenTtlMs: 60_000,
      folderRules: [
        { folder: 'src', access: 'read_write' },
        { folder: 'secrets', access: 'none' },
      ],
    };
    fs.writeFileSync(policyFile, JSON.stringify(policyBody));

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
    const readWrite = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'src/hoplon' },
      { engagementStore: store },
    );
    expect(readWrite.ok).toBe(true);
    if (!readWrite.ok) return;
    const rw = readWrite.body as {
      access: string;
      folder: string;
      resolution: string;
      engagement: { token: string; expiresAtIso: string };
    };
    expect(rw.access).toBe('read_write');
    expect(rw.resolution).toBe('matched');
    expect(rw.folder).toBe('src/hoplon');
    expect(rw.engagement.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = store.get(rw.engagement.token);
    expect(stored?.access).toBe('read_write');

    const fallback = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'tools' },
      { engagementStore: store },
    );
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect((fallback.body as { resolution: string }).resolution).toBe(
      'default_fallback',
    );
    expect((fallback.body as { access: string }).access).toBe('read_only');

    const root = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: '' },
      { engagementStore: store },
    );
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect((root.body as { folder: string }).folder).toBe('');
    expect((root.body as { access: string }).access).toBe('read_only');

    const dotRoot = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: '.' },
      { engagementStore: store },
    );
    expect(dotRoot.ok).toBe(true);
    if (!dotRoot.ok) return;
    expect((dotRoot.body as { folder: string }).folder).toBe('');
    expect((dotRoot.body as { access: string }).access).toBe('read_only');

    const denied = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'secrets' },
      { engagementStore: store },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.errorKind).toBe('policy_denied');

    const invalid = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: '../escape' },
      { engagementStore: store },
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.errorKind).toBe('invalid_folder');

    const unknown = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'nope', folder: 'src' },
      { engagementStore: store },
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errorKind).toBe('unknown_project');
  });

  it('returns no_folder_policy before folder validation for registered projects without a policy', () => {
    const launcherRoot = tmpDir('hoplon-t083-cli-no-policy-');
    const projectRoot = tmpDir('hoplon-t083-project-no-policy-');
    const register = runProjectCommand(
      { root: launcherRoot },
      { kind: 'register', projectId: 'raw', fsRoot: projectRoot },
    );
    expect(register.ok).toBe(true);

    const concrete = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'raw', folder: 'src' },
    );
    expect(concrete.ok).toBe(false);
    if (concrete.ok) return;
    expect(concrete.errorKind).toBe('no_folder_policy');
    expect(concrete.message).toContain('Help:');
    expect(concrete.message).toContain('--folder-policy-file');
    expect(concrete.message).toContain('trusted host-shell authority');

    const root = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'raw', folder: '' },
    );
    expect(root.ok).toBe(false);
    if (root.ok) return;
    expect(root.errorKind).toBe('no_folder_policy');
    expect(root.message).toContain('--folder-policy-file');
    expect(root.message).toContain('trusted host-shell authority');
  });

  it('re-opens the launcher and re-issues handshakes off the persisted policy', () => {
    const launcherRoot = tmpDir('hoplon-t083-persist-');
    const projectRoot = tmpDir('hoplon-t083-project-persist-');
    const policyFile = path.join(launcherRoot, 'policy.json');
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        defaultAccess: 'read_write',
        engagementTokenTtlMs: 60_000,
        folderRules: [],
      }),
    );

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

    // Re-open by building a fresh manager against the same root.
    const reopened = openLauncherProjects(launcherRoot);
    const project = reopened.get('p1');
    expect(project?.policy.folderPolicy?.defaultAccess).toBe('read_write');

    const handshake = runProjectCommand(
      { root: launcherRoot },
      { kind: 'handshake', projectId: 'p1', folder: 'anywhere' },
    );
    expect(handshake.ok).toBe(true);
    if (!handshake.ok) return;
    const body = handshake.body as { access: string; resolution: string };
    expect(body.resolution).toBe('default_fallback');
    expect(body.access).toBe('read_write');
  });
});
