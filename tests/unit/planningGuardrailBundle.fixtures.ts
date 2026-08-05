import {
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
  hashPlanningGuardrailBundle,
  type PlanningGuardrailBundle,
  type PlanningGuardrailBundleBody,
  type PlanningGuardrailClauseRailMapping,
  type PlanningGuardrailGeneratedConfig,
} from '../../src/hoplon/contracts/planningGuardrailBundle.js';

export const VALID_HASH_A =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';
export const VALID_HASH_B =
  'sha256:2222222222222222222222222222222222222222222222222222222222222222';

export function bundleConfigs(): PlanningGuardrailGeneratedConfig[] {
  return [
    { configKind: 'rails_config', configRef: 'rails/main.yaml', configHash: VALID_HASH_A },
    { configKind: 'colang_flow', configRef: 'rails/flows.co', configHash: VALID_HASH_B },
  ];
}

export function bundleMappings(): PlanningGuardrailClauseRailMapping[] {
  return [
    { clauseId: 'goal.primary', railIds: ['rail.goal.primary'] },
    { clauseId: 'tool.deny', railIds: ['rail.tool.shell', 'rail.tool.net'] },
  ];
}

export function makeBundleBody(
  overrides: Partial<PlanningGuardrailBundleBody> = {},
): PlanningGuardrailBundleBody {
  return {
    schemaVersion: PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS[0],
    contractHash: VALID_HASH_A,
    compilerId: 'semantix-to-nemo',
    compilerVersion: '0.1.0',
    targetRuntime: { runtimeId: 'nemo-guardrails', runtimeVersion: '0.x' },
    generatedConfigs: bundleConfigs(),
    clauseToRailMap: bundleMappings(),
    enforcementMode: 'advisory',
    evidenceAuthority: PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
    ...overrides,
  };
}

export function makeBundle(
  overrides: Partial<PlanningGuardrailBundleBody> = {},
): PlanningGuardrailBundle {
  const body = makeBundleBody(overrides);
  return { ...body, bundleHash: hashPlanningGuardrailBundle(body) };
}
