import { describe, expect, it } from 'vitest';

import {
  FENCED_CONTRACT_SCHEMA_VERSIONS,
  PLANNING_GUARDRAIL_COMPILER_DIAGNOSTIC_KINDS,
  PLANNING_GUARDRAIL_COMPILER_ID,
  PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES,
  PlanningGuardrailBundleSchema,
  PlanningGuardrailCompilerDiagnosticSchema,
  compileFencedContractToPlanningGuardrailBundle,
  hashFencedContract,
  parsePlanningGuardrailBundle,
  type FencedContract,
  type FencedContractBody,
  type FencedContractClause,
  type PlanningGuardrailCompilerDiagnostic,
  type PlanningGuardrailCompilerRequest,
} from '../../src/hoplon/contracts/index.js';

const COMPILER_VERSION = '0.1.0';

function supportedClauses(): FencedContractClause[] {
  return [
    {
      clauseId: 'goal.primary',
      clauseType: 'goal',
      goalKind: 'primary',
      description: 'Keep planning inside the approved repair objective.',
    },
    {
      clauseId: 'domain.allow',
      clauseType: 'domain_allowlist',
      domains: ['internal.example'],
      description: 'Planner may use the internal design corpus.',
    },
    {
      clauseId: 'domain.deny',
      clauseType: 'domain_denylist',
      domains: ['public-llm.example'],
      description: 'Planner must not call public LLM gateways.',
    },
    {
      clauseId: 'tool.allow',
      clauseType: 'tool_intent_allowlist',
      toolIntents: ['fs.read', 'search.symbol'],
      description: 'Planning may inspect source and symbols.',
    },
    {
      clauseId: 'tool.deny',
      clauseType: 'tool_intent_denylist',
      toolIntents: ['shell.exec', 'net.egress'],
      description: 'Planning must not mutate files or reach the network.',
    },
  ];
}

function body(overrides: Partial<FencedContractBody> = {}): FencedContractBody {
  return {
    schemaVersion: FENCED_CONTRACT_SCHEMA_VERSIONS[0],
    contractId: 'fenced-contract.t-157.fixture',
    provenance: {
      semantixVersion: '0.1.0',
      authoredAt: '2026-05-03T12:00:00.000Z',
      authoredBy: 'semantix-author@example.com',
    },
    compilerCompatibility: [{
      compilerId: PLANNING_GUARDRAIL_COMPILER_ID,
      compilerVersion: COMPILER_VERSION,
    }],
    clauses: supportedClauses(),
    ...overrides,
  };
}

function contract(overrides: Partial<FencedContractBody> = {}): FencedContract {
  const contractBody = body(overrides);
  return {
    ...contractBody,
    contractHash: hashFencedContract(contractBody),
  };
}

function request(
  overrides: Partial<PlanningGuardrailCompilerRequest> = {},
): PlanningGuardrailCompilerRequest {
  return {
    contract: contract(),
    compilerId: PLANNING_GUARDRAIL_COMPILER_ID,
    compilerVersion: COMPILER_VERSION,
    targetRuntime: {
      runtimeId: 'nemo-guardrails',
      runtimeVersion: '0.x',
    },
    enforcementMode: 'advisory',
    configRefPrefix: 'generated/t-157',
    ...overrides,
  };
}

function expectDiagnostic(
  diagnostics: PlanningGuardrailCompilerDiagnostic[] | undefined,
  kind: PlanningGuardrailCompilerDiagnostic['kind'],
): void {
  expect(diagnostics).toBeDefined();
  for (const diagnostic of diagnostics ?? []) {
    expect(PlanningGuardrailCompilerDiagnosticSchema.parse(diagnostic))
      .toEqual(diagnostic);
  }
  expect(diagnostics?.some((diagnostic) => diagnostic.kind === kind)).toBe(true);
}

describe('PlanningGuardrail compiler contract (T-157)', () => {
  it('exposes closed compiler constants', () => {
    expect(PLANNING_GUARDRAIL_COMPILER_ID).toBe('semantix-to-nemo');
    expect(PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES).toEqual([
      'goal',
      'domain_allowlist',
      'domain_denylist',
      'tool_intent_allowlist',
      'tool_intent_denylist',
    ]);
    expect(PLANNING_GUARDRAIL_COMPILER_DIAGNOSTIC_KINDS).toEqual([
      'request_invalid',
      'contract_invalid',
      'compiler_incompatible',
      'unsupported_clause_type',
      'bundle_invalid',
    ]);
  });

  it('compiles a supported FencedContract into a canonical bundle', () => {
    const result = compileFencedContractToPlanningGuardrailBundle(request());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected compile success');

    expect(PlanningGuardrailBundleSchema.parse(result.bundle)).toEqual(result.bundle);
    expect(parsePlanningGuardrailBundle(result.bundle).ok).toBe(true);
    expect(result.bundle.contractHash).toBe((request().contract as FencedContract).contractHash);
    expect(result.bundle.bundleHash).toBe(result.bundleHash);
    expect(result.bundle.evidenceAuthority).toBe('advisory');
    expect(result.bundle.generatedConfigs).toEqual(
      result.generatedArtifacts.map((artifact) => ({
        configKind: artifact.configKind,
        configRef: artifact.configRef,
        configHash: artifact.configHash,
      })),
    );
    expect(result.bundle.clauseToRailMap).toEqual([
      { clauseId: 'goal.primary', railIds: ['rail.goal.goal.primary'] },
      { clauseId: 'domain.allow', railIds: ['rail.domain_allowlist.domain.allow'] },
      { clauseId: 'domain.deny', railIds: ['rail.domain_denylist.domain.deny'] },
      { clauseId: 'tool.allow', railIds: ['rail.tool_intent_allowlist.tool.allow'] },
      { clauseId: 'tool.deny', railIds: ['rail.tool_intent_denylist.tool.deny'] },
    ]);
  });

  it('keeps generated artifact content outside bundle identity', () => {
    const result = compileFencedContractToPlanningGuardrailBundle(request());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected compile success');

    expect(result.generatedArtifacts).toHaveLength(2);
    for (const artifact of result.generatedArtifacts) {
      expect(artifact.content.length).toBeGreaterThan(0);
      expect(artifact.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.bundle).not.toHaveProperty('content');
    }
  });

  it('emits stable output for equivalent contracts', () => {
    const first = compileFencedContractToPlanningGuardrailBundle(request());
    const reorderedBody: FencedContractBody = {
      clauses: supportedClauses(),
      compilerCompatibility: body().compilerCompatibility,
      contractId: body().contractId,
      provenance: body().provenance,
      schemaVersion: body().schemaVersion,
    };
    const second = compileFencedContractToPlanningGuardrailBundle(request({
      contract: { ...reorderedBody, contractHash: hashFencedContract(reorderedBody) },
    }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.bundle).toEqual(second.bundle);
      expect(first.generatedArtifacts).toEqual(second.generatedArtifacts);
    }
  });

  it('reports contract_invalid when the FencedContract parser rejects input', () => {
    const result = compileFencedContractToPlanningGuardrailBundle(request({
      contract: { contractId: 'missing required fields' },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'contract_invalid');
      expect(result.diagnostics[0]?.upstreamKind).toBe('schema_invalid');
    }
  });

  it('reports compiler_incompatible when compilerCompatibility omits the compiler', () => {
    const result = compileFencedContractToPlanningGuardrailBundle(request({
      compilerVersion: '9.9.9',
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'compiler_incompatible');
  });

  it('reports unsupported_clause_type instead of silently dropping unsupported clauses', () => {
    const unsupported: FencedContractClause = {
      clauseId: 'boundary.paths',
      clauseType: 'boundary',
      boundaryKind: 'paths',
      values: ['src/hoplon/contracts/planningGuardrailCompiler.ts'],
      description: 'Execution path scope is deterministic policy, not a planning rail.',
    };
    const result = compileFencedContractToPlanningGuardrailBundle(request({
      contract: contract({ clauses: [...supportedClauses(), unsupported] }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'unsupported_clause_type');
      expect(result.diagnostics[0]?.clauseId).toBe('boundary.paths');
      expect(result.diagnostics[0]?.clauseType).toBe('boundary');
    }
  });

  it('reports request_invalid for malformed compiler requests', () => {
    const result = compileFencedContractToPlanningGuardrailBundle({
      ...request(),
      configRefPrefix: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'request_invalid');
  });
});
