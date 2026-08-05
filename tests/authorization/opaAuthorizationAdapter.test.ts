/**
 * tests/authorization/opaAuthorizationAdapter.test.ts — unit tests for
 * `OpaAuthorizationAdapter` (T-145).
 *
 * Covers the mandatory fail-closed corpus from the task brief:
 *   1. Standing-policy `allow` (single project, all capabilities).
 *   2. Active-grant `allow` (escalation_grant source; grantIds populated
 *      by the adapter from the grant client, NOT the agent).
 *   3. `requires_escalation` decision pass-through.
 *   4. `requires_approval` decision pass-through.
 *   5. `deny` decision pass-through.
 *   6. OPA returns `{ kind: 'error' }` → adapter returns `deny` with
 *      `opa_unavailable` reason.
 *   7. OPA returns malformed object (wrong outcome) → adapter returns
 *      `deny` with `opa_malformed_decision` reason.
 *   8. OPA returns `allow` with empty `capabilities` → vague-role deny.
 *   9. OPA returns `allow` with missing `decisionId` → deny.
 *  10. OPA returns `allow` with missing `policyVersion` → deny.
 *  11. Grant lookup unavailable AND request includes `write` (in
 *      `requireGrantsForCapabilities`) → deny with required-capability
 *      reason.
 *  12. Grant lookup unavailable AND request is read-only → adapter
 *      proceeds with `activeGrants: []` and OPA decision is honored.
 *  13. Agent supplies fabricated grant ids in input → adapter ignores
 *      them; OPA input contains only the grants returned by the client.
 *  14. Clock is read once at the start of `evaluateAccess` and embedded
 *      in `context.now` even if the clock advances between calls.
 *  15. Defensive request validation: empty `principal.id` is rejected
 *      before any OPA/grant call.
 *  16. Defensive request validation: empty `request.capabilities` is
 *      rejected before any OPA/grant call.
 *  17. OPA returns `allow` with `expiresInSeconds: 0` → deny.
 *  18. OPA returns `allow` with `capabilities.write.paths: []` → deny.
 *  19. Mixed-projectId grants from the client are passed through
 *      verbatim (adapter does not pre-filter).
 *  20. Concurrent `evaluateAccess` calls do not share state.
 */
import { describe, it, expect } from 'vitest';

import { OpaAuthorizationAdapter } from '../../src/hoplon/authorization/opaAuthorizationAdapter.js';
import type {
  OpaClient,
  OpaEvaluateResult,
} from '../../src/hoplon/authorization/opaClient.js';
import type {
  ActiveGrant,
  ActiveGrantClient,
  ListActiveGrantsResult,
} from '../../src/hoplon/authorization/activeGrantClient.js';
import type { Clock } from '../../src/hoplon/authorization/clock.js';
import type {
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';

// ─── Test doubles ──────────────────────────────────────────────────────────

type CapturedCall = { decisionPath: string; input: unknown };

function fakeOpaClient(
  result: OpaEvaluateResult | (() => OpaEvaluateResult),
): { client: OpaClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: OpaClient = {
    async evaluate(decisionPath, input) {
      calls.push({ decisionPath, input });
      return typeof result === 'function' ? result() : result;
    },
  };
  return { client, calls };
}

function fakeGrantClient(
  result: ListActiveGrantsResult | (() => ListActiveGrantsResult),
): { client: ActiveGrantClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: ActiveGrantClient = {
    async listActiveGrants(req) {
      calls.push(req);
      return typeof result === 'function' ? result() : result;
    },
  };
  return { client, calls };
}

function fixedClock(iso: string): Clock {
  return { nowIso: () => iso };
}

function sequenceClock(values: string[]): Clock {
  let i = 0;
  return {
    nowIso: () => {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return v;
    },
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const NOW_ISO = '2026-05-03T21:05:00.000Z';
const FIXED_ADAPTER_DECISION_ID = 'opa-adapter-test-decisionId';

function makeRequest(
  overrides: Partial<HoplonAuthorizationRequest> = {},
): HoplonAuthorizationRequest {
  const base: HoplonAuthorizationRequest = {
    principal: { id: 'agent:swe_frontend', type: 'agent', roles: ['frontend-swe-agent'] },
    task: { id: 'task_123', type: 'bugfix', riskLevel: 'medium' },
    request: {
      projectId: 'project-b',
      branch: 'feature/login-fix',
      capabilities: ['write', 'lock'],
      paths: ['src/frontend/LoginForm.tsx'],
      reason: 'Fix failing login layout test',
    },
    context: {
      sessionId: 'sess_456',
      environment: 'dev',
      now: 'placeholder-overwritten-by-adapter',
    },
  };
  return { ...base, ...overrides };
}

function allowDecisionPayload(extras: Record<string, unknown> = {}): unknown {
  return {
    outcome: 'allow',
    source: 'standing_policy',
    capabilities: {
      read: { paths: ['**'], branches: ['**'] },
      search: { paths: ['**'], branches: ['**'] },
      write: { paths: ['src/frontend/LoginForm.tsx'], branches: ['feature/login-fix'] },
      lock: { paths: ['src/frontend/LoginForm.tsx'], branches: ['feature/login-fix'] },
    },
    expiresInSeconds: 1800,
    decisionId: 'opa_decision_001',
    policyVersion: 'hoplon_policy_bundle_2026_05_03',
    ...extras,
  };
}

function activeGrant(overrides: Partial<ActiveGrant> = {}): ActiveGrant {
  return {
    grantId: 'grant_789',
    principalId: 'agent:swe_frontend',
    taskId: 'task_123',
    projectId: 'project-b',
    scope: {
      write: { paths: ['src/frontend/LoginForm.tsx'], branches: ['feature/login-fix'] },
      lock: { paths: ['src/frontend/LoginForm.tsx'], branches: ['feature/login-fix'] },
    },
    expiresAt: '2026-05-03T22:00:00.000Z',
    ...overrides,
  };
}

function makeAdapter(opts: {
  opaResult: OpaEvaluateResult | (() => OpaEvaluateResult);
  grantResult?: ListActiveGrantsResult | (() => ListActiveGrantsResult);
  clock?: Clock;
  decisionPath?: string;
  engineName?: string;
  requireGrantsForCapabilities?: ReadonlyArray<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
}) {
  const { client: opaClient, calls: opaCalls } = fakeOpaClient(opts.opaResult);
  const { client: grantClient, calls: grantCalls } = fakeGrantClient(
    opts.grantResult ?? { kind: 'ok', grants: [] },
  );
  const adapter = new OpaAuthorizationAdapter({
    opaClient,
    grantClient,
    clock: opts.clock ?? fixedClock(NOW_ISO),
    ...(opts.decisionPath !== undefined ? { decisionPath: opts.decisionPath } : {}),
    ...(opts.engineName !== undefined ? { engineName: opts.engineName } : {}),
    ...(opts.requireGrantsForCapabilities !== undefined
      ? { requireGrantsForCapabilities: opts.requireGrantsForCapabilities }
      : {}),
    generateDecisionId: () => FIXED_ADAPTER_DECISION_ID,
  });
  return { adapter, opaCalls, grantCalls };
}

function isAllow(
  d: HoplonAuthorizationDecision,
): d is Extract<HoplonAuthorizationDecision, { outcome: 'allow' }> {
  return d.outcome === 'allow';
}

function isDeny(
  d: HoplonAuthorizationDecision,
): d is Extract<HoplonAuthorizationDecision, { outcome: 'deny' }> {
  return d.outcome === 'deny';
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('OpaAuthorizationAdapter', () => {
  // 1. Standing-policy allow.
  it('returns standing-policy allow for a well-formed OPA allow payload', async () => {
    const { adapter, opaCalls, grantCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
    });
    const decision = await adapter.evaluateAccess(makeRequest());

    expect(isAllow(decision)).toBe(true);
    if (!isAllow(decision)) return;
    expect(decision.source).toBe('standing_policy');
    expect(decision.expiresInSeconds).toBe(1800);
    expect(decision.decisionId).toBe('opa_decision_001');
    expect(decision.policyVersion).toBe('hoplon_policy_bundle_2026_05_03');
    expect(decision.capabilities.write?.paths).toEqual(['src/frontend/LoginForm.tsx']);

    expect(grantCalls).toHaveLength(1);
    expect(opaCalls).toHaveLength(1);
    expect(opaCalls[0]?.decisionPath).toBe('/v1/data/hoplon/authz/decision');
  });

  // 2. Active-grant allow with grantIds set by adapter.
  it('forwards active grants from the grant client into OPA input and surfaces grantIds on allow', async () => {
    const grant = activeGrant();
    const { adapter, opaCalls } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: allowDecisionPayload({
          source: 'escalation_grant',
          grantIds: ['grant_789'],
        }),
      },
      grantResult: { kind: 'ok', grants: [grant] },
    });
    const decision = await adapter.evaluateAccess(makeRequest());

    expect(isAllow(decision)).toBe(true);
    if (!isAllow(decision)) return;
    expect(decision.source).toBe('escalation_grant');
    expect(decision.grantIds).toEqual(['grant_789']);

    const opaInput = opaCalls[0]?.input as { activeGrants: ActiveGrant[] };
    expect(opaInput.activeGrants).toEqual([grant]);
  });

  // 3. requires_escalation pass-through.
  it('passes through requires_escalation decisions', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: {
          outcome: 'requires_escalation',
          escalationKind: 'cto_approval',
          requestedScope: { write: { paths: ['src/x.ts'], branches: ['main'] } },
          reason: 'requires CTO approval',
          decisionId: 'opa_decision_002',
          policyVersion: 'v1',
        },
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('requires_escalation');
    if (decision.outcome !== 'requires_escalation') return;
    expect(decision.escalationKind).toBe('cto_approval');
  });

  // 4. requires_approval pass-through.
  it('passes through requires_approval decisions', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: {
          outcome: 'requires_approval',
          escalationKind: 'human_approval',
          requestedScope: { write: { paths: ['src/x.ts'], branches: ['main'] } },
          reason: 'requires human approval',
          decisionId: 'opa_decision_003',
          policyVersion: 'v1',
        },
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('requires_approval');
    if (decision.outcome !== 'requires_approval') return;
    expect(decision.escalationKind).toBe('human_approval');
  });

  // 5. deny pass-through.
  it('passes through deny decisions from OPA', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: {
          outcome: 'deny',
          reason: 'policy denies access',
          decisionId: 'opa_decision_004',
          policyVersion: 'v1',
        },
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toBe('policy denies access');
    expect(decision.decisionId).toBe('opa_decision_004');
  });

  // 6. OPA error → deny with opa_unavailable.
  it('fails closed with opa_unavailable when the OPA client returns kind=error', async () => {
    const { adapter } = makeAdapter({
      opaResult: { kind: 'error', reason: 'connect ECONNREFUSED 127.0.0.1:8181' },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/^opa_unavailable: /);
    expect(decision.decisionId).toBe(FIXED_ADAPTER_DECISION_ID);
    expect(decision.policyVersion).toBe('opa-adapter-error');
  });

  // 7. Malformed OPA decision → deny with opa_malformed_decision.
  it('fails closed with opa_malformed_decision for malformed OPA payloads', async () => {
    const { adapter } = makeAdapter({
      opaResult: { kind: 'ok', raw: { outcome: 'maybe', decisionId: 'd', policyVersion: 'v' } },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/^opa_malformed_decision: outcome:/);
  });

  // 8. allow with empty capabilities → vague-role deny.
  it('rejects allow decisions with empty capabilities (vague roles)', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: allowDecisionPayload({ capabilities: {} }),
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/vague-role rejection/);
  });

  // 9. allow with missing decisionId → deny.
  it('rejects allow decisions missing decisionId', async () => {
    const payload = allowDecisionPayload();
    delete (payload as Record<string, unknown>).decisionId;
    const { adapter } = makeAdapter({ opaResult: { kind: 'ok', raw: payload } });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/decisionId/);
  });

  // 10. allow with missing policyVersion → deny.
  it('rejects allow decisions missing policyVersion', async () => {
    const payload = allowDecisionPayload();
    delete (payload as Record<string, unknown>).policyVersion;
    const { adapter } = makeAdapter({ opaResult: { kind: 'ok', raw: payload } });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/policyVersion/);
  });

  // 11. Grant lookup unavailable + write capability → deny.
  it('fails closed when grant lookup is unavailable for a required capability (write)', async () => {
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      grantResult: { kind: 'unavailable', reason: 'control_plane_timeout' },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/^grant_lookup_unavailable_for_required_capability: /);
    // OPA must NOT be called when grants are required and unavailable.
    expect(opaCalls).toHaveLength(0);
  });

  // 12. Grant lookup unavailable + read-only request → adapter proceeds with [].
  it('proceeds with empty activeGrants when grant lookup is unavailable but capabilities do not require grants', async () => {
    const { adapter, opaCalls } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: allowDecisionPayload({
          capabilities: { read: { paths: ['**'], branches: ['**'] } },
        }),
      },
      grantResult: { kind: 'unavailable', reason: 'control_plane_timeout' },
    });
    const req = makeRequest({
      request: {
        projectId: 'project-b',
        branch: 'main',
        capabilities: ['read'],
        paths: ['src/anywhere.ts'],
      },
    });
    const decision = await adapter.evaluateAccess(req);
    expect(isAllow(decision)).toBe(true);

    expect(opaCalls).toHaveLength(1);
    const opaInput = opaCalls[0]?.input as { activeGrants: ActiveGrant[] };
    expect(opaInput.activeGrants).toEqual([]);
  });

  // 13. Agent-supplied fabricated grantIds in input are ignored.
  it('drops agent-supplied grant ids from OPA request input and only carries grant client output', async () => {
    const realGrant = activeGrant({ grantId: 'grant_real' });
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      grantResult: { kind: 'ok', grants: [realGrant] },
    });
    // Inject a fabricated grantIds field into the request via a cast — the
    // type system disallows it on `HoplonAuthorizationRequest.request`,
    // which is itself part of the trust contract.
    const req = makeRequest();
    (req.request as unknown as { grantIds: string[] }).grantIds = [
      'fabricated_grant_evil',
    ];
    await adapter.evaluateAccess(req);

    const opaInput = opaCalls[0]?.input as {
      activeGrants: ActiveGrant[];
      request: Record<string, unknown>;
    };
    expect(opaInput.activeGrants).toEqual([realGrant]);
    expect(opaInput.request.grantIds).toBeUndefined();
    expect(opaInput.activeGrants.map((g) => g.grantId)).not.toContain(
      'fabricated_grant_evil',
    );
  });

  it('fails closed when the grant client throws instead of returning an unavailable result', async () => {
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      grantResult: () => {
        throw new Error('grant service crashed');
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toContain('grant_lookup_unavailable_for_required_capability');
    expect(decision.reason).toContain('grant service crashed');
    expect(opaCalls).toHaveLength(0);
  });

  it('fails closed when the OPA client throws instead of returning kind=error', async () => {
    const { adapter } = makeAdapter({
      opaResult: () => {
        throw new Error('opa transport crashed');
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toContain('opa_unavailable: threw: opa transport crashed');
  });

  // 14. Clock is read once per evaluateAccess; subsequent calls re-read.
  it('reads the clock exactly once at the start of evaluateAccess and embeds it in OPA input', async () => {
    const clockValues = ['2026-05-03T21:05:00.000Z', '2026-05-03T21:05:01.000Z'];
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      clock: sequenceClock(clockValues),
    });
    await adapter.evaluateAccess(makeRequest());
    await adapter.evaluateAccess(makeRequest());

    const ctx0 = (opaCalls[0]?.input as { context: { now: string } }).context;
    const ctx1 = (opaCalls[1]?.input as { context: { now: string } }).context;
    expect(ctx0.now).toBe(clockValues[0]);
    expect(ctx1.now).toBe(clockValues[1]);
  });

  // 15. Empty principal.id → deny without invoking OPA or grant client.
  it('rejects requests with empty principal.id before any OPA/grant call', async () => {
    const { adapter, opaCalls, grantCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
    });
    const decision = await adapter.evaluateAccess(
      makeRequest({ principal: { id: '', type: 'agent', roles: [] } }),
    );
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/adapter_request_invalid: missing principal\.id/);
    expect(opaCalls).toHaveLength(0);
    expect(grantCalls).toHaveLength(0);
  });

  // 16. Empty capabilities → deny without invoking OPA or grant client.
  it('rejects requests with an empty capabilities array before any OPA/grant call', async () => {
    const { adapter, opaCalls, grantCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
    });
    const decision = await adapter.evaluateAccess(
      makeRequest({
        request: {
          projectId: 'project-b',
          branch: 'main',
          capabilities: [],
        },
      }),
    );
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/adapter_request_invalid: request\.capabilities/);
    expect(opaCalls).toHaveLength(0);
    expect(grantCalls).toHaveLength(0);
  });

  // 17. allow with expiresInSeconds: 0 → deny.
  it('rejects allow decisions where expiresInSeconds is not a positive number', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: allowDecisionPayload({ expiresInSeconds: 0 }),
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/expiresInSeconds/);
  });

  // 18. allow with capabilities.write.paths: [] → deny.
  it('rejects allow decisions where any scope claim has empty paths/branches arrays', async () => {
    const { adapter } = makeAdapter({
      opaResult: {
        kind: 'ok',
        raw: allowDecisionPayload({
          capabilities: {
            write: { paths: [], branches: ['main'] },
          },
        }),
      },
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/capabilities\.write\.paths/);
  });

  // 19. Mixed-projectId grants pass through.
  it('passes mixed-projectId grants through to OPA without client-side filtering', async () => {
    const g1 = activeGrant({ grantId: 'g1', projectId: 'project-b' });
    const g2 = activeGrant({ grantId: 'g2', projectId: 'project-c' });
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      grantResult: { kind: 'ok', grants: [g1, g2] },
    });
    await adapter.evaluateAccess(makeRequest());
    const opaInput = opaCalls[0]?.input as { activeGrants: ActiveGrant[] };
    expect(opaInput.activeGrants).toEqual([g1, g2]);
  });

  // 20. Concurrent calls remain independent.
  it('does not share state between concurrent evaluateAccess calls', async () => {
    let counter = 0;
    const { adapter, opaCalls } = makeAdapter({
      opaResult: () => ({
        kind: 'ok',
        raw: allowDecisionPayload({
          decisionId: `opa_decision_concurrent_${counter++}`,
        }),
      }),
      clock: sequenceClock([
        '2026-05-03T21:05:00.000Z',
        '2026-05-03T21:05:01.000Z',
        '2026-05-03T21:05:02.000Z',
      ]),
    });
    const [d1, d2, d3] = await Promise.all([
      adapter.evaluateAccess(makeRequest()),
      adapter.evaluateAccess(makeRequest()),
      adapter.evaluateAccess(makeRequest()),
    ]);
    expect(isAllow(d1) && isAllow(d2) && isAllow(d3)).toBe(true);
    expect(opaCalls).toHaveLength(3);
    // All three calls executed; their decision ids are unique.
    const ids = [d1, d2, d3]
      .filter(isAllow)
      .map((d) => d.decisionId);
    expect(new Set(ids).size).toBe(3);
  });

  // 21. requireGrantsForCapabilities override semantics: configured wider.
  it('respects a wider requireGrantsForCapabilities config (e.g. read also requires grants)', async () => {
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'ok', raw: allowDecisionPayload() },
      grantResult: { kind: 'unavailable', reason: 'cp_down' },
      requireGrantsForCapabilities: ['read', 'write', 'lock'],
    });
    const req = makeRequest({
      request: {
        projectId: 'project-b',
        branch: 'main',
        capabilities: ['read'],
        paths: ['src/x.ts'],
      },
    });
    const decision = await adapter.evaluateAccess(req);
    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toMatch(/^grant_lookup_unavailable_for_required_capability: /);
    expect(opaCalls).toHaveLength(0);
  });

  // 22. Engine name and decision path are honored when overridden.
  it('honors a custom decisionPath and engineName', async () => {
    const { adapter, opaCalls } = makeAdapter({
      opaResult: { kind: 'error', reason: 'down' },
      decisionPath: '/v1/data/custom/path',
      engineName: 'opa-test',
    });
    const decision = await adapter.evaluateAccess(makeRequest());
    expect(opaCalls[0]?.decisionPath).toBe('/v1/data/custom/path');
    expect(adapter.engine).toBe('opa-test');
    if (decision.outcome === 'deny') {
      expect(decision.policyVersion).toBe('opa-test-adapter-error');
    }
  });
});
