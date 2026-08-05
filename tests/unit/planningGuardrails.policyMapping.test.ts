import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_POLICY_AUTHORITY,
  FENCED_CONTRACT_SCHEMA_VERSIONS,
  DeterministicPolicyBundleSchema,
  compileFencedContractToDeterministicPolicyBundle,
  hashFencedContract,
  type FencedContract,
  type FencedContractBody,
} from '../../src/hoplon/contracts/index.js';

function contract(): FencedContract {
  const body: FencedContractBody = {
    schemaVersion: FENCED_CONTRACT_SCHEMA_VERSIONS[0],
    contractId: 'fenced-contract.t-160.fixture',
    provenance: {
      semantixVersion: '0.1.0',
      authoredAt: '2026-05-03T12:00:00.000Z',
      authoredBy: 'semantix-author@example.com',
    },
    compilerCompatibility: [{ compilerId: 'deterministic-policy', compilerVersion: '0.1.0' }],
    clauses: [
      {
        clauseId: 'goal.primary',
        clauseType: 'goal',
        goalKind: 'primary',
        description: 'Keep the plan scoped to trade reconciliation.',
      },
      {
        clauseId: 'boundary.paths',
        clauseType: 'boundary',
        boundaryKind: 'paths',
        values: ['src/reconcile/**'],
        description: 'Only reconcile source files are in scope.',
      },
      {
        clauseId: 'tool.deny',
        clauseType: 'tool_intent_denylist',
        toolIntents: ['trade.execute', 'net.egress'],
        description: 'Planner cannot execute trades or reach external APIs.',
      },
      {
        clauseId: 'domain.deny',
        clauseType: 'domain_denylist',
        domains: ['live-trading'],
        description: 'Live trading semantics stay advisory.',
      },
      {
        clauseId: 'evidence.audit',
        clauseType: 'evidence_requirement',
        evidenceKind: 'audit_log',
        mandatory: true,
        description: 'Audit evidence is required before handoff.',
      },
    ],
  };
  return { ...body, contractHash: hashFencedContract(body) };
}

describe('deterministic handoff policy mapping (T-160)', () => {
  it('maps exact deterministic clauses and preserves contract identity', () => {
    const result = compileFencedContractToDeterministicPolicyBundle({
      contract: contract(),
      compilerId: 'deterministic-policy',
      compilerVersion: '0.1.0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected deterministic policy compile success');

    expect(DeterministicPolicyBundleSchema.parse(result.bundle)).toEqual(result.bundle);
    expect(result.bundle.contractHash).toBe(contract().contractHash);
    expect(result.bundle.policyAuthority).toBe(DETERMINISTIC_POLICY_AUTHORITY);
    expect(result.bundle.deterministicPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clauseId: 'boundary.paths',
        policyKind: 'path_scope',
        values: ['src/reconcile/**'],
      }),
      expect.objectContaining({
        clauseId: 'tool.deny',
        policyKind: 'deny_tool_intent',
        values: ['trade.execute', 'net.egress'],
      }),
      expect.objectContaining({
        clauseId: 'evidence.audit',
        policyKind: 'required_evidence',
        values: ['audit_log'],
      }),
    ]));
  });

  it('leaves semantic and free-text clauses advisory', () => {
    const result = compileFencedContractToDeterministicPolicyBundle({
      contract: contract(),
      compilerId: 'deterministic-policy',
      compilerVersion: '0.1.0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected deterministic policy compile success');
    expect(result.bundle.advisoryClauseMap).toEqual(expect.arrayContaining([
      expect.objectContaining({ clauseId: 'goal.primary', clauseType: 'goal' }),
      expect.objectContaining({ clauseId: 'domain.deny', clauseType: 'domain_denylist' }),
    ]));
  });

  it('rejects duplicate policy ids and non-canonical hashes', () => {
    const result = compileFencedContractToDeterministicPolicyBundle({
      contract: contract(),
      compilerId: 'deterministic-policy',
      compilerVersion: '0.1.0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected deterministic policy compile success');

    const [first] = result.bundle.deterministicPolicies;
    if (!first) throw new Error('fixture must produce policy');
    expect(DeterministicPolicyBundleSchema.safeParse({
      ...result.bundle,
      deterministicPolicies: [...result.bundle.deterministicPolicies, first],
    }).success).toBe(false);

    expect(DeterministicPolicyBundleSchema.safeParse({
      ...result.bundle,
      policyBundleHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    }).success).toBe(false);
  });
});
