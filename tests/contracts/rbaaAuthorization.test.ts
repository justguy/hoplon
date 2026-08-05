import { describe, expect, it } from 'vitest';

import {
  RbaaAuthorizationDecisionSchema,
  RbaaAuthorizationRequestSchema,
  RbaaEngagementTokenClaimsSchema,
  RbaaPolicyAuditEvidenceSchema,
  RbaaTokenCapabilitiesSchema,
} from '../../src/hoplon/contracts/rbaaAuthorization.js';

const riskFactor = {
  id: 'factor-protected-branch',
  source: 'control_plane',
  label: 'protected branch',
  severity: 'high',
  evidenceRef: 'audit://risk/factor-protected-branch',
} as const;

const riskPosture = {
  evaluationId: 'risk-eval-1',
  band: 'R3_APPROVAL',
  scoreBucket: '60-79',
  autonomyTier: 'A2_SCOPED_EDITOR',
  controls: ['human_review_required', 'short_ttl'],
  topFactors: [riskFactor],
} as const;

const writeCapability = {
  write: {
    paths: ['src/hoplon/contracts/**'],
    branches: ['feature/rbaa-contracts'],
    deniedPaths: ['src/hoplon/contracts/secrets/**'],
    astSelectors: ['exported_function:createPolicyEnvelope'],
    maxOperations: 5,
    maxFilesTouched: 3,
  },
} as const;

describe('RBAA authorization contracts', () => {
  it('accepts a risk-aware authorization request with active grants', () => {
    const result = RbaaAuthorizationRequestSchema.safeParse({
      schemaVersion: 1,
      principal: {
        id: 'agent-1',
        type: 'agent',
        roles: ['hoplon-editor'],
        trustTier: 'trusted-build-agent',
        modelProfile: 'code-reviewer',
        identityAssurance: 'high',
      },
      task: {
        id: 'task-rbaa',
        workPackageId: 'wp-rbaa',
        type: 'contract_change',
        missionPriority: 'high',
        delegationChain: ['human-1', 'agent-1'],
      },
      request: {
        projectId: 'hoplon',
        branch: 'feature/rbaa-contracts',
        capabilities: ['write'],
        paths: ['src/hoplon/contracts/**'],
        reason: 'contract surface implementation',
      },
      context: {
        sessionId: 'session-1',
        environment: 'dev',
        now: '2026-05-04T12:00:00.000Z',
      },
      riskFacts: {
        projectId: 'hoplon',
        branch: 'feature/rbaa-contracts',
        sessionId: 'session-1',
        evaluatedAt: '2026-05-04T12:00:00.000Z',
        facts: [riskFactor],
      },
      activeGrants: [
        {
          grantId: 'grant-1',
          principalId: 'agent-1',
          projectId: 'hoplon',
          taskId: 'task-rbaa',
          capabilities: writeCapability,
          grantedBy: 'human-1',
          issuedAt: '2026-05-04T11:55:00.000Z',
          expiresAt: '2026-05-04T12:25:00.000Z',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts an allow decision with controls, limits, and grant provenance', () => {
    const result = RbaaAuthorizationDecisionSchema.safeParse({
      schemaVersion: 1,
      outcome: 'allow',
      source: 'risk_adjusted',
      decisionId: 'decision-1',
      policyVersion: 'policy-2026-05-04',
      risk: riskPosture,
      capabilities: writeCapability,
      limits: {
        expiresInSeconds: 300,
        maxOperations: 5,
        maxFilesTouched: 3,
      },
      grantIds: ['grant-1'],
    });

    expect(result.success).toBe(true);
  });

  it('accepts quarantine and deny outcomes without token capabilities', () => {
    for (const outcome of ['quarantine', 'deny'] as const) {
      const result = RbaaAuthorizationDecisionSchema.safeParse({
        schemaVersion: 1,
        outcome,
        decisionId: `decision-${outcome}`,
        policyVersion: 'policy-2026-05-04',
        risk: {
          ...riskPosture,
          band: 'R4_QUARANTINE_OR_DENY',
          controls: ['quarantine_required', 'enhanced_audit'],
        },
        reason: `${outcome} required by policy`,
      });

      expect(result.success).toBe(true);
    }
  });

  it('rejects empty and unsafe capability scopes', () => {
    expect(RbaaTokenCapabilitiesSchema.safeParse({}).success).toBe(false);
    expect(
      RbaaTokenCapabilitiesSchema.safeParse({
        read: { paths: ['../outside'], branches: ['main'] },
      }).success,
    ).toBe(false);
  });

  it('accepts engagement token claims with risk and policy provenance', () => {
    const result = RbaaEngagementTokenClaimsSchema.safeParse({
      schemaVersion: 1,
      tokenId: 'token-claim-1',
      subject: {
        id: 'agent-1',
        type: 'agent',
        roles: ['hoplon-editor'],
      },
      projectId: 'hoplon',
      sessionId: 'session-1',
      taskId: 'task-rbaa',
      capabilities: writeCapability,
      limits: { expiresInSeconds: 300, maxOperations: 5 },
      risk: riskPosture,
      policy: {
        engine: 'opa',
        decisionId: 'decision-1',
        policyVersion: 'policy-2026-05-04',
        grantIds: ['grant-1'],
      },
      issuedAt: '2026-05-04T12:00:00.000Z',
      expiresAt: '2026-05-04T12:05:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('rejects raw bearer material in audit evidence', () => {
    const result = RbaaPolicyAuditEvidenceSchema.safeParse({
      schemaVersion: 1,
      sessionId: 'session-1',
      taskId: 'task-rbaa',
      decisionId: 'decision-1',
      policyVersion: 'policy-2026-05-04',
      tokenId: 'token-claim-1',
      limits: { expiresInSeconds: 300, maxOperations: 5 },
      riskEvaluationId: 'risk-eval-1',
      riskBand: 'R3_APPROVAL',
      autonomyTier: 'A2_SCOPED_EDITOR',
      runtimeControls: ['human_review_required'],
      outcome: 'allow',
      recordedAt: '2026-05-04T12:00:01.000Z',
      rawBearerToken: 'secret-token-bytes',
    });

    expect(result.success).toBe(false);
  });

  it('accepts redacted audit evidence with RBAA limits and risk posture handles', () => {
    const result = RbaaPolicyAuditEvidenceSchema.safeParse({
      schemaVersion: 1,
      sessionId: 'session-1',
      taskId: 'task-rbaa',
      decisionId: 'decision-1',
      policyVersion: 'policy-2026-05-04',
      tokenId: 'token-claim-1',
      grantIds: ['grant-1'],
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
      recordedAt: '2026-05-04T12:00:01.000Z',
    });

    expect(result.success).toBe(true);
  });
});
