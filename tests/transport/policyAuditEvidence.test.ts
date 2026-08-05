/**
 * tests/transport/policyAuditEvidence.test.ts — t-148 unit proof for
 * the bounded-redaction helpers, the typed handshake-authz mapper, and
 * the typed capability-check mapper.
 *
 * Critical H13 invariant covered: the ALLOW handshake mapping must
 * NEVER place the raw bearer token bytes (`capabilityToken.token`) onto
 * the persisted audit row. The test asserts this directly via JSON
 * substring search after stringifying the produced row.
 */
import { describe, expect, it } from 'vitest';

import {
  POLICY_AUDIT_MAX_GRANT_IDS,
  POLICY_AUDIT_MAX_PATHS,
  POLICY_AUDIT_MAX_PATH_LENGTH,
  POLICY_AUDIT_TRUNCATION_MARKER,
} from '../../src/hoplon/contracts/policyAudit.js';
import {
  auditEngineFromName,
  boundDetail,
  boundGrantIds,
  boundPathArray,
  boundString,
  mapHandshakeAuthzOutcome,
} from '../../src/hoplon/transport/policyAuditEvidence.js';
import { mapCapabilityCheck } from '../../src/hoplon/transport/policyAuditCapability.js';
import type {
  CapabilityEngagementToken,
  PolicyEvidence,
} from '../../src/hoplon/authorization/capabilityToken.js';
import type { HandshakeAuthzResult } from '../../src/hoplon/launcher/handshakeAuthz.js';

const RAW_BEARER = 'super-secret-bearer-token-bytes-do-not-leak-' + 'x'.repeat(80);
const TOKEN_ID = 'tk_t148_redaction_proof';

function makeRbaaEvidence(): NonNullable<PolicyEvidence['rbaa']> {
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
        },
      ],
    },
  };
}

function makeAllowResult(): HandshakeAuthzResult {
  const capabilityToken: CapabilityEngagementToken = Object.freeze({
    token: RAW_BEARER,
    projectId: 'p1',
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-05-03T00:00:00.000Z',
    expiresAtIso: '2026-05-03T01:00:00.000Z',
    tokenId: TOKEN_ID,
    subject: 'agent-a',
    sessionId: 'sess-1',
    capabilities: {
      write: { paths: ['src/**'], branches: ['feature/login'] },
      read: { paths: ['**'], branches: ['**'] },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'static-allow-1',
      policyVersion: 'v1',
    },
  });
  return {
    kind: 'allow',
    projectId: 'p1',
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    resolution: 'matched',
    matchedRule: { folder: 'src', index: 0 },
    engagement: {
      token: RAW_BEARER,
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: 'agent-a',
      issuedAtIso: '2026-05-03T00:00:00.000Z',
      expiresAtIso: '2026-05-03T01:00:00.000Z',
    },
    capabilityToken,
    capabilities: capabilityToken.capabilities,
    decisionId: 'static-allow-1',
    policyVersion: 'v1',
    grantIds: ['grant-a', 'grant-b'],
    source: 'standing_policy',
    expiresInSeconds: 3600,
  };
}

function makeRbaaAllowResult(): HandshakeAuthzResult {
  const base = makeAllowResult();
  if (base.kind !== 'allow') return base;
  const capabilityToken: CapabilityEngagementToken = Object.freeze({
    ...base.capabilityToken,
    taskId: 'task-rbaa',
    policy: Object.freeze({
      ...base.capabilityToken.policy,
      engine: 'opa',
      decisionId: 'rbaa-decision-1',
      policyVersion: 'rbaa-policy-v1',
      grantIds: ['grant-rbaa-1'],
      rbaa: makeRbaaEvidence(),
    }),
  });
  return {
    ...base,
    capabilityToken,
    grantIds: ['grant-rbaa-1'],
    decisionId: 'rbaa-decision-1',
    policyVersion: 'rbaa-policy-v1',
  };
}

describe('t-148 policyAuditEvidence — redaction proof (H13)', () => {
  it('mapHandshakeAuthzOutcome ALLOW does NOT persist the raw bearer token bytes', () => {
    const result = makeAllowResult();
    const mapping = mapHandshakeAuthzOutcome(result, 'static');
    const json = JSON.stringify(mapping);
    expect(json).not.toContain(RAW_BEARER);
    expect(mapping.event.tokenId).toBe(TOKEN_ID);
    expect(mapping.event.issuedTokenId).toBe(TOKEN_ID);
    expect(mapping.event.policyEngine).toBe('static');
    expect(mapping.event.decisionId).toBe('static-allow-1');
    expect(mapping.event.policyVersion).toBe('v1');
    expect(mapping.event.grantIds).toEqual(['grant-a', 'grant-b']);
    expect(mapping.event.paths).toEqual(['src/**']);
    expect(mapping.event.branch).toBe('feature/login');
  });

  it('maps ALLOW RBAA risk, grant, and limit evidence without raw bearer material', () => {
    const result = makeRbaaAllowResult();
    const mapping = mapHandshakeAuthzOutcome(result, 'opa');
    const json = JSON.stringify(mapping);

    expect(json).not.toContain(RAW_BEARER);
    expect(mapping.event.rbaaEvidence).toMatchObject({
      schemaVersion: 1,
      sessionId: 'sess-1',
      taskId: 'task-rbaa',
      decisionId: 'rbaa-decision-1',
      policyVersion: 'rbaa-policy-v1',
      tokenId: TOKEN_ID,
      grantIds: ['grant-rbaa-1'],
      limits: {
        expiresInSeconds: 300,
        maxOperations: 5,
        maxFilesTouched: 3,
      },
      riskEvaluationId: 'risk-eval-1',
      riskBand: 'R3_APPROVAL',
      autonomyTier: 'A2_SCOPED_EDITOR',
      runtimeControls: ['human_review_required', 'short_ttl'],
      outcome: 'allow',
      recordedAt: '2026-05-03T00:00:00.000Z',
    });
  });
});

describe('t-148 policyAuditEvidence — bounded redaction', () => {
  it('boundString truncates with the documented marker', () => {
    const out = boundString('a'.repeat(50), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith(POLICY_AUDIT_TRUNCATION_MARKER)).toBe(true);
  });

  it('boundString returns input unchanged when within cap', () => {
    expect(boundString('hello', 10)).toBe('hello');
  });

  it('boundDetail caps detail strings', () => {
    expect(boundDetail(null)).toBeNull();
    expect(boundDetail(undefined)).toBeNull();
    const long = 'd'.repeat(500);
    const out = boundDetail(long);
    expect(out).not.toBeNull();
    expect((out as string).endsWith(POLICY_AUDIT_TRUNCATION_MARKER)).toBe(true);
  });

  it('boundPathArray caps paths and emits a marker entry', () => {
    const tooMany = Array.from(
      { length: POLICY_AUDIT_MAX_PATHS + 5 },
      (_, i) => `path/${i}`,
    );
    const result = boundPathArray(tooMany);
    expect(result.truncated).toBe(true);
    expect(result.values).toHaveLength(POLICY_AUDIT_MAX_PATHS);
    expect(result.values[result.values.length - 1]).toBe(
      POLICY_AUDIT_TRUNCATION_MARKER,
    );
  });

  it('boundPathArray truncates per-entry length', () => {
    const longPath = 'p'.repeat(POLICY_AUDIT_MAX_PATH_LENGTH + 50);
    const result = boundPathArray([longPath]);
    expect(result.values[0]?.endsWith(POLICY_AUDIT_TRUNCATION_MARKER)).toBe(true);
  });

  it('boundGrantIds caps grant ids', () => {
    const tooMany = Array.from(
      { length: POLICY_AUDIT_MAX_GRANT_IDS + 3 },
      (_, i) => `grant-${i}`,
    );
    const result = boundGrantIds(tooMany);
    expect(result.truncated).toBe(true);
    expect(result.values).toHaveLength(POLICY_AUDIT_MAX_GRANT_IDS);
  });
});

describe('t-148 policyAuditEvidence — engine widener', () => {
  it('returns static / opa / unknown', () => {
    expect(auditEngineFromName('static')).toBe('static');
    expect(auditEngineFromName('opa')).toBe('opa');
    expect(auditEngineFromName('something-else')).toBe('unknown');
    expect(auditEngineFromName(null)).toBe('unknown');
    expect(auditEngineFromName(undefined)).toBe('unknown');
  });
});

describe('t-148 policyAuditEvidence — handshake authz mapping', () => {
  it('maps requires_escalation to REAUTH_REQUIRED with a typed reason', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'requires_escalation',
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-a',
        escalationKind: 'cto_approval',
        requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
        reason: 'cto approval required',
        decisionId: 'd-1',
        policyVersion: 'v2',
      },
      'opa',
    );
    expect(mapping.result).toBe('REAUTH_REQUIRED');
    expect(mapping.event.reasonCode).toBe('handshake_requires_escalation');
    expect(mapping.event.policyEngine).toBe('opa');
    expect(mapping.event.tokenId).toBeNull();
  });

  it('maps deny adapter_error to handshake_adapter_error', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'deny',
        projectId: 'p1',
        folder: 'src',
        principalId: null,
        access: 'none',
        reason: 'adapter_error: opa_unavailable',
        decisionId: 'adapter-error-xyz',
        policyVersion: 'adapter-error',
      },
      'opa',
    );
    expect(mapping.result).toBe('DENIED');
    expect(mapping.event.reasonCode).toBe('handshake_adapter_error');
    expect(mapping.event.detail).toContain('adapter_error: opa_unavailable');
  });

  it('maps deny adapter_invalid_expires_in_seconds to handshake_adapter_invalid_expires', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'deny',
        projectId: 'p1',
        folder: 'src',
        principalId: null,
        access: 'none',
        reason: 'adapter_invalid_expires_in_seconds',
        decisionId: 'd-2',
        policyVersion: 'v1',
      },
      'opa',
    );
    expect(mapping.event.reasonCode).toBe('handshake_adapter_invalid_expires');
  });

  it('maps deny adapter_allow_with_empty_capabilities', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'deny',
        projectId: 'p1',
        folder: 'src',
        principalId: null,
        access: 'none',
        reason: 'adapter_allow_with_empty_capabilities',
        decisionId: 'd-3',
        policyVersion: 'v1',
      },
      'opa',
    );
    expect(mapping.event.reasonCode).toBe('handshake_adapter_empty_capabilities');
  });

  it('maps deny mint_error to handshake_mint_error', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'deny',
        projectId: 'p1',
        folder: 'src',
        principalId: null,
        access: 'none',
        reason: 'mint_error: token_expired',
        decisionId: 'd-4',
        policyVersion: 'v1',
      },
      'static',
    );
    expect(mapping.event.reasonCode).toBe('handshake_mint_error');
  });

  it('maps deny generic policy reason to handshake_policy_denied', () => {
    const mapping = mapHandshakeAuthzOutcome(
      {
        kind: 'deny',
        projectId: 'p1',
        folder: 'secrets',
        principalId: null,
        access: 'none',
        reason: 'No matching folder rule allows access to "secrets"',
        decisionId: 'd-5',
        policyVersion: 'v1',
      },
      'static',
    );
    expect(mapping.event.reasonCode).toBe('handshake_policy_denied');
  });
});

describe('t-148 policyAuditEvidence — capability check mapping', () => {
  it('maps ok to capability_granted GRANTED', () => {
    const tok: CapabilityEngagementToken = makeAllowResult().capabilityToken!;
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'ok' },
      token: tok,
      capability: 'read',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'src/foo.ts',
    });
    expect(mapping.result).toBe('GRANTED');
    expect(mapping.event.reasonCode).toBe('capability_granted');
    expect(mapping.event.tokenId).toBe(TOKEN_ID);
    expect(mapping.event.capability).toBe('read');
    expect(mapping.event.branch).toBe('feature/login');
    expect(mapping.event.paths).toEqual(['src/foo.ts']);
  });

  it('maps denied path_mismatch to capability_denied_path_mismatch DENIED', () => {
    const tok = makeAllowResult().capabilityToken!;
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'denied', reason: 'path_mismatch' },
      token: tok,
      capability: 'write',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'docs/foo.md',
    });
    expect(mapping.result).toBe('DENIED');
    expect(mapping.event.reasonCode).toBe('capability_denied_path_mismatch');
  });

  it('maps reauth_required token_expired to capability_reauth_token_expired REAUTH_REQUIRED', () => {
    const tok = makeAllowResult().capabilityToken!;
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'reauth_required', reason: 'token_expired' },
      token: tok,
      capability: 'read',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'src/foo.ts',
    });
    expect(mapping.result).toBe('REAUTH_REQUIRED');
    expect(mapping.event.reasonCode).toBe('capability_reauth_token_expired');
  });

  it('maps reauth_required missing_ast_coords to capability_reauth_missing_ast_coords', () => {
    const tok = makeAllowResult().capabilityToken!;
    const mapping = mapCapabilityCheck({
      assertion: {
        kind: 'reauth_required',
        reason: 'missing_ast_coords',
      },
      token: tok,
      capability: 'write',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'src/foo.ts',
    });
    expect(mapping.event.reasonCode).toBe('capability_reauth_missing_ast_coords');
  });

  it('maps RBAA runtime-state denials and reauths to typed reason codes', () => {
    const tok = makeRbaaAllowResult().capabilityToken!;
    expect(
      mapCapabilityCheck({
        assertion: { kind: 'denied', reason: 'token_quarantined' },
        token: tok,
        capability: 'write',
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-a',
        branch: 'feature/login',
        path: 'src/foo.ts',
      }).event.reasonCode,
    ).toBe('capability_denied_token_quarantined');
    expect(
      mapCapabilityCheck({
        assertion: { kind: 'denied', reason: 'grant_revoked' },
        token: tok,
        capability: 'write',
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-a',
        branch: 'feature/login',
        path: 'src/foo.ts',
      }).event.reasonCode,
    ).toBe('capability_denied_grant_revoked');
    expect(
      mapCapabilityCheck({
        assertion: { kind: 'reauth_required', reason: 'missing_runtime_state' },
        token: tok,
        capability: 'write',
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-a',
        branch: 'feature/login',
        path: 'src/foo.ts',
      }).event.reasonCode,
    ).toBe('capability_reauth_missing_runtime_state');
    expect(
      mapCapabilityCheck({
        assertion: {
          kind: 'reauth_required',
          reason: 'operation_limit_exceeded',
        },
        token: tok,
        capability: 'write',
        projectId: 'p1',
        folder: 'src',
        principalId: 'agent-a',
        branch: 'feature/login',
        path: 'src/foo.ts',
      }).event.reasonCode,
    ).toBe('capability_reauth_operation_limit_exceeded');
  });

  it('persists tokenId from capabilityToken.tokenId, NOT from capabilityToken.token', () => {
    const tok = makeAllowResult().capabilityToken!;
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'ok' },
      token: tok,
      capability: 'read',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'src/foo.ts',
    });
    const json = JSON.stringify(mapping);
    expect(json).not.toContain(RAW_BEARER);
    expect(mapping.event.tokenId).toBe(TOKEN_ID);
  });

  it('maps capability-check RBAA evidence without raw bearer material', () => {
    const result = makeRbaaAllowResult();
    if (result.kind !== 'allow') throw new Error('fixture must allow');
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'ok' },
      token: result.capabilityToken,
      capability: 'write',
      projectId: 'p1',
      folder: 'src',
      principalId: 'agent-a',
      branch: 'feature/login',
      path: 'src/foo.ts',
      recordedAtIso: '2026-05-03T00:01:00.000Z',
    });
    const json = JSON.stringify(mapping);

    expect(json).not.toContain(RAW_BEARER);
    expect(mapping.event.rbaaEvidence).toMatchObject({
      tokenId: TOKEN_ID,
      grantIds: ['grant-rbaa-1'],
      limits: { expiresInSeconds: 300, maxOperations: 5 },
      riskEvaluationId: 'risk-eval-1',
      outcome: 'allow',
      recordedAt: '2026-05-03T00:01:00.000Z',
    });
  });

  it('handles missing token (gate-side fail-closed) without throwing', () => {
    const mapping = mapCapabilityCheck({
      assertion: { kind: 'reauth_required', reason: 'invalid_token' },
      token: null,
      capability: 'read',
      projectId: 'p1',
      folder: null,
      principalId: null,
      branch: 'main',
      path: 'src/x.ts',
    });
    expect(mapping.result).toBe('REAUTH_REQUIRED');
    expect(mapping.event.reasonCode).toBe('capability_reauth_invalid_token');
    expect(mapping.event.tokenId).toBeNull();
    expect(mapping.event.policyEngine).toBe('unknown');
  });
});
