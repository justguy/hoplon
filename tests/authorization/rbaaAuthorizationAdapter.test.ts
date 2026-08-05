import { describe, expect, it } from 'vitest';

import {
  RbaaAuthorizationAdapter,
} from '../../src/hoplon/authorization/rbaaAuthorizationAdapter.js';
import {
  DEFAULT_RBAA_OPA_DECISION_PATH,
  RbaaOpaAuthorizationClient,
  type RbaaActiveGrantProvider,
  type RbaaAuthorizationClient,
  type RbaaAuthorizationClientResult,
  type RbaaRiskFactsProvider,
} from '../../src/hoplon/authorization/rbaaAuthorizationClient.js';
import type { OpaClient } from '../../src/hoplon/authorization/opaClient.js';
import type {
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';
import type {
  RbaaActiveGrant,
  RbaaAuthorizationDecision,
  RbaaAuthorizationRequest,
} from '../../src/hoplon/contracts/rbaaAuthorization.js';

const NOW = '2026-05-06T02:00:00.000Z';
const ERROR_DECISION_ID = 'rbaa-adapter-error-id';

const riskFactor = {
  id: 'factor-1',
  source: 'hoplon',
  label: 'fixture risk',
  severity: 'medium',
} as const;

const risk = {
  evaluationId: 'risk-1',
  band: 'R1_GUARDED',
  scoreBucket: '20-39',
  autonomyTier: 'A2_SCOPED_EDITOR',
  controls: ['short_ttl'],
  topFactors: [riskFactor],
} as const;

const writeScope = {
  write: { paths: ['src/**'], branches: ['feature/rbaa'] },
} as const;

class CapturingRbaaClient implements RbaaAuthorizationClient {
  readonly calls: RbaaAuthorizationRequest[] = [];

  constructor(
    private readonly result:
      | RbaaAuthorizationClientResult
      | (() => RbaaAuthorizationClientResult),
  ) {}

  async evaluateAuthorization(
    request: RbaaAuthorizationRequest,
  ): Promise<RbaaAuthorizationClientResult> {
    this.calls.push(request);
    return typeof this.result === 'function' ? this.result() : this.result;
  }
}

function makeRequest(
  overrides: Partial<HoplonAuthorizationRequest> = {},
): HoplonAuthorizationRequest {
  return {
    principal: { id: 'agent-1', type: 'agent', roles: ['editor'] },
    task: { id: 'task-1', type: 'edit', riskLevel: 'medium' },
    request: {
      projectId: 'hoplon',
      branch: 'feature/rbaa',
      capabilities: ['write'],
      paths: ['src/index.ts'],
      reason: 'exercise rbaa adapter',
    },
    context: { sessionId: 'session-1', environment: 'dev', now: NOW },
    ...overrides,
  };
}

function makeAdapter(client: RbaaAuthorizationClient) {
  return new RbaaAuthorizationAdapter({
    client,
    hostProfile: 'phalanx_limited_controls',
    engineName: 'rbaa-test',
    generateDecisionId: () => ERROR_DECISION_ID,
  });
}

function allowDecision(
  source: Extract<RbaaAuthorizationDecision, { outcome: 'allow' }>['source'] =
    'risk_adjusted',
): RbaaAuthorizationDecision {
  return {
    schemaVersion: 1,
    outcome: 'allow',
    source,
    decisionId: 'rbaa-decision-1',
    policyVersion: 'rbaa-policy-v1',
    risk,
    capabilities: writeScope,
    limits: { expiresInSeconds: 300, maxOperations: 5 },
    grantIds: ['grant-1'],
  };
}

function quarantineDecision(): RbaaAuthorizationDecision {
  return {
    schemaVersion: 1,
    outcome: 'quarantine',
    decisionId: 'rbaa-quarantine-1',
    policyVersion: 'rbaa-policy-v1',
    risk: {
      ...risk,
      band: 'R4_QUARANTINE_OR_DENY',
      controls: ['quarantine_required'],
    },
    reason: 'quarantine_path',
  };
}

function activeGrant(): RbaaActiveGrant {
  return {
    grantId: 'grant-1',
    principalId: 'agent-1',
    projectId: 'hoplon',
    taskId: 'task-1',
    capabilities: writeScope,
    grantedBy: 'human-1',
    issuedAt: '2026-05-06T01:55:00.000Z',
    expiresAt: '2026-05-06T02:30:00.000Z',
  };
}

function isDeny(
  decision: HoplonAuthorizationDecision,
): decision is Extract<HoplonAuthorizationDecision, { outcome: 'deny' }> {
  return decision.outcome === 'deny';
}

describe('RbaaAuthorizationAdapter', () => {
  it('builds an RBAA v1 request and maps risk_adjusted allow to the existing seam', async () => {
    const client = new CapturingRbaaClient({
      kind: 'ok',
      rawDecision: allowDecision(),
    });
    const adapter = makeAdapter(client);

    const decision = await adapter.evaluateAccess(makeRequest());

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    expect(decision.source).toBe('standing_policy');
    expect(decision.expiresInSeconds).toBe(300);
    expect(decision.grantIds).toEqual(['grant-1']);
    expect(decision.rbaa).toEqual({
      schemaVersion: 1,
      risk,
      limits: { expiresInSeconds: 300, maxOperations: 5 },
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.schemaVersion).toBe(1);
    expect(client.calls[0]?.riskFacts.facts[0]?.id).toBe(
      'baseline-phalanx_limited_controls',
    );
  });

  it('carries host-provided active grants into the RBAA request', async () => {
    const client = new CapturingRbaaClient({
      kind: 'ok',
      rawDecision: allowDecision('escalation_grant'),
    });
    const activeGrantProvider: RbaaActiveGrantProvider = {
      async listActiveGrants() {
        return { kind: 'ok', activeGrants: [activeGrant()] };
      },
    };
    const adapter = new RbaaAuthorizationAdapter({
      client,
      hostProfile: 'agentic_os_control_plane',
      activeGrantProvider,
      generateDecisionId: () => ERROR_DECISION_ID,
    });

    await adapter.evaluateAccess(makeRequest());

    expect(client.calls[0]?.activeGrants).toEqual([activeGrant()]);
  });

  it('maps quarantine to fail-closed deny on the existing Hoplon seam', async () => {
    const adapter = makeAdapter(
      new CapturingRbaaClient({ kind: 'ok', rawDecision: quarantineDecision() }),
    );

    const decision = await adapter.evaluateAccess(makeRequest());

    expect(isDeny(decision)).toBe(true);
    if (!isDeny(decision)) return;
    expect(decision.reason).toBe('rbaa_quarantine: quarantine_path');
    expect(decision.decisionId).toBe(ERROR_DECISION_ID);
  });

  it('fails closed when the RBAA client is unavailable or malformed', async () => {
    const unavailable = await makeAdapter(
      new CapturingRbaaClient({ kind: 'error', reason: 'control_plane_down' }),
    ).evaluateAccess(makeRequest());
    expect(unavailable.outcome).toBe('deny');
    if (unavailable.outcome === 'deny') {
      expect(unavailable.reason).toContain('rbaa_client_unavailable');
    }

    const malformed = await makeAdapter(
      new CapturingRbaaClient({ kind: 'ok', rawDecision: { outcome: 'allow' } }),
    ).evaluateAccess(makeRequest());
    expect(malformed.outcome).toBe('deny');
    if (malformed.outcome === 'deny') {
      expect(malformed.reason).toContain('rbaa_malformed_decision');
    }
  });

  it('fails closed when required risk facts or active grants are unavailable', async () => {
    const client = new CapturingRbaaClient({
      kind: 'ok',
      rawDecision: allowDecision(),
    });
    const riskFactsProvider: RbaaRiskFactsProvider = {
      async buildRiskFacts() {
        return { kind: 'unavailable', reason: 'risk_service_down' };
      },
    };
    const riskDenied = await new RbaaAuthorizationAdapter({
      client,
      hostProfile: 'direct_llm',
      riskFactsProvider,
      generateDecisionId: () => ERROR_DECISION_ID,
    }).evaluateAccess(makeRequest());
    expect(riskDenied.outcome).toBe('deny');
    expect(client.calls).toHaveLength(0);

    const grantDenied = await new RbaaAuthorizationAdapter({
      client,
      hostProfile: 'agentic_os_control_plane',
      activeGrantProvider: {
        async listActiveGrants() {
          return { kind: 'unavailable', reason: 'grant_service_down' };
        },
      },
      generateDecisionId: () => ERROR_DECISION_ID,
    }).evaluateAccess(makeRequest());
    expect(grantDenied.outcome).toBe('deny');
    if (grantDenied.outcome === 'deny') {
      expect(grantDenied.reason).toContain('rbaa_active_grants_unavailable');
    }
  });
});

describe('RbaaOpaAuthorizationClient', () => {
  it('wraps the existing OPA client with the RBAA v1 decision path', async () => {
    const calls: Array<{ decisionPath: string; input: unknown }> = [];
    const opaClient: OpaClient = {
      async evaluate(decisionPath, input) {
        calls.push({ decisionPath, input });
        return { kind: 'error', reason: 'opa_down' };
      },
    };
    const client = new RbaaOpaAuthorizationClient({ opaClient });

    const result = await client.evaluateAuthorization({
      ...makeRequest(),
      schemaVersion: 1,
      riskFacts: {
        projectId: 'hoplon',
        branch: 'feature/rbaa',
        sessionId: 'session-1',
        evaluatedAt: NOW,
        facts: [riskFactor],
      },
    } as RbaaAuthorizationRequest);

    expect(result).toEqual({ kind: 'error', reason: 'opa_down' });
    expect(calls[0]?.decisionPath).toBe(DEFAULT_RBAA_OPA_DECISION_PATH);
  });
});
