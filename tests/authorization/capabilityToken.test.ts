/**
 * tests/authorization/capabilityToken.test.ts — unit tests for
 * capabilityToken.ts (T-144).
 *
 * Covers:
 *   1. mintCapabilityToken: happy-path minting from an allow decision.
 *   2. mintCapabilityToken: rejects non-allow decisions (deny /
 *      requires_escalation / requires_approval) with CapabilityTokenError.
 *   3. mintCapabilityToken: all token fields populated correctly
 *      (tokenId, subject, sessionId, taskId, issuedAtIso, expiresAtIso,
 *      capabilities, policy evidence).
 *   4. mintCapabilityToken: grantIds forwarded when present on decision.
 *   5. validateCapabilityToken: valid token passes.
 *   6. validateCapabilityToken: expired token rejected.
 *   7. validateCapabilityToken: missing / empty paths in ScopeClaim rejected.
 *   8. validateCapabilityToken: missing / empty branches in ScopeClaim rejected.
 *   9. validateCapabilityToken: missing decisionId in policy evidence rejected.
 *  10. validateCapabilityToken: missing policyVersion in policy evidence rejected.
 *  11. validateCapabilityToken: absent engine skips evidence validation.
 *  12. Existing lifecycle regression: base EngagementTokenEnvelope shape
 *      is never mutated by minting.
 */
import { describe, it, expect } from 'vitest';

import {
  mintCapabilityToken,
  validateCapabilityToken,
  CapabilityTokenError,
} from '../../src/hoplon/authorization/capabilityToken.js';
import type {
  CapabilityEngagementToken,
  PolicyEvidence,
} from '../../src/hoplon/authorization/capabilityToken.js';
import type {
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
  TokenCapabilities,
} from '../../src/hoplon/authorization/authorizationAdapter.js';
import type { EngagementTokenEnvelope } from '../../src/hoplon/concurrency/projectPolicy.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_NOW = new Date('2026-05-02T10:00:00.000Z');
const FIXED_TOKEN_ID = 'aaabbbcccdddeee0';

function makeRbaaEvidence(): NonNullable<
  Extract<HoplonAuthorizationDecision, { outcome: 'allow' }>['rbaa']
> {
  return {
    schemaVersion: 1,
    limits: {
      expiresInSeconds: 300,
      maxOperations: 5,
      maxFilesTouched: 3,
    },
    risk: {
      evaluationId: 'risk-eval-1',
      band: 'R3_APPROVAL',
      scoreBucket: '60-79',
      autonomyTier: 'A2_SCOPED_EDITOR',
      controls: ['human_review_required', 'short_ttl'],
      topFactors: [
        {
          id: 'factor-protected-branch',
          source: 'control_plane',
          label: 'protected branch',
          severity: 'high',
          evidenceRef: 'audit://risk/factor-protected-branch',
        },
      ],
    },
  };
}

function later(offsetMs: number): Date {
  return new Date(BASE_NOW.getTime() + offsetMs);
}

function makeAllowDecision(
  overrides: Partial<Extract<HoplonAuthorizationDecision, { outcome: 'allow' }>> = {},
): Extract<HoplonAuthorizationDecision, { outcome: 'allow' }> {
  return {
    outcome: 'allow',
    source: 'standing_policy',
    capabilities: {
      read: { paths: ['src/**'], branches: ['main'] },
      write: { paths: ['src/**'], branches: ['main'], maxFilesTouched: 10 },
    },
    expiresInSeconds: 3600,
    decisionId: 'decision-001',
    policyVersion: 'v1.0',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<HoplonAuthorizationRequest> = {}): HoplonAuthorizationRequest {
  return {
    principal: { id: 'agent-a', type: 'agent', roles: ['swe'] },
    task: { id: 'task-042' },
    request: {
      projectId: 'proj-x',
      branch: 'main',
      capabilities: ['read', 'write'],
      paths: ['src/hoplon/authorization/capabilityToken.ts'],
    },
    context: {
      sessionId: 'sess-abc123',
      environment: 'dev',
      now: BASE_NOW.toISOString(),
    },
    ...overrides,
  };
}

function makeBaseEnvelope(overrides: Partial<EngagementTokenEnvelope> = {}): EngagementTokenEnvelope {
  return {
    token: 'envelope-token-' + 'x'.repeat(48),
    projectId: 'proj-x',
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: BASE_NOW.toISOString(),
    expiresAtIso: later(3_600_000).toISOString(),
    ...overrides,
  };
}

function makeDeps(now: Date = BASE_NOW) {
  return {
    generateTokenId: () => FIXED_TOKEN_ID,
    clock: () => now,
    engineName: 'static',
  };
}

// ─── Tests: minting ─────────────────────────────────────────────────────────

describe('mintCapabilityToken (T-144)', () => {
  it('1. returns a CapabilityEngagementToken for an allow decision', () => {
    const token = mintCapabilityToken(
      makeAllowDecision(),
      makeRequest(),
      3600,
      makeBaseEnvelope(),
      makeDeps(),
    );
    expect(token.tokenId).toBe(FIXED_TOKEN_ID);
    expect(token.subject).toBe('agent-a');
    expect(token.sessionId).toBe('sess-abc123');
    expect(token.taskId).toBe('task-042');
    expect(token.capabilities.read).toBeDefined();
    expect(token.capabilities.write).toBeDefined();
  });

  it('2a. throws CapabilityTokenError(non_allow_decision) for deny', () => {
    const denyDecision: HoplonAuthorizationDecision = {
      outcome: 'deny',
      reason: 'forbidden',
      decisionId: 'deny-001',
      policyVersion: 'v1.0',
    };
    expect(() =>
      mintCapabilityToken(
        denyDecision as HoplonAuthorizationDecision & { outcome: 'allow' },
        makeRequest(),
        3600,
        makeBaseEnvelope(),
        makeDeps(),
      ),
    ).toThrowError(CapabilityTokenError);
    try {
      mintCapabilityToken(
        denyDecision as HoplonAuthorizationDecision & { outcome: 'allow' },
        makeRequest(),
        3600,
        makeBaseEnvelope(),
        makeDeps(),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityTokenError);
      if (err instanceof CapabilityTokenError) {
        expect(err.kind).toBe('non_allow_decision');
      }
    }
  });

  it('2b. throws CapabilityTokenError for requires_escalation', () => {
    const escalate: HoplonAuthorizationDecision = {
      outcome: 'requires_escalation',
      escalationKind: 'human_approval',
      requestedScope: { read: { paths: ['**'], branches: ['**'] } },
      reason: 'needs approval',
      decisionId: 'esc-001',
      policyVersion: 'v1.0',
    };
    expect(() =>
      mintCapabilityToken(
        escalate as HoplonAuthorizationDecision & { outcome: 'allow' },
        makeRequest(),
        3600,
        makeBaseEnvelope(),
        makeDeps(),
      ),
    ).toThrowError(CapabilityTokenError);
  });

  it('2c. throws CapabilityTokenError for requires_approval', () => {
    const approval: HoplonAuthorizationDecision = {
      outcome: 'requires_approval',
      escalationKind: 'security_approval',
      requestedScope: {},
      reason: 'security review needed',
      decisionId: 'appr-001',
      policyVersion: 'v1.0',
    };
    expect(() =>
      mintCapabilityToken(
        approval as HoplonAuthorizationDecision & { outcome: 'allow' },
        makeRequest(),
        3600,
        makeBaseEnvelope(),
        makeDeps(),
      ),
    ).toThrowError(CapabilityTokenError);
  });

  it('3. token fields are fully populated from decision + request', () => {
    const decision = makeAllowDecision({
      source: 'escalation_grant',
      grantIds: ['grant-1', 'grant-2'],
    });
    const token = mintCapabilityToken(
      decision,
      makeRequest(),
      1800,
      makeBaseEnvelope(),
      makeDeps(),
    );

    // Base envelope fields preserved.
    expect(token.token).toBe(makeBaseEnvelope().token);
    expect(token.projectId).toBe('proj-x');
    expect(token.folder).toBe('src');
    expect(token.access).toBe('read_write');
    expect(token.principalId).toBe('agent-a');

    // Extension fields.
    expect(token.subject).toBe('agent-a');
    expect(token.sessionId).toBe('sess-abc123');
    expect(token.taskId).toBe('task-042');

    // issuedAtIso and expiresAtIso reflect injected clock + TTL.
    expect(token.issuedAtIso).toBe(BASE_NOW.toISOString());
    const expectedExpiry = new Date(
      BASE_NOW.getTime() + 1800 * 1000,
    ).toISOString();
    expect(token.expiresAtIso).toBe(expectedExpiry);

    // Policy evidence.
    expect(token.policy.engine).toBe('static');
    expect(token.policy.source).toBe('escalation_grant');
    expect(token.policy.decisionId).toBe('decision-001');
    expect(token.policy.policyVersion).toBe('v1.0');
    expect(token.policy.grantIds).toEqual(['grant-1', 'grant-2']);
  });

  it('4. grantIds omitted from policy evidence when absent on decision', () => {
    const decision = makeAllowDecision(); // no grantIds
    const token = mintCapabilityToken(
      decision,
      makeRequest(),
      3600,
      makeBaseEnvelope(),
      makeDeps(),
    );
    expect(token.policy.grantIds).toBeUndefined();
  });

  it('12. base EngagementTokenEnvelope object is not mutated by minting', () => {
    const envelope = makeBaseEnvelope();
    const originalToken = envelope.token;
    const originalProjectId = envelope.projectId;
    mintCapabilityToken(
      makeAllowDecision(),
      makeRequest(),
      3600,
      envelope,
      makeDeps(),
    );
    // The original envelope fields are unchanged.
    expect(envelope.token).toBe(originalToken);
    expect(envelope.projectId).toBe(originalProjectId);
  });

  it('13. minted token capabilities and policy grantIds are detached from caller-owned decision objects', () => {
    const decision = makeAllowDecision({ grantIds: ['grant-1'] });
    const token = mintCapabilityToken(
      decision,
      makeRequest(),
      3600,
      makeBaseEnvelope(),
      makeDeps(),
    );

    decision.capabilities.read?.paths.push('src/mutated-after-mint.ts');
    decision.grantIds?.push('grant-2');

    expect(token.capabilities.read?.paths).toEqual(['src/**']);
    expect(token.policy.grantIds).toEqual(['grant-1']);
    expect(() => token.capabilities.read?.paths.push('src/token-mutated.ts')).toThrow(
      TypeError,
    );
    expect(() => token.policy.grantIds?.push('grant-3')).toThrow(TypeError);
  });

  it('14. carries frozen RBAA risk and limit evidence when present on an allow decision', () => {
    const decision = makeAllowDecision({
      rbaa: makeRbaaEvidence(),
      grantIds: ['grant-rbaa-1'],
    });
    const token = mintCapabilityToken(
      decision,
      makeRequest(),
      300,
      makeBaseEnvelope(),
      makeDeps(),
    );

    expect(token.policy.rbaa?.risk.evaluationId).toBe('risk-eval-1');
    expect(token.policy.rbaa?.risk.band).toBe('R3_APPROVAL');
    expect(token.policy.rbaa?.limits.maxOperations).toBe(5);
    expect(token.policy.grantIds).toEqual(['grant-rbaa-1']);

    decision.rbaa?.risk.controls.push('enhanced_audit');
    expect(token.policy.rbaa?.risk.controls).toEqual([
      'human_review_required',
      'short_ttl',
    ]);
    expect(() => token.policy.rbaa?.risk.controls.push('enhanced_audit')).toThrow(
      TypeError,
    );
  });
});

// ─── Tests: validation ──────────────────────────────────────────────────────

describe('validateCapabilityToken (T-144)', () => {
  function makeValidToken(overrides: Partial<CapabilityEngagementToken> = {}): CapabilityEngagementToken {
    const base = mintCapabilityToken(
      makeAllowDecision(),
      makeRequest(),
      3600,
      makeBaseEnvelope(),
      makeDeps(),
    );
    // Object.freeze prevents direct mutation; spread to override.
    return { ...base, ...overrides };
  }

  it('5. valid token passes validation', () => {
    const token = makeValidToken();
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.token.tokenId).toBe(FIXED_TOKEN_ID);
    }
  });

  it('6. expired token is rejected', () => {
    const token = makeValidToken();
    // Advance well past the 3600s TTL.
    const result = validateCapabilityToken(token, later(4_000_000));
    expect(result.kind).toBe('expired');
    if (result.kind === 'expired') {
      expect(result.tokenId).toBe(FIXED_TOKEN_ID);
    }
  });

  it('6b. malformed expiresAtIso is treated as expired', () => {
    const token = makeValidToken({ expiresAtIso: 'not-a-date' });
    const result = validateCapabilityToken(token, BASE_NOW);
    expect(result.kind).toBe('expired');
  });

  it('7. ScopeClaim with empty paths array is rejected', () => {
    const token = makeValidToken({
      capabilities: {
        read: { paths: [], branches: ['main'] },
      },
    });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('invalid_scope_claim');
    if (result.kind === 'invalid_scope_claim') {
      expect(result.field).toMatch(/paths/);
    }
  });

  it('8. ScopeClaim with empty branches array is rejected', () => {
    const token = makeValidToken({
      capabilities: {
        write: { paths: ['src/**'], branches: [] },
      },
    });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('invalid_scope_claim');
    if (result.kind === 'invalid_scope_claim') {
      expect(result.field).toMatch(/branches/);
    }
  });

  it('9. missing decisionId in policy evidence is rejected', () => {
    const badPolicy: PolicyEvidence = {
      engine: 'opa',
      source: 'standing_policy',
      decisionId: '',
      policyVersion: 'v1.0',
    };
    const token = makeValidToken({ policy: badPolicy });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('missing_policy_evidence');
    if (result.kind === 'missing_policy_evidence') {
      expect(result.field).toMatch(/decisionId/);
    }
  });

  it('10. missing policyVersion in policy evidence is rejected', () => {
    const badPolicy: PolicyEvidence = {
      engine: 'opa',
      source: 'standing_policy',
      decisionId: 'dec-001',
      policyVersion: '',
    };
    const token = makeValidToken({ policy: badPolicy });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('missing_policy_evidence');
    if (result.kind === 'missing_policy_evidence') {
      expect(result.field).toMatch(/policyVersion/);
    }
  });

  it('11. absent engine skips policy evidence validation entirely', () => {
    const engineAbsent: PolicyEvidence = {
      engine: '',
      source: 'standing_policy',
      decisionId: '',
      policyVersion: '',
    };
    const token = makeValidToken({ policy: engineAbsent });
    const result = validateCapabilityToken(token, later(0));
    // Engine is absent (empty string) → evidence fields not required.
    expect(result.kind).toBe('valid');
  });

  it('validates all five capability keys independently', () => {
    const allCaps: TokenCapabilities = {
      read: { paths: ['**'], branches: ['**'] },
      search: { paths: ['src/**'], branches: ['main', 'develop'] },
      write: { paths: ['src/**'], branches: ['feature/*'] },
      lock: { paths: ['src/**'], branches: ['main'] },
      snapshot: { paths: ['**'], branches: ['**'] },
    };
    const token = makeValidToken({ capabilities: allCaps });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('valid');
  });

  it('accepts optional ScopeClaim fields (deniedPaths, astNodeIds, astSelectors, maxOperations, maxFilesTouched)', () => {
    const richCap: TokenCapabilities = {
      write: {
        paths: ['src/**'],
        branches: ['main'],
        deniedPaths: ['src/secrets/**'],
        astNodeIds: ['node-1'],
        astSelectors: ['.functionDeclaration'],
        maxOperations: 50,
        maxFilesTouched: 5,
      },
    };
    const token = makeValidToken({ capabilities: richCap });
    const result = validateCapabilityToken(token, later(0));
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.token.capabilities.write?.maxFilesTouched).toBe(5);
    }
  });
});
