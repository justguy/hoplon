/**
 * tests/authorization/staticAuthorizationAdapter.test.ts
 *
 * Unit tests for StaticAuthorizationAdapter (T-143).
 *
 * Covers:
 *   1. Static allow for read_write access (all capabilities granted).
 *   2. Static allow for read_only access (read + search only).
 *   3. Static deny for 'none' access.
 *   4. Malformed request handling (missing principal id, missing projectId).
 *   5. Invalid folder path handling.
 *   6. Preservation of existing handshake behavior via adapter:
 *      default_fallback path, principal-scoped rule.
 *   7. Decision shape invariants: decisionId present, policyVersion set,
 *      source is standing_policy, capabilities structure correct.
 */
import { describe, it, expect } from 'vitest';

import {
  StaticAuthorizationAdapter,
  STATIC_POLICY_VERSION,
  STATIC_POLICY_EXPIRES_IN_SECONDS,
} from '../../src/hoplon/authorization/staticAuthorizationAdapter.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import type {
  HoplonAuthorizationRequest,
  HoplonAuthorizationDecision,
} from '../../src/hoplon/authorization/authorizationAdapter.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FIXED_DECISION_ID = 'static-test-decision-001';

function makeAdapter(policyOverrides: Partial<FolderPolicy> = {}) {
  const policy: FolderPolicy = {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'secrets', access: 'none' },
      { folder: 'docs', access: 'read_only' },
    ],
    principals: [
      { principalId: 'agent-a', kind: 'agent' },
      { principalId: 'agent-b', kind: 'agent' },
    ],
    ...policyOverrides,
  };
  return new StaticAuthorizationAdapter({
    folderPolicy: policy,
    generateDecisionId: () => FIXED_DECISION_ID,
  });
}

function makeRequest(
  overrides: Partial<HoplonAuthorizationRequest> = {},
): HoplonAuthorizationRequest {
  return {
    principal: { id: 'agent-a', type: 'agent', roles: ['swe'] },
    task: { id: 'task-001' },
    request: {
      projectId: 'proj-x',
      branch: 'main',
      capabilities: ['read'],
      paths: ['src/hoplon/launcher/handshake.ts'],
    },
    context: {
      sessionId: 'sess-001',
      environment: 'dev',
      now: '2026-05-03T02:00:00.000Z',
    },
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('StaticAuthorizationAdapter', () => {
  // 1. Static allow for read_write
  it('returns allow with all capabilities for read_write folder access', async () => {
    const adapter = makeAdapter();
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['write', 'lock'], paths: ['src/auth.ts'] } }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;

    expect(decision.source).toBe('standing_policy');
    expect(decision.policyVersion).toBe(STATIC_POLICY_VERSION);
    expect(decision.decisionId).toBe(FIXED_DECISION_ID);
    // TTL ownership (T-146): expiresInSeconds is derived from
    // FolderPolicy.engagementTokenTtlMs (60_000 ms → 60 s) rather than
    // the legacy 3600 fallback.
    expect(decision.expiresInSeconds).toBe(60);
    expect(decision.grantIds).toBeUndefined();

    // read_write must grant all five capabilities.
    expect(decision.capabilities.read).toBeDefined();
    expect(decision.capabilities.search).toBeDefined();
    expect(decision.capabilities.write).toBeDefined();
    expect(decision.capabilities.lock).toBeDefined();
    expect(decision.capabilities.snapshot).toBeDefined();

    // Every capability is wildcard paths + branches.
    expect(decision.capabilities.write?.paths).toEqual(['**']);
    expect(decision.capabilities.write?.branches).toEqual(['**']);
  });

  // 2. Static allow for read_only
  it('returns allow with only read+search capabilities for read_only folder access', async () => {
    const adapter = makeAdapter();
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'], paths: ['docs/guide.md'] } }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;

    expect(decision.capabilities.read).toBeDefined();
    expect(decision.capabilities.search).toBeDefined();
    // No write/lock/snapshot for read_only.
    expect(decision.capabilities.write).toBeUndefined();
    expect(decision.capabilities.lock).toBeUndefined();
    expect(decision.capabilities.snapshot).toBeUndefined();
  });

  // 3. Static deny for 'none' access
  it('returns deny when folder policy access is none', async () => {
    const adapter = makeAdapter();
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'], paths: ['secrets/api-keys.env'] } }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;

    expect(decision.reason).toMatch(/denied/i);
    expect(decision.decisionId).toBe(FIXED_DECISION_ID);
    expect(decision.policyVersion).toBe(STATIC_POLICY_VERSION);
  });

  // 4a. Malformed request — missing principal id
  it('returns deny when principal id is missing', async () => {
    const adapter = makeAdapter();
    const badRequest = {
      principal: { id: '', type: 'agent' as const, roles: [] },
      task: { id: 'task-001' },
      request: { projectId: 'proj-x', branch: 'main', capabilities: ['read' as const] },
      context: { sessionId: 'sess-001', environment: 'dev' as const, now: '2026-05-03T02:00:00.000Z' },
    };
    const decision = await adapter.evaluateAccess(badRequest);

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toMatch(/principal/i);
  });

  // 4b. Malformed request — missing projectId
  it('returns deny when projectId is missing', async () => {
    const adapter = makeAdapter();
    const badRequest = makeRequest();
    // Force empty projectId.
    const mutated = {
      ...badRequest,
      request: { ...badRequest.request, projectId: '' },
    };
    const decision = await adapter.evaluateAccess(mutated);

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toMatch(/projectId/i);
  });

  // 5. Invalid folder path
  it('returns deny when path resolves to an invalid folder', async () => {
    const adapter = makeAdapter();
    // Absolute path is invalid per canonicalizeProjectRelativeFolder.
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'], paths: ['/absolute/path.ts'] } }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toMatch(/invalid/i);
  });

  // 6a. Default fallback path
  it('returns allow using defaultAccess when no folder rule matches', async () => {
    const adapter = makeAdapter({ defaultAccess: 'read_only' });
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'], paths: ['tooling/scripts/build.ts'] } }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    // Default is read_only → only read + search.
    expect(decision.capabilities.read).toBeDefined();
    expect(decision.capabilities.write).toBeUndefined();
  });

  // 6b. Principal-scoped rule — project root as fallback
  it('returns allow for project root (empty path)', async () => {
    const adapter = makeAdapter({ defaultAccess: 'read_write' });
    const decision = await adapter.evaluateAccess(
      makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['write'], paths: [] } }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    // defaultAccess read_write → all capabilities.
    expect(decision.capabilities.write).toBeDefined();
  });

  // 7. Decision shape invariants
  it('always sets decisionId and policyVersion in every decision variant', async () => {
    const adapter = makeAdapter();

    const decisions: HoplonAuthorizationDecision[] = await Promise.all([
      // allow
      adapter.evaluateAccess(makeRequest()),
      // deny (secrets)
      adapter.evaluateAccess(
        makeRequest({ request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'], paths: ['secrets/token'] } }),
      ),
      // deny (bad principal)
      adapter.evaluateAccess({
        principal: { id: '', type: 'agent', roles: [] },
        task: { id: 'task-002' },
        request: { projectId: 'proj-x', branch: 'main', capabilities: ['read'] },
        context: { sessionId: 'sess-002', environment: 'dev', now: '2026-05-03T02:00:00.000Z' },
      }),
    ]);

    for (const d of decisions) {
      expect(d.decisionId).toBe(FIXED_DECISION_ID);
      expect(d.policyVersion).toBe(STATIC_POLICY_VERSION);
    }
  });

  // 8. Adapter is async — returned value is always a Promise.
  it('returns a Promise (async interface contract)', () => {
    const adapter = makeAdapter();
    const result = adapter.evaluateAccess(makeRequest());
    expect(result).toBeInstanceOf(Promise);
  });

  // 9. T-146 — TTL ownership: derive expiresInSeconds from FolderPolicy.engagementTokenTtlMs
  it('derives expiresInSeconds from FolderPolicy.engagementTokenTtlMs (custom TTL)', async () => {
    const adapter = makeAdapter({ engagementTokenTtlMs: 7 * 60_000 });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    expect(decision.expiresInSeconds).toBe(420); // 7 min in seconds
  });

  it('falls back to STATIC_POLICY_EXPIRES_IN_SECONDS when ttl is unset / non-positive', async () => {
    // Forge a folder policy without a positive engagementTokenTtlMs to
    // simulate a launcher misconfiguration. The adapter must not return 0.
    const adapter = new StaticAuthorizationAdapter({
      folderPolicy: {
        defaultAccess: 'read_only',
        engagementTokenTtlMs: 0 as unknown as number,
        folderRules: [],
      },
      generateDecisionId: () => FIXED_DECISION_ID,
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    expect(decision.expiresInSeconds).toBe(STATIC_POLICY_EXPIRES_IN_SECONDS);
  });

  it('clamps sub-second TTL to a minimum of 1 second', async () => {
    const adapter = makeAdapter({ engagementTokenTtlMs: 100 });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    expect(decision.expiresInSeconds).toBe(1);
  });
});
