/**
 * tests/policy/opaPolicyBundle.test.ts — end-to-end OPA bundle corpus
 * tests for T-149.
 *
 * Strategy A (in-process bundled evaluator). The tests below exercise
 * the FULL chain `OpaAuthorizationAdapter → BundledOpaClient →
 * evaluatePolicyBundle → normalizeOpaDecision` so any drift between the
 * Rego reference (`policy/hoplon_authz.rego`) and the in-process
 * evaluator surfaces as a failed assertion.
 *
 * Coverage matrix (DoD items in brackets):
 *   - Project A read/search/write/lock allow with concrete capabilities. [DoD 3]
 *   - Project B read/search allow.                                       [DoD 4]
 *   - Project B write without grant → requires_escalation.               [DoD 4]
 *   - Project B write with active grant → escalation_grant allow with grantIds. [DoD 5]
 *   - Protected branch (`main`, `release/*`) write → requires_approval.  [DoD 6]
 *   - Sensitive path (`secrets/**`, `.env*`) write → security approval.  [DoD 6]
 *   - Sensitive path beats project allow (layer order proof).            [DoD 1]
 *   - Expired grant ignored → escalation.                                [DoD 9]
 *   - Revoked grant ignored → escalation.                                [DoD 9]
 *   - Cross-task grant rejected (taskId filtering).                      [silent failure mode 1]
 *   - Cross-principal grant rejected.                                    [silent failure mode 1]
 *   - Branch glob `release/*` matches `release/v1.2` only (single segment). [silent failure 5]
 *   - Default deny (unknown project, no rule).                           [DoD 1, silent failure 6]
 *   - Bundle policyVersion / decisionId round-trip.                      [DoD 7]
 *   - Bundle output shape passes T-145 normalization for all variants.   [DoD 7]
 *   - Sidecar `'unavailable'` mode → adapter returns deny (fail-closed). [DoD 8]
 *   - Forced malformed payload → adapter returns deny.                   [DoD 9]
 *   - `expiresInSeconds: 0` is never emitted by the bundle.              [silent failure 7]
 *   - Concrete capabilities (no vague roles) for every allow.            [policy-prompt mandate]
 *   - HOPLON_POLICY_BUNDLE_VERSION matches the JSON file.                [bundle pin]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OpaAuthorizationAdapter } from '../../src/hoplon/authorization/opaAuthorizationAdapter.js';
import {
  BundledOpaClient,
  HOPLON_POLICY_BUNDLE_VERSION,
  parsePolicyDataJson,
  type PolicyData,
} from '../../src/hoplon/authorization/policyBundle/index.js';
import { normalizeOpaDecision } from '../../src/hoplon/authorization/normalizeOpaDecision.js';
import type {
  ActiveGrantClient,
  ListActiveGrantsResult,
} from '../../src/hoplon/authorization/activeGrantClient.js';
import type { Clock } from '../../src/hoplon/authorization/clock.js';
import type { HoplonAuthorizationRequest } from '../../src/hoplon/authorization/authorizationAdapter.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

const POLICY_DATA_PATH = resolve(
  __dirname,
  '../../policy/data/hoplon_policy_data.json',
);

function loadPolicy(): PolicyData {
  const raw = readFileSync(POLICY_DATA_PATH, 'utf8');
  const parsed = parsePolicyDataJson(raw);
  if (parsed.kind !== 'ok') {
    throw new Error(
      `policy fixture failed validation: ${parsed.field}: ${parsed.reason}`,
    );
  }
  return parsed.data;
}

function deterministicIdSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

const FIXED_NOW = '2026-05-03T21:05:00Z';

const fixedClock: Clock = { nowIso: () => FIXED_NOW };

function fakeGrantClient(result: ListActiveGrantsResult): ActiveGrantClient {
  return {
    async listActiveGrants() {
      return result;
    },
  };
}

function emptyGrantClient(): ActiveGrantClient {
  return fakeGrantClient({ kind: 'ok', grants: [] });
}

function buildRequest(
  overrides: Partial<HoplonAuthorizationRequest['request']> & {
    projectId?: string;
    branch?: string;
    capabilities?: HoplonAuthorizationRequest['request']['capabilities'];
  },
  more: Partial<HoplonAuthorizationRequest> = {},
): HoplonAuthorizationRequest {
  return {
    principal: more.principal ?? {
      id: 'agent:swe_frontend',
      type: 'agent',
      roles: ['frontend-swe-agent'],
    },
    task: more.task ?? {
      id: 'task_123',
      type: 'bugfix',
      riskLevel: 'medium',
    },
    request: {
      projectId: overrides.projectId ?? 'project-a',
      branch: overrides.branch ?? 'feature/login-fix',
      capabilities: overrides.capabilities ?? ['read'],
      ...(overrides.paths !== undefined ? { paths: [...overrides.paths] } : {}),
      ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    },
    context: more.context ?? {
      sessionId: 'sess_456',
      environment: 'dev',
      now: FIXED_NOW,
    },
  };
}

function buildAdapterWithBundle(
  policy: PolicyData,
  grantClient: ActiveGrantClient = emptyGrantClient(),
  opts: {
    transformDecision?: (d: Record<string, unknown>) => unknown;
    mode?: 'live' | 'unavailable';
  } = {},
): { adapter: OpaAuthorizationAdapter; bundle: BundledOpaClient } {
  const bundle = new BundledOpaClient({
    policy,
    generateDecisionId: deterministicIdSource('opa_decision'),
    mode: opts.mode,
    transformDecision: opts.transformDecision,
  });
  const adapter = new OpaAuthorizationAdapter({
    opaClient: bundle,
    grantClient,
    clock: fixedClock,
    generateDecisionId: deterministicIdSource('adapter_decision'),
  });
  return { adapter, bundle };
}

// ─── bundle pin ────────────────────────────────────────────────────────────

describe('T-149 — bundle version pin', () => {
  it('exported HOPLON_POLICY_BUNDLE_VERSION matches the JSON fixture policyVersion', () => {
    const policy = loadPolicy();
    expect(policy.policyVersion).toBe(HOPLON_POLICY_BUNDLE_VERSION);
    expect(HOPLON_POLICY_BUNDLE_VERSION).toBe(
      'hoplon_policy_bundle_2026_05_03',
    );
  });

  it('JSON fixture parses without errors', () => {
    const raw = readFileSync(POLICY_DATA_PATH, 'utf8');
    const parsed = parsePolicyDataJson(raw);
    expect(parsed.kind).toBe('ok');
  });
});

// ─── DoD 3: Project A standing allow ───────────────────────────────────────

describe('T-149 — Project A standing allow [DoD 3]', () => {
  it('read/search/write/lock all together → allow with all four concrete capabilities', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read', 'search', 'write', 'lock'],
        paths: ['src/frontend/index.ts'],
        branch: 'feature/login-fix',
      }),
    );
    if (decision.outcome !== 'allow') throw new Error(`expected allow, got ${decision.outcome}`);
    expect(decision.source).toBe('standing_policy');
    expect(decision.policyVersion).toBe(HOPLON_POLICY_BUNDLE_VERSION);
    expect(decision.expiresInSeconds).toBe(900);
    expect(decision.capabilities.read).toEqual({ paths: ['**'], branches: ['**'] });
    expect(decision.capabilities.search).toEqual({ paths: ['**'], branches: ['**'] });
    expect(decision.capabilities.write).toEqual({ paths: ['**'], branches: ['**'] });
    expect(decision.capabilities.lock).toEqual({ paths: ['**'], branches: ['**'] });
    expect(decision.decisionId.startsWith('opa_decision_')).toBe(true);
  });
});

// ─── DoD 4: Project B read/search allow + write requires_escalation ────────

describe('T-149 — Project B standing read/search allow [DoD 4]', () => {
  it('read+search → allow with concrete read+search capabilities', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['read', 'search'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'allow') throw new Error(`expected allow, got ${decision.outcome}`);
    expect(decision.source).toBe('standing_policy');
    expect(decision.capabilities.read).toBeDefined();
    expect(decision.capabilities.search).toBeDefined();
    expect(decision.capabilities.write).toBeUndefined();
    expect(decision.capabilities.lock).toBeUndefined();
  });

  it('write without grant → requires_escalation cto_approval', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'requires_escalation') {
      throw new Error(`expected requires_escalation, got ${decision.outcome}`);
    }
    expect(decision.escalationKind).toBe('cto_approval');
    expect(decision.requestedScope.write).toEqual({
      paths: ['src/lib/util.ts'],
      branches: ['feature/cleanup'],
    });
    expect(decision.policyVersion).toBe(HOPLON_POLICY_BUNDLE_VERSION);
    expect(decision.reason).toMatch(/escalation/);
  });
});

// ─── DoD 5: active grant allows narrow Project B write/lock ────────────────

describe('T-149 — active grants [DoD 5]', () => {
  it('matching active grant → allow with source=escalation_grant and grantIds', async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_789',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: {
              paths: ['src/lib/util.ts'],
              branches: ['feature/cleanup'],
            },
            lock: {
              paths: ['src/lib/util.ts'],
              branches: ['feature/cleanup'],
            },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write', 'lock'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'allow') {
      throw new Error(
        `expected allow with escalation_grant; got ${decision.outcome} ${'reason' in decision ? decision.reason : ''}`,
      );
    }
    expect(decision.source).toBe('escalation_grant');
    expect(decision.grantIds).toEqual(['grant_789']);
    expect(decision.capabilities.write?.paths).toContain('src/lib/util.ts');
    expect(decision.capabilities.write?.branches).toContain('feature/cleanup');
    expect(decision.expiresInSeconds).toBe(1800);
  });

  it('grant matching by taskId — wrong taskId is rejected (silent-failure 1: principalId-only is NOT enough)', async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_other_task',
          principalId: 'agent:swe_frontend',
          taskId: 'task_OTHER', // different task
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
            lock: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });

  it('grant matching by principalId — wrong principal rejected', async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_other_principal',
          principalId: 'agent:other',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });

  it('expired grant → ignored, falls back to escalation [DoD 9]', async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_expired',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T20:00:00Z', // before FIXED_NOW
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });

  it('revoked grant → ignored, falls back to escalation [DoD 9]', async () => {
    const policy = loadPolicy();
    const policyWithRevocation: PolicyData = {
      ...policy,
      revokedGrantIds: ['grant_revoked'],
    };
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_revoked',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policyWithRevocation, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });
});

// ─── DoD 6: protected branches + sensitive paths ────────────────────────────

describe('T-149 — protected branches [DoD 6]', () => {
  it('Project B write to `main` → requires_approval human_approval', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'main',
      }),
    );
    if (decision.outcome !== 'requires_approval') {
      throw new Error(`expected requires_approval, got ${decision.outcome}`);
    }
    expect(decision.escalationKind).toBe('human_approval');
    expect(decision.reason).toBe('protected_branch');
  });

  it('release/v1.2 → requires_approval (single-segment glob match) [silent-failure 5]', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'release/v1.2',
      }),
    );
    expect(decision.outcome).toBe('requires_approval');
  });

  it('release/v1.2/hotfix → does NOT match release/* (multi-segment) → falls through to project escalation', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'release/v1.2/hotfix',
      }),
    );
    // single-segment glob `release/*` must NOT match `release/v1.2/hotfix`
    expect(decision.outcome).toBe('requires_escalation');
  });

  it('feature/login-fix → escalation (feature/* requires_escalation)', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/login-fix',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });
});

describe('T-149 — sensitive paths [DoD 6]', () => {
  it('Project A write to `secrets/foo` → requires_approval security_approval (sensitive path beats project allow) [silent-failure 2]', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['write'],
        paths: ['secrets/foo'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'requires_approval') {
      throw new Error(`expected requires_approval, got ${decision.outcome}`);
    }
    expect(decision.escalationKind).toBe('security_approval');
    expect(decision.reason).toMatch(/^sensitive_path:secrets\/\*\*$/);
  });

  it('Project A read of `.env.local` → requires_approval security_approval', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read'],
        paths: ['.env.local'],
        branch: 'feature/x',
      }),
    );
    expect(decision.outcome).toBe('requires_approval');
  });

  it('Project A read of `secrets/foo/bar` (deep) still hits the `secrets/**` glob', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read'],
        paths: ['secrets/foo/bar'],
        branch: 'feature/x',
      }),
    );
    expect(decision.outcome).toBe('requires_approval');
  });
});

// ─── DoD 1: layer order (explicit deny wins) ───────────────────────────────

describe('T-149 — layer order proof [DoD 1]', () => {
  it('global hard deny on Project A wins over standing allow', async () => {
    const policy = loadPolicy();
    const policyWithDeny: PolicyData = {
      ...policy,
      globalDenies: [
        { projectId: 'project-a', reason: 'project_a_hard_disabled' },
      ],
    };
    const { adapter } = buildAdapterWithBundle(policyWithDeny);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read'],
        paths: ['src/x.ts'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'deny') throw new Error(`expected deny, got ${decision.outcome}`);
    expect(decision.reason).toContain('global_hard_deny');
  });

  it('global hard deny wins over an active grant that would otherwise allow', async () => {
    const policy = loadPolicy();
    const policyWithDeny: PolicyData = {
      ...policy,
      globalDenies: [
        { projectId: 'project-b', principalId: 'agent:swe_frontend' },
      ],
    };
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_should_lose',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policyWithDeny, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('deny');
  });

  it('default deny for unknown project carries concrete decisionId + policyVersion [silent-failure 6]', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-zzz-unknown',
        capabilities: ['read'],
        paths: ['src/x.ts'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'deny') throw new Error(`expected deny, got ${decision.outcome}`);
    expect(decision.policyVersion).toBe(HOPLON_POLICY_BUNDLE_VERSION);
    expect(decision.decisionId.length).toBeGreaterThan(0);
    expect(decision.reason).toContain('default_deny_unknown_project');
  });
});

// ─── DoD 7: every output passes T-145 normalization ────────────────────────

describe('T-149 — T-145 normalization round trip [DoD 7, silent-failure 3]', () => {
  it('Project A standing allow → normalizeOpaDecision returns ok', () => {
    const policy = loadPolicy();
    const bundle = new BundledOpaClient({
      policy,
      generateDecisionId: () => 'opa_decision_test',
    });
    return bundle.evaluate('/v1/data/hoplon/authz/decision', {
      principal: { id: 'p', type: 'agent', roles: [] },
      task: { id: 't' },
      request: {
        projectId: 'project-a',
        branch: 'feature/x',
        capabilities: ['read', 'write'],
        paths: ['src/x.ts'],
      },
      context: { sessionId: 'sess', environment: 'dev', now: FIXED_NOW },
      activeGrants: [],
    }).then((res) => {
      if (res.kind !== 'ok') throw new Error('bundle returned error');
      const norm = normalizeOpaDecision(res.raw);
      expect(norm.kind).toBe('ok');
    });
  });

  it('every variant the bundle emits passes normalization (allow, escalation, approval, deny)', async () => {
    const policy = loadPolicy();
    const bundle = new BundledOpaClient({
      policy,
      generateDecisionId: deterministicIdSource('opa_decision'),
    });

    // allow (standing)
    const r1 = await bundle.evaluate('/v1/data/hoplon/authz/decision', {
      principal: { id: 'p', type: 'agent', roles: [] },
      task: { id: 't' },
      request: { projectId: 'project-a', branch: 'feature/x', capabilities: ['read'], paths: ['src/x.ts'] },
      context: { sessionId: 's', environment: 'dev', now: FIXED_NOW },
      activeGrants: [],
    });
    if (r1.kind !== 'ok') throw new Error('r1 error');
    expect(normalizeOpaDecision(r1.raw).kind).toBe('ok');

    // escalation
    const r2 = await bundle.evaluate('/v1/data/hoplon/authz/decision', {
      principal: { id: 'p', type: 'agent', roles: [] },
      task: { id: 't' },
      request: { projectId: 'project-b', branch: 'feature/x', capabilities: ['write'], paths: ['src/x.ts'] },
      context: { sessionId: 's', environment: 'dev', now: FIXED_NOW },
      activeGrants: [],
    });
    if (r2.kind !== 'ok') throw new Error('r2 error');
    expect(normalizeOpaDecision(r2.raw).kind).toBe('ok');

    // approval (protected branch)
    const r3 = await bundle.evaluate('/v1/data/hoplon/authz/decision', {
      principal: { id: 'p', type: 'agent', roles: [] },
      task: { id: 't' },
      request: { projectId: 'project-b', branch: 'main', capabilities: ['write'], paths: ['src/x.ts'] },
      context: { sessionId: 's', environment: 'dev', now: FIXED_NOW },
      activeGrants: [],
    });
    if (r3.kind !== 'ok') throw new Error('r3 error');
    expect(normalizeOpaDecision(r3.raw).kind).toBe('ok');

    // deny (unknown project)
    const r4 = await bundle.evaluate('/v1/data/hoplon/authz/decision', {
      principal: { id: 'p', type: 'agent', roles: [] },
      task: { id: 't' },
      request: { projectId: 'unknown', branch: 'feature/x', capabilities: ['read'], paths: ['src/x.ts'] },
      context: { sessionId: 's', environment: 'dev', now: FIXED_NOW },
      activeGrants: [],
    });
    if (r4.kind !== 'ok') throw new Error('r4 error');
    expect(normalizeOpaDecision(r4.raw).kind).toBe('ok');
  });
});

// ─── DoD 8: sidecar fail-closed ─────────────────────────────────────────────

describe('T-149 — sidecar fail-closed [DoD 8]', () => {
  it('BundledOpaClient(mode=unavailable) → adapter returns deny opa_unavailable', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy, emptyGrantClient(), {
      mode: 'unavailable',
    });
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read'],
        paths: ['src/x.ts'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'deny') throw new Error(`expected deny, got ${decision.outcome}`);
    expect(decision.reason).toContain('opa_unavailable');
    expect(decision.policyVersion).toContain('adapter-error');
  });

  it('forced malformed payload → adapter returns deny opa_malformed_decision', async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy, emptyGrantClient(), {
      transformDecision: (d) => {
        // strip the decisionId field to force malformed
        const copy: Record<string, unknown> = { ...d };
        delete copy['decisionId'];
        return copy;
      },
    });
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read'],
        paths: ['src/x.ts'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'deny') throw new Error(`expected deny, got ${decision.outcome}`);
    expect(decision.reason).toContain('opa_malformed_decision');
  });
});

// ─── silent-failure 7: expiresInSeconds: 0 must never be emitted ────────────

describe('T-149 — bundle never emits expiresInSeconds ≤ 0 [silent-failure 7]', () => {
  it('all allow outputs have positive expiresInSeconds', async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_x',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: { paths: ['src/lib/util.ts'], branches: ['feature/cleanup'] },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);

    const a = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read', 'write'],
        paths: ['src/x.ts'],
        branch: 'feature/x',
      }),
    );
    if (a.outcome !== 'allow') throw new Error('a not allow');
    expect(a.expiresInSeconds).toBeGreaterThan(0);

    const b = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (b.outcome !== 'allow') throw new Error('b not allow');
    expect(b.expiresInSeconds).toBeGreaterThan(0);
  });
});

// ─── T-149 review fix: snapshot capability silent-drop closure ─────────────
//
// Original bug: `snapshot` was accepted by the input type and parsed by
// policy data but filtered out before evaluation, so a request like
// `['read', 'snapshot']` was authorized as if only `read` was requested
// (an `allow` shape that quietly dropped the unsatisfied capability).
// These tests prove the closure end-to-end: snapshot flows through the
// same six layers as write/lock, and any unsatisfied snapshot request
// escalates the WHOLE request — never silent partial allow.

describe('T-149 review fix — snapshot capability is first class', () => {
  it("['read','snapshot'] for Project A → allow with BOTH read AND snapshot capabilities populated [silent-failure 1]", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['read', 'snapshot'],
        paths: ['src/frontend/index.ts'],
        branch: 'feature/login-fix',
      }),
    );
    if (decision.outcome !== 'allow') {
      throw new Error(`expected allow, got ${decision.outcome}`);
    }
    expect(decision.source).toBe('standing_policy');
    expect(decision.capabilities.read).toEqual({
      paths: ['**'],
      branches: ['**'],
    });
    // The bug: snapshot used to be silently dropped here.
    expect(decision.capabilities.snapshot).toEqual({
      paths: ['**'],
      branches: ['**'],
    });
  });

  it("['read','snapshot'] for Project B → requires_escalation (snapshot needs escalation in B; read alone is not enough)", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['read', 'snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'requires_escalation') {
      throw new Error(
        `expected requires_escalation, got ${decision.outcome}`,
      );
    }
    expect(decision.escalationKind).toBe('cto_approval');
    expect(decision.requestedScope.snapshot).toBeDefined();
    // Mixed-request: read can never silently mask snapshot's escalation
    // (the missing piece blocks the whole request).
    expect(decision.reason).toMatch(/escalation/);
  });

  it("['snapshot'] alone for Project B without grant → requires_escalation", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'requires_escalation') {
      throw new Error(
        `expected requires_escalation, got ${decision.outcome}`,
      );
    }
    expect(decision.requestedScope.snapshot).toEqual({
      paths: ['src/lib/util.ts'],
      branches: ['feature/cleanup'],
    });
  });

  it("['snapshot'] alone for Project B WITH matching grant → allow with grantIds + narrow snapshot scope", async () => {
    const policy = loadPolicy();
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_snapshot_ok',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            snapshot: {
              paths: ['src/lib/util.ts'],
              branches: ['feature/cleanup'],
            },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome !== 'allow') {
      throw new Error(
        `expected allow with escalation_grant; got ${decision.outcome} ${'reason' in decision ? decision.reason : ''}`,
      );
    }
    expect(decision.source).toBe('escalation_grant');
    expect(decision.grantIds).toEqual(['grant_snapshot_ok']);
    expect(decision.capabilities.snapshot).toBeDefined();
    expect(decision.capabilities.snapshot?.paths).toContain(
      'src/lib/util.ts',
    );
    expect(decision.capabilities.snapshot?.branches).toContain(
      'feature/cleanup',
    );
    // Narrow scope: must NOT widen to ** when the grant restricts it.
    expect(decision.capabilities.snapshot?.paths).not.toContain('**');
  });

  it("['write','snapshot'] against `main` (Project B) → requires_human_approval (protected branch; both caps agree)", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['write', 'snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'main',
      }),
    );
    if (decision.outcome !== 'requires_approval') {
      throw new Error(
        `expected requires_approval, got ${decision.outcome}`,
      );
    }
    expect(decision.escalationKind).toBe('human_approval');
    expect(decision.reason).toBe('protected_branch');
  });

  it("['snapshot'] against `secrets/**` (Project A) → requires_security_approval (sensitive path beats project allow)", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-a',
        capabilities: ['snapshot'],
        paths: ['secrets/keys.json'],
        branch: 'feature/x',
      }),
    );
    if (decision.outcome !== 'requires_approval') {
      throw new Error(
        `expected requires_approval, got ${decision.outcome}`,
      );
    }
    expect(decision.escalationKind).toBe('security_approval');
    expect(decision.reason).toBe('sensitive_path:secrets/**');
  });

  it("['snapshot'] against `release/v1.2` (Project B) → requires_human_approval (snapshot inherits release/* override)", async () => {
    const policy = loadPolicy();
    const { adapter } = buildAdapterWithBundle(policy);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'release/v1.2',
      }),
    );
    if (decision.outcome !== 'requires_approval') {
      throw new Error(
        `expected requires_approval, got ${decision.outcome}`,
      );
    }
    expect(decision.escalationKind).toBe('human_approval');
  });

  it('grant with scope.write but NO scope.snapshot does NOT satisfy a snapshot request [silent-failure 4]', async () => {
    const policy = loadPolicy();
    // Grant carries write scope only — must NOT cover a snapshot request.
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_write_only',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            write: {
              paths: ['src/lib/util.ts'],
              branches: ['feature/cleanup'],
            },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    expect(decision.outcome).toBe('requires_escalation');
  });

  it("mixed ['read','snapshot'] Project B with a read-only grant does NOT silently allow — escalates whole request [silent-failure 5]", async () => {
    const policy = loadPolicy();
    // Read is project-default allow; snapshot needs escalation. A grant
    // that only covers `read` cannot satisfy `snapshot`. The request must
    // escalate as a whole — never silently allow with only `read`
    // populated.
    const grantClient = fakeGrantClient({
      kind: 'ok',
      grants: [
        {
          grantId: 'grant_read_only',
          principalId: 'agent:swe_frontend',
          taskId: 'task_123',
          projectId: 'project-b',
          scope: {
            read: {
              paths: ['src/lib/util.ts'],
              branches: ['feature/cleanup'],
            },
          },
          expiresAt: '2026-05-03T22:00:00Z',
        },
      ],
    });
    const { adapter } = buildAdapterWithBundle(policy, grantClient);
    const decision = await adapter.evaluateAccess(
      buildRequest({
        projectId: 'project-b',
        capabilities: ['read', 'snapshot'],
        paths: ['src/lib/util.ts'],
        branch: 'feature/cleanup',
      }),
    );
    if (decision.outcome === 'allow') {
      throw new Error(
        `partial allow detected — bug: snapshot was silently dropped: ${JSON.stringify(decision.capabilities)}`,
      );
    }
    expect(decision.outcome).toBe('requires_escalation');
  });

  it("BUNDLE_CAPABILITY_KEYS includes 'snapshot' — single source of truth", async () => {
    const { BUNDLE_CAPABILITY_KEYS } = await import(
      '../../src/hoplon/authorization/policyBundle/index.js'
    );
    expect(BUNDLE_CAPABILITY_KEYS).toContain('snapshot');
  });

  it('reference Rego file mentions snapshot in the layer/capability documentation [silent-failure 6: Rego ↔ TS lockstep]', () => {
    const regoPath = resolve(
      __dirname,
      '../../policy/hoplon_authz.rego',
    );
    const rego = readFileSync(regoPath, 'utf8');
    // The reference Rego documents `snapshot` as a first-class capability
    // alongside read/search/write/lock. Without this assertion the Rego
    // skeleton could silently lie about the policy contract.
    expect(rego).toMatch(/snapshot/);
  });

  it('policy data fixture carries snapshot rules for every project default, every branch override, every sensitive path [silent-failure 7]', () => {
    const policy = loadPolicy();
    for (const projectId of Object.keys(policy.projects)) {
      const def = policy.projects[projectId]!.default;
      expect(def.snapshot).toBeDefined();
    }
    for (const projectId of Object.keys(policy.branches)) {
      const branchMap = policy.branches[projectId]!;
      for (const pattern of Object.keys(branchMap)) {
        const rule = branchMap[pattern]!;
        // If write/lock are gated, snapshot must be gated too — symmetry
        // with write/lock ensures snapshot never widens access silently
        // through a missing rule.
        if (rule.write !== undefined || rule.lock !== undefined) {
          expect(rule.snapshot).toBeDefined();
        }
      }
    }
    for (const entry of policy.sensitivePaths) {
      expect(entry.snapshot).toBeDefined();
    }
  });

  it('loader rejects a project that omits snapshot from default [structural lockstep]', () => {
    const broken = JSON.stringify({
      policyVersion: 'broken_test',
      defaultExpiresInSeconds: 900,
      grantExpiresInSeconds: 1800,
      projects: {
        'project-x': {
          default: {
            read: 'allow',
            search: 'allow',
            write: 'allow',
            lock: 'allow',
            // snapshot intentionally missing
          },
          token: { maxTtlSeconds: 900 },
        },
      },
      branches: {},
      sensitivePaths: [],
      globalDenies: [],
      revokedGrantIds: [],
    });
    const result = parsePolicyDataJson(broken);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.field).toBe('projects.project-x.default.snapshot');
    }
  });
});
