import { describe, expect, it } from 'vitest';

import {
  PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM,
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  PLANNING_GUARDRAIL_ENFORCEMENT_MODES,
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
  PLANNING_GUARDRAIL_GENERATED_CONFIG_KINDS,
  PlanningGuardrailBundleBodySchema,
  PlanningGuardrailBundleSchema,
  hashPlanningGuardrailBundle,
  type PlanningGuardrailBundleBody,
  type PlanningGuardrailClauseRailMapping,
} from '../../src/hoplon/contracts/planningGuardrailBundle.js';
import {
  VALID_HASH_A,
  bundleMappings,
  makeBundle,
  makeBundleBody,
} from './planningGuardrailBundle.fixtures.js';

describe('PlanningGuardrailBundle schema (T-156)', () => {
  it('exposes the constants and authority literal expected by the contract', () => {
    expect(PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM).toBe('sha256');
    expect(PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY).toBe('advisory');
    expect(PLANNING_GUARDRAIL_ENFORCEMENT_MODES).toEqual(['advisory', 'block']);
    expect(PLANNING_GUARDRAIL_GENERATED_CONFIG_KINDS).toEqual([
      'rails_config', 'colang_flow', 'rail_action', 'auxiliary',
    ]);
    expect(PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS).toEqual([
      'hoplon.planning-guardrail-bundle/v1',
    ]);
  });

  it('accepts the canonical fixture body and full bundle', () => {
    const body = makeBundleBody();
    expect(PlanningGuardrailBundleBodySchema.parse(body)).toEqual(body);
    const bundle = makeBundle();
    expect(PlanningGuardrailBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it('accepts both advisory and block enforcement modes', () => {
    expect(PlanningGuardrailBundleSchema.safeParse(makeBundle({
      enforcementMode: 'block',
    })).success).toBe(true);
  });

  it('locks evidenceAuthority to the advisory literal', () => {
    const tampered = {
      ...makeBundle(),
      evidenceAuthority: 'block',
    } as unknown;
    expect(PlanningGuardrailBundleSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects unknown extra fields via strict()', () => {
    const withReasoning = {
      ...makeBundle(),
      reasoningTrace: 'should not be carried',
    } as unknown;
    expect(PlanningGuardrailBundleSchema.safeParse(withReasoning).success).toBe(false);
  });

  it('rejects empty generatedConfigs and clauseToRailMap', () => {
    expect(PlanningGuardrailBundleBodySchema.safeParse(
      makeBundleBody({ generatedConfigs: [] }),
    ).success).toBe(false);
    expect(PlanningGuardrailBundleBodySchema.safeParse(
      makeBundleBody({ clauseToRailMap: [] }),
    ).success).toBe(false);
  });

  it('rejects empty railIds within a single clause mapping', () => {
    expect(PlanningGuardrailBundleBodySchema.safeParse(makeBundleBody({
      clauseToRailMap: [{ clauseId: 'goal.primary', railIds: [] }],
    })).success).toBe(false);
  });

  it('rejects malformed contract/configHash values', () => {
    expect(PlanningGuardrailBundleBodySchema.safeParse(
      makeBundleBody({ contractHash: 'not-a-hash' }),
    ).success).toBe(false);
    expect(PlanningGuardrailBundleBodySchema.safeParse(makeBundleBody({
      generatedConfigs: [{
        configKind: 'rails_config', configRef: 'rails.yaml', configHash: 'not-a-hash',
      }],
    })).success).toBe(false);
  });
});

describe('PlanningGuardrailBundle identity hash (T-156)', () => {
  it('hashes deterministically regardless of key order', () => {
    const a = makeBundleBody();
    const reordered: PlanningGuardrailBundleBody = {
      generatedConfigs: a.generatedConfigs,
      clauseToRailMap: a.clauseToRailMap,
      compilerId: a.compilerId,
      compilerVersion: a.compilerVersion,
      contractHash: a.contractHash,
      enforcementMode: a.enforcementMode,
      evidenceAuthority: a.evidenceAuthority,
      schemaVersion: a.schemaVersion,
      targetRuntime: a.targetRuntime,
    };
    expect(hashPlanningGuardrailBundle(a)).toBe(hashPlanningGuardrailBundle(reordered));
  });

  it('produces a different hash for any meaningful body change', () => {
    const base = hashPlanningGuardrailBundle(makeBundleBody());
    const altered = hashPlanningGuardrailBundle(makeBundleBody({ compilerVersion: '0.2.0' }));
    expect(altered).not.toBe(base);
  });

  it('emits a sha256:<64-hex> hash that the bundle schema accepts', () => {
    const bundle = makeBundle();
    expect(bundle.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PlanningGuardrailBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('does not include a supplied bundleHash when hashing the body', () => {
    const body = makeBundleBody();
    const bodyWithHash = {
      ...body,
      bundleHash: VALID_HASH_A,
    } as unknown as PlanningGuardrailBundleBody;
    expect(hashPlanningGuardrailBundle(bodyWithHash)).toBe(hashPlanningGuardrailBundle(body));
  });

  it('rejects format-valid but non-canonical supplied bundleHash through the full schema', () => {
    const body = makeBundleBody();
    expect(PlanningGuardrailBundleSchema.safeParse({
      ...body,
      bundleHash: VALID_HASH_A,
    }).success).toBe(false);
  });
});

describe('PlanningGuardrailBundle duplicate detection (T-156)', () => {
  it('rejects duplicate clauseIds across the rail map (body and full schema)', () => {
    const [first] = bundleMappings();
    if (!first) throw new Error('fixture must produce at least one mapping');
    const dup: PlanningGuardrailClauseRailMapping[] = [
      first,
      { clauseId: first.clauseId, railIds: ['rail.other'] },
    ];
    const body = makeBundleBody({ clauseToRailMap: dup });
    expect(PlanningGuardrailBundleBodySchema.safeParse(body).success).toBe(false);
    expect(PlanningGuardrailBundleSchema.safeParse({
      ...body, bundleHash: hashPlanningGuardrailBundle(makeBundleBody()),
    }).success).toBe(false);
  });

  it('rejects duplicate railIds within a single mapping', () => {
    const body = makeBundleBody({
      clauseToRailMap: [
        { clauseId: 'goal.primary', railIds: ['rail.dup', 'rail.dup'] },
      ],
    });
    expect(PlanningGuardrailBundleBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects duplicate configHash entries across generatedConfigs', () => {
    const body = makeBundleBody({
      generatedConfigs: [
        { configKind: 'rails_config', configRef: 'a.yaml', configHash: VALID_HASH_A },
        { configKind: 'colang_flow', configRef: 'b.co', configHash: VALID_HASH_A },
      ],
    });
    expect(PlanningGuardrailBundleBodySchema.safeParse(body).success).toBe(false);
  });
});
