/**
 * tests/launcher/handshakeAuthz.test.ts — proof for the T-146
 * adapter-backed handshake (`issueProjectHandshakeViaAdapter`).
 *
 * Covers:
 *   1. allow path (default StaticAuthorizationAdapter) — read_write,
 *      read_only, default_fallback.
 *   2. requires_escalation path (fake adapter).
 *   3. requires_approval path (fake adapter).
 *   4. deny path (fake adapter and static adapter).
 *   5. Malformed request — missing projectId, unknown project,
 *      no_folder_policy, unknown principal, invalid_folder reason.
 *   6. Missing adapter — defaults to static (no exception).
 *   7. Adapter throwing — fail-closed (typed deny result, no token).
 *   8. Adapter returning malformed allow with expiresInSeconds<=0 → fail-closed.
 *   9. Adapter returning allow with empty capabilities → fail-closed.
 *  10. Backward-compat shim — `access` derivation from capabilities.
 *  11. TTL ownership — adapter-derived expiresInSeconds drives envelope.
 *  12. Concurrent calls — no shared mutable state.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  issueProjectHandshakeViaAdapter,
  legacyAccessFromCapabilities,
} from '../../src/hoplon/launcher/handshakeAuthz.js';
import {
  __resetEngagementStoresForTests,
  createInMemoryEngagementStore,
  HandshakeError,
} from '../../src/hoplon/launcher/handshake.js';
import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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
  registry.register({
    projectId: 'p1',
    fsRoot: '/tmp/hoplon-t146-fsroot',
    policy: { folderPolicy: policy },
  });
  return registry;
}

const FIXED_NOW = new Date('2026-05-03T08:00:00.000Z');
const FIXED_TOKEN = 'abc' + 'd'.repeat(61);
const FIXED_NONCE = 'a'.repeat(32);
const FIXED_TOKEN_ID = 'tk_t146_' + 'b'.repeat(20);

function fixedDeps(
  registry: ReturnType<typeof createProjectRegistry>,
  adapter?: AuthorizationAdapter,
) {
  const store = createInMemoryEngagementStore();
  return {
    store,
    deps: {
      registry,
      store,
      ...(adapter !== undefined ? { adapter } : {}),
      clock: () => FIXED_NOW,
      randomToken: () => FIXED_TOKEN,
      randomNonce: () => FIXED_NONCE,
      generateTokenId: () => FIXED_TOKEN_ID,
      sessionId: 'sess-t146',
      taskId: 'task-t146',
      engineName: 'static',
    },
  };
}

class StubAdapter implements AuthorizationAdapter {
  public lastRequest: HoplonAuthorizationRequest | null = null;
  public callCount = 0;
  constructor(
    private readonly buildDecision: (
      req: HoplonAuthorizationRequest,
    ) => HoplonAuthorizationDecision | Promise<HoplonAuthorizationDecision>,
  ) {}
  async evaluateAccess(
    request: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision> {
    this.callCount += 1;
    this.lastRequest = request;
    return await this.buildDecision(request);
  }
}

class ThrowingAdapter implements AuthorizationAdapter {
  constructor(private readonly err: unknown) {}
  evaluateAccess(): Promise<HoplonAuthorizationDecision> {
    return Promise.reject(this.err);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('issueProjectHandshakeViaAdapter (T-146)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('returns allow with capability token for read_write match (default static adapter)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { store, deps } = fixedDeps(registry);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src/hoplon' },
      deps,
    );

    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(result.access).toBe('read_write');
    expect(result.folder).toBe('src/hoplon');
    expect(result.resolution).toBe('matched');
    expect(result.matchedRule).toEqual({ folder: 'src', index: 0 });
    expect(result.engagement.token).toBe(FIXED_TOKEN);
    expect(result.engagement.access).toBe('read_write');
    expect(result.capabilities.write).toBeDefined();
    expect(result.capabilities.read).toBeDefined();
    expect(result.expiresInSeconds).toBe(60); // ttl 60_000ms → 60s
    expect(result.policyVersion).toMatch(/static-folder-policy/);
    expect(result.decisionId).toBeTruthy();
    expect(result.source).toBe('standing_policy');
    expect(result.capabilityToken.tokenId).toBe(FIXED_TOKEN_ID);
    expect(result.capabilityToken.policy.engine).toBe('static');
    expect(result.capabilityToken.policy.policyVersion).toBe(
      result.policyVersion,
    );
    expect(result.capabilityToken.taskId).toBe('task-t146');
    expect(result.capabilityToken.sessionId).toBe('sess-t146');

    // Engagement store carries the legacy binding (T-147 will extend).
    const binding = store.get(FIXED_TOKEN);
    expect(binding?.access).toBe('read_write');
    expect(binding?.folder).toBe('src/hoplon');
  });

  it('returns allow with read_only capabilities for default fallback', async () => {
    const registry = registerWithPolicy(
      makeFolderPolicy({ defaultAccess: 'read_only' }),
    );
    const { deps } = fixedDeps(registry);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'tools' },
      deps,
    );
    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(result.access).toBe('read_only');
    expect(result.resolution).toBe('default_fallback');
    expect(result.capabilities.write).toBeUndefined();
    expect(result.capabilities.read).toBeDefined();
  });

  it('static adapter on a none folder yields a typed deny (no token)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { store, deps } = fixedDeps(registry);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'secrets' },
      deps,
    );

    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') return;
    expect(result.access).toBe('none');
    expect(result.reason).toMatch(/denied/i);
    expect(result.decisionId).toBeTruthy();
    expect(result.policyVersion).toMatch(/static-folder-policy/);
    // No token written.
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('returns requires_escalation when adapter emits it (no mint)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(() => ({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['**'], branches: ['**'] } },
      reason: 'Write requires CTO approval',
      decisionId: 'dec-esc-1',
      policyVersion: 'opa-bundle-v9',
    }));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('requires_escalation');
    if (result.kind !== 'requires_escalation') return;
    expect(result.escalationKind).toBe('cto_approval');
    expect(result.reason).toBe('Write requires CTO approval');
    expect(result.decisionId).toBe('dec-esc-1');
    expect(result.policyVersion).toBe('opa-bundle-v9');
    // No token minted, store unchanged.
    expect(store.get(FIXED_TOKEN)).toBeNull();
    // Adapter received the typed request.
    expect(adapter.lastRequest?.request.projectId).toBe('p1');
    expect(adapter.lastRequest?.request.branch).toBe('**');
  });

  it('returns requires_approval when adapter emits it (no mint)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(() => ({
      outcome: 'requires_approval',
      escalationKind: 'human_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'Human-in-the-loop approval required',
      decisionId: 'dec-app-1',
      policyVersion: 'opa-bundle-v9',
    }));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('requires_approval');
    if (result.kind !== 'requires_approval') return;
    expect(result.escalationKind).toBe('human_approval');
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('returns deny when adapter emits deny (no mint)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(() => ({
      outcome: 'deny',
      reason: 'Forbidden by branch policy',
      decisionId: 'dec-deny-1',
      policyVersion: 'opa-bundle-v9',
    }));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') return;
    expect(result.access).toBe('none');
    expect(result.reason).toBe('Forbidden by branch policy');
    expect(result.decisionId).toBe('dec-deny-1');
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('throws HandshakeError(unknown_project) for unregistered projects', async () => {
    const registry = createProjectRegistry();
    const { deps } = fixedDeps(registry);
    await expect(
      issueProjectHandshakeViaAdapter(
        { projectId: 'ghost', folder: 'src' },
        deps,
      ),
    ).rejects.toThrowError(HandshakeError);
  });

  it('throws HandshakeError(invalid_request) for empty projectId', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      await issueProjectHandshakeViaAdapter(
        { projectId: '', folder: 'src' },
        deps,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_request');
    }
  });

  it('throws HandshakeError(invalid_folder) for absolute path with reason', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      await issueProjectHandshakeViaAdapter(
        { projectId: 'p1', folder: '/etc/passwd' },
        deps,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('invalid_folder');
      expect((err as HandshakeError).reason).toBe('absolute_path');
    }
  });

  it('throws HandshakeError(unknown_principal) for an undeclared principal', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    try {
      await issueProjectHandshakeViaAdapter(
        { projectId: 'p1', folder: 'src', principalId: 'ghost' },
        deps,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).kind).toBe('unknown_principal');
    }
  });

  it('default adapter is StaticAuthorizationAdapter (no explicit injection required)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const { deps } = fixedDeps(registry);
    // Omit `adapter` entirely.
    const denylessDeps = { ...deps };
    delete (denylessDeps as Partial<typeof deps>).adapter;
    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'docs/arch' },
      denylessDeps,
    );
    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(result.access).toBe('read_only');
    expect(result.policyVersion).toMatch(/static-folder-policy/);
  });

  it('fail-closes when the adapter throws (typed deny, no mint)', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new ThrowingAdapter(new Error('OPA sidecar timed out'));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') return;
    expect(result.reason).toMatch(/adapter_error: OPA sidecar timed out/);
    expect(result.policyVersion).toBe('adapter-error');
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('fail-closes when adapter returns allow with expiresInSeconds<=0', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(() => ({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: {
        read: { paths: ['**'], branches: ['**'] },
        search: { paths: ['**'], branches: ['**'] },
      },
      expiresInSeconds: 0,
      decisionId: 'dec-zero-ttl',
      policyVersion: 'test-bundle',
    }));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') return;
    expect(result.reason).toBe('adapter_invalid_expires_in_seconds');
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('fail-closes when adapter returns allow with empty capabilities', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(() => ({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: {}, // Empty — no read/search/write.
      expiresInSeconds: 60,
      decisionId: 'dec-empty-caps',
      policyVersion: 'test-bundle',
    }));
    const { store, deps } = fixedDeps(registry, adapter);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') return;
    expect(result.reason).toBe('adapter_allow_with_empty_capabilities');
    expect(store.get(FIXED_TOKEN)).toBeNull();
  });

  it('legacyAccessFromCapabilities derives the legacy access shim', () => {
    expect(
      legacyAccessFromCapabilities({
        write: { paths: ['**'], branches: ['**'] },
        read: { paths: ['**'], branches: ['**'] },
      }),
    ).toBe('read_write');
    expect(
      legacyAccessFromCapabilities({
        read: { paths: ['**'], branches: ['**'] },
        search: { paths: ['**'], branches: ['**'] },
      }),
    ).toBe('read_only');
    expect(
      legacyAccessFromCapabilities({
        search: { paths: ['**'], branches: ['**'] },
      }),
    ).toBe('read_only');
    expect(legacyAccessFromCapabilities({})).toBe('none');
  });

  it('TTL ownership: adapter expiresInSeconds drives engagement envelope (custom)', async () => {
    const registry = registerWithPolicy(
      makeFolderPolicy({ engagementTokenTtlMs: 5 * 60_000 }), // 5 min
    );
    const { deps } = fixedDeps(registry);

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src' },
      deps,
    );
    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(result.expiresInSeconds).toBe(300);
    const issuedAt = Date.parse(result.engagement.issuedAtIso);
    const expiresAt = Date.parse(result.engagement.expiresAtIso);
    expect(expiresAt - issuedAt).toBe(300 * 1000);
  });

  it('handles concurrent calls without sharing mutable state', async () => {
    const registry = registerWithPolicy(makeFolderPolicy());
    const adapter = new StubAdapter(async (req) => {
      // Simulate latency to interleave calls.
      await new Promise((r) => setTimeout(r, 1));
      return {
        outcome: 'allow',
        source: 'standing_policy',
        capabilities: {
          read: { paths: ['**'], branches: ['**'] },
          search: { paths: ['**'], branches: ['**'] },
        },
        expiresInSeconds: 60,
        decisionId: `dec-${req.task.id}`,
        policyVersion: 'test-bundle',
      };
    });
    // Use random tokens for this concurrent test (so we get distinct entries).
    const store = createInMemoryEngagementStore();
    const baseDeps = {
      registry,
      store,
      adapter,
      clock: () => FIXED_NOW,
    };

    const results = await Promise.all([
      issueProjectHandshakeViaAdapter(
        { projectId: 'p1', folder: 'docs' },
        { ...baseDeps, taskId: 'task-A' },
      ),
      issueProjectHandshakeViaAdapter(
        { projectId: 'p1', folder: 'docs' },
        { ...baseDeps, taskId: 'task-B' },
      ),
    ]);
    expect(adapter.callCount).toBe(2);
    expect(results.every((r) => r.kind === 'allow')).toBe(true);
    if (results[0]?.kind === 'allow' && results[1]?.kind === 'allow') {
      expect(results[0].decisionId).toBe('dec-task-A');
      expect(results[1].decisionId).toBe('dec-task-B');
      // Tokens differ.
      expect(results[0].engagement.token).not.toBe(
        results[1].engagement.token,
      );
    }
  });
});
