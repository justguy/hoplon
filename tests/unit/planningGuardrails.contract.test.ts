import { describe, expect, it } from 'vitest';

import {
  FENCED_CONTRACT_SCHEMA_VERSIONS,
  FencedContractBodySchema,
  FencedContractClauseSchema,
  FencedContractDiagnosticSchema,
  FencedContractSchema,
  hashFencedContract,
  parseFencedContract,
  type FencedContract,
  type FencedContractBody,
  type FencedContractClause,
  type FencedContractDiagnostic,
} from '../../src/hoplon/contracts/planningGuardrails.js';
const SAMPLE_PROVENANCE = {
  semantixVersion: '0.1.0', authoredAt: '2026-05-03T12:00:00.000Z',
  authoredBy: 'semantix-author@example.com', sourceUri: 'urn:semantix:doc:t-155',
};
const SAMPLE_COMPILER = { compilerId: 'nemo', compilerVersion: '0.x' };
function clauses(): FencedContractClause[] {
  return [
    {
      clauseId: 'goal.primary', clauseType: 'goal', goalKind: 'primary',
      description: 'Land the FencedContract canonical artifact for T-155.',
    },
    {
      clauseId: 'boundary.paths', clauseType: 'boundary', boundaryKind: 'paths',
      values: ['src/hoplon/contracts/planningGuardrails.ts'],
      description: 'Edits restricted to the contracts module.',
    },
    {
      clauseId: 'domain.allow', clauseType: 'domain_allowlist', domains: ['semantix.internal'],
      description: 'Planner may consult the internal Semantix doc store.',
    },
    {
      clauseId: 'domain.deny', clauseType: 'domain_denylist', domains: ['public.openai.com'],
      description: 'Planner must not call public LLM gateways.',
    },
    {
      clauseId: 'tool.allow', clauseType: 'tool_intent_allowlist',
      toolIntents: ['fs.read', 'search.symbol'],
      description: 'Allowed: filesystem read, structural search.',
    },
    {
      clauseId: 'tool.deny', clauseType: 'tool_intent_denylist',
      toolIntents: ['shell.exec', 'net.egress'],
      description: 'Forbidden: shell exec, network egress.',
    },
    {
      clauseId: 'success.tests', clauseType: 'success_criterion',
      criterionKind: 'test_passes', expression: 'tests/unit/planningGuardrails.contract.test.ts',
      description: 'Targeted vitest run passes on the new contract test.',
    },
    {
      clauseId: 'evidence.audit', clauseType: 'evidence_requirement',
      evidenceKind: 'audit_log', mandatory: true,
      description: 'Audit log must capture parse/hash events.',
    },
  ];
}
function makeBody(overrides: Partial<FencedContractBody> = {}): FencedContractBody {
  return {
    schemaVersion: FENCED_CONTRACT_SCHEMA_VERSIONS[0],
    contractId: 'fenced-contract.t-155.fixture',
    provenance: SAMPLE_PROVENANCE,
    compilerCompatibility: [SAMPLE_COMPILER],
    clauses: clauses(),
    ...overrides,
  };
}
function makeContract(overrides: Partial<FencedContractBody> = {}): FencedContract {
  const body = makeBody(overrides);
  return { ...body, contractHash: hashFencedContract(body) };
}
describe('FencedContract clause taxonomy (T-155)', () => {
  it('accepts every clause variant in the union', () => {
    for (const clause of clauses()) {
      expect(FencedContractClauseSchema.parse(clause)).toEqual(clause);
    }
  });

  it('rejects an unknown clauseType discriminator', () => {
    expect(
      FencedContractClauseSchema.safeParse({
        clauseId: 'bogus',
        clauseType: 'mystery',
        description: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects empty domain or tool-intent lists', () => {
    const emptyListClauses = [
      {
        clauseId: 'domain.allow', clauseType: 'domain_allowlist', description: 'x', domains: [],
      },
      {
        clauseId: 'domain.deny', clauseType: 'domain_denylist', description: 'x', domains: [],
      },
      {
        clauseId: 'tool.allow', clauseType: 'tool_intent_allowlist', description: 'x', toolIntents: [],
      },
      {
        clauseId: 'tool.deny', clauseType: 'tool_intent_denylist', description: 'x', toolIntents: [],
      },
    ];
    for (const clause of emptyListClauses) {
      expect(FencedContractClauseSchema.safeParse(clause).success).toBe(false);
    }
  });

  it('rejects a clauseId that does not match the stable id regex', () => {
    expect(
      FencedContractClauseSchema.safeParse({
        clauseId: '1leading-digit',
        clauseType: 'goal',
        description: 'x',
        goalKind: 'primary',
      }).success,
    ).toBe(false);
  });
});

describe('FencedContract identity and hash (T-155)', () => {
  it('hashes deterministically regardless of key order', () => {
    const a = makeBody();
    const reordered: FencedContractBody = {
      clauses: a.clauses,
      compilerCompatibility: a.compilerCompatibility,
      contractId: a.contractId,
      provenance: a.provenance,
      schemaVersion: a.schemaVersion,
    };
    expect(hashFencedContract(a)).toBe(hashFencedContract(reordered));
  });

  it('produces a different hash for any meaningful change', () => {
    const base = hashFencedContract(makeBody());
    const altered = hashFencedContract(makeBody({ contractId: 'fenced-contract.t-155.other' }));
    expect(altered).not.toBe(base);
  });

  it('emits a sha256:<64-hex> hash that the FencedContract regex accepts', () => {
    const contract = makeContract();
    expect(contract.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(FencedContractSchema.safeParse(contract).success).toBe(true);
  });

  it('does not include a supplied contractHash when hashing the body', () => {
    const body = makeBody();
    const bodyWithHash = {
      ...body,
      contractHash:
        'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    } as unknown as FencedContractBody;
    expect(hashFencedContract(bodyWithHash)).toBe(hashFencedContract(body));
  });
});

describe('FencedContract exported schemas enforce parser invariants (T-155)', () => {
  it('rejects an empty clause corpus through the body and full schemas', () => {
    const body = makeBody({ clauses: [] });
    expect(FencedContractBodySchema.safeParse(body).success).toBe(false);
    expect(FencedContractSchema.safeParse({
      ...body,
      contractHash: hashFencedContract(makeBody()),
    }).success).toBe(false);
  });

  it('rejects duplicate clauseIds through the body and full schemas', () => {
    const dup = clauses();
    const [first, second, ...rest] = dup;
    if (!first || !second) throw new Error('fixture must produce at least two clauses');
    const body = makeBody({
      clauses: [first, { ...second, clauseId: first.clauseId }, ...rest],
    });
    expect(FencedContractBodySchema.safeParse(body).success).toBe(false);
    expect(FencedContractSchema.safeParse({
      ...body,
      contractHash: hashFencedContract(makeBody()),
    }).success).toBe(false);
  });

  it('rejects a full contract whose supplied hash is only format-valid', () => {
    const body = makeBody();
    expect(FencedContractSchema.safeParse({
      ...body,
      contractHash:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    }).success).toBe(false);
  });
});

describe('parseFencedContract validates the canonical fixture corpus (T-155)', () => {
  it('accepts a valid contract without contractHash and returns the canonical hash', () => {
    const body = makeBody();
    const result = parseFencedContract(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contractHash).toBe(hashFencedContract(body));
      expect(result.contract).toEqual({ ...body, contractHash: result.contractHash });
    }
  });

  it('accepts a valid contract with a matching supplied contractHash', () => {
    const contract = makeContract();
    const result = parseFencedContract(contract);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contractHash).toBe(contract.contractHash);
  });
});

describe('parseFencedContract fails closed on invalid input (T-155)', () => {
  function expectDiagnostic(
    diagnostics: FencedContractDiagnostic[] | undefined,
    kind: FencedContractDiagnostic['kind'],
  ): void {
    expect(diagnostics).toBeDefined();
    for (const diag of diagnostics ?? []) {
      expect(FencedContractDiagnosticSchema.parse(diag)).toEqual(diag);
    }
    expect(diagnostics?.some((d) => d.kind === kind)).toBe(true);
  }

  it('rejects an unsupported schemaVersion with a typed diagnostic', () => {
    const result = parseFencedContract({
      ...makeBody(),
      schemaVersion: 'hoplon.fenced-contract/v999',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'unsupported_schema_version');
      expect(result.diagnostics[0]?.actual).toBe('hoplon.fenced-contract/v999');
    }
  });

  it('rejects schema-invalid input (missing required fields)', () => {
    const result = parseFencedContract({ contractId: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
  });

  it('rejects prose-only Semantix output (no clauses)', () => {
    const result = parseFencedContract(makeBody({ clauses: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'prose_only');
  });

  it('rejects duplicate clauseIds with a typed diagnostic', () => {
    const dup = clauses();
    const [first, second, ...rest] = dup;
    if (!first || !second) throw new Error('fixture must produce at least two clauses');
    const collided: FencedContractClause = { ...second, clauseId: first.clauseId };
    const result = parseFencedContract(makeBody({ clauses: [first, collided, ...rest] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'duplicate_clause_id');
      expect(result.diagnostics[0]?.path).toEqual(['clauses', 1, 'clauseId']);
    }
  });

  it('rejects a supplied contractHash that does not match the canonical hash', () => {
    const body = makeBody();
    const tampered = {
      ...body,
      contractHash:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };
    const result = parseFencedContract(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'hash_mismatch');
      expect(result.diagnostics[0]?.expected).toBe(hashFencedContract(body));
    }
  });

  it('fails closed on non-object input rather than throwing', () => {
    for (const input of [null, undefined, 42, 'prose-only-string', []]) {
      const result = parseFencedContract(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
    }
  });

  it('fails closed on hostile objects rather than throwing', () => {
    const hostile = new Proxy<Record<string, unknown>>({}, {
      get() {
        throw new Error('proxy get trap');
      },
      getOwnPropertyDescriptor() {
        throw new Error('proxy descriptor trap');
      },
    });
    const result = parseFencedContract(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
  });
});
