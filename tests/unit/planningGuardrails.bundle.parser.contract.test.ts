import { describe, expect, it } from 'vitest';

import {
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  hashPlanningGuardrailBundle,
  type PlanningGuardrailClauseRailMapping,
} from '../../src/hoplon/contracts/planningGuardrailBundle.js';
import {
  PLANNING_GUARDRAIL_BUNDLE_DIAGNOSTIC_KINDS,
  PlanningGuardrailBundleDiagnosticSchema,
  parsePlanningGuardrailBundle,
  type PlanningGuardrailBundleDiagnostic,
} from '../../src/hoplon/contracts/planningGuardrailBundleParser.js';
import {
  VALID_HASH_A,
  bundleMappings,
  makeBundle,
  makeBundleBody,
} from './planningGuardrailBundle.fixtures.js';

function expectDiagnostic(
  diagnostics: PlanningGuardrailBundleDiagnostic[] | undefined,
  kind: PlanningGuardrailBundleDiagnostic['kind'],
): void {
  expect(diagnostics).toBeDefined();
  for (const diag of diagnostics ?? []) {
    expect(PlanningGuardrailBundleDiagnosticSchema.parse(diag)).toEqual(diag);
  }
  expect(diagnostics?.some((d) => d.kind === kind)).toBe(true);
}

describe('parsePlanningGuardrailBundle happy path (T-156)', () => {
  it('exposes the closed diagnostic-kind enum for downstream consumers', () => {
    expect(PLANNING_GUARDRAIL_BUNDLE_DIAGNOSTIC_KINDS).toEqual([
      'schema_invalid',
      'unsupported_schema_version',
      'duplicate_clause_id',
      'duplicate_rail_id',
      'duplicate_config_hash',
      'hash_mismatch',
    ]);
  });

  it('accepts a body without bundleHash and returns the canonical hash', () => {
    const body = makeBundleBody();
    const result = parsePlanningGuardrailBundle(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundleHash).toBe(hashPlanningGuardrailBundle(body));
      expect(result.bundle).toEqual({ ...body, bundleHash: result.bundleHash });
    }
  });

  it('accepts a bundle whose supplied bundleHash already matches', () => {
    const bundle = makeBundle();
    const result = parsePlanningGuardrailBundle(bundle);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundleHash).toBe(bundle.bundleHash);
  });
});

describe('parsePlanningGuardrailBundle fails closed (T-156)', () => {
  it('rejects an unsupported schemaVersion with a typed diagnostic', () => {
    const result = parsePlanningGuardrailBundle({
      ...makeBundleBody(),
      schemaVersion: 'hoplon.planning-guardrail-bundle/v999',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'unsupported_schema_version');
      expect(result.diagnostics[0]?.actual).toBe('hoplon.planning-guardrail-bundle/v999');
    }
  });

  it('reports schema_invalid for missing required fields', () => {
    const result = parsePlanningGuardrailBundle({
      schemaVersion: PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS[0],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
  });

  it('reports duplicate_clause_id with the offending mapping path', () => {
    const [first] = bundleMappings();
    if (!first) throw new Error('fixture must produce at least one mapping');
    const dup: PlanningGuardrailClauseRailMapping[] = [
      first,
      { clauseId: first.clauseId, railIds: ['rail.other'] },
    ];
    const result = parsePlanningGuardrailBundle(makeBundleBody({ clauseToRailMap: dup }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'duplicate_clause_id');
      expect(result.diagnostics[0]?.path).toEqual(['clauseToRailMap', 1, 'clauseId']);
    }
  });

  it('reports duplicate_rail_id when a single mapping repeats a rail', () => {
    const result = parsePlanningGuardrailBundle(makeBundleBody({
      clauseToRailMap: [{ clauseId: 'goal.primary', railIds: ['rail.dup', 'rail.dup'] }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'duplicate_rail_id');
  });

  it('reports duplicate_config_hash when generatedConfigs share a hash', () => {
    const result = parsePlanningGuardrailBundle(makeBundleBody({
      generatedConfigs: [
        { configKind: 'rails_config', configRef: 'a.yaml', configHash: VALID_HASH_A },
        { configKind: 'colang_flow', configRef: 'b.co', configHash: VALID_HASH_A },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'duplicate_config_hash');
  });

  it('reports hash_mismatch when supplied bundleHash diverges from canonical', () => {
    const body = makeBundleBody();
    const result = parsePlanningGuardrailBundle({ ...body, bundleHash: VALID_HASH_A });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectDiagnostic(result.diagnostics, 'hash_mismatch');
      expect(result.diagnostics[0]?.expected).toBe(hashPlanningGuardrailBundle(body));
    }
  });

  it('fails closed on non-object input rather than throwing', () => {
    for (const input of [null, undefined, 42, 'prose', []]) {
      const result = parsePlanningGuardrailBundle(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
    }
  });

  it('fails closed on hostile proxies rather than throwing', () => {
    const hostile = new Proxy<Record<string, unknown>>({}, {
      get() { throw new Error('proxy get trap'); },
      getOwnPropertyDescriptor() { throw new Error('proxy descriptor trap'); },
    });
    const result = parsePlanningGuardrailBundle(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expectDiagnostic(result.diagnostics, 'schema_invalid');
  });
});
