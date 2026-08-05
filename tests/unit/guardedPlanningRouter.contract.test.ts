import { describe, expect, it } from 'vitest';

import {
  GUARDED_PLANNING_ROUTER_DIAGNOSTIC_KINDS,
  GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS,
  GuardedPlanningRouterProofSchema,
  parseGuardedPlanningRouterProof,
  type GuardedPlanningRouterProof,
  type PlanningTurnEvidence,
} from '../../src/hoplon/contracts/index.js';
import { VALID_HASH_B, makeBundle } from './planningGuardrailBundle.fixtures.js';

function turnEvidence(
  overrides: Partial<PlanningTurnEvidence> = {},
): PlanningTurnEvidence {
  const bundle = makeBundle();
  return {
    schemaVersion: 'hoplon.planning-turn-evidence/v1',
    contractHash: bundle.contractHash,
    guardrailBundleHash: bundle.bundleHash,
    plannerTurnId: 'turn-001',
    outcome: 'allow',
    correctionAttempt: 0,
    evidenceAuthority: 'advisory',
    ...overrides,
  };
}

function proof(overrides: Partial<GuardedPlanningRouterProof> = {}): GuardedPlanningRouterProof {
  const bundle = makeBundle();
  const base = {
    schemaVersion: GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS[0],
    routerId: 'orchestrator.planning.router',
    guardedModelId: 'planner.guardrail-wrapped',
    contractHash: bundle.contractHash,
    guardrailBundleHash: bundle.bundleHash,
    plannerTurnId: 'turn-001',
    railRuntimeId: bundle.targetRuntime.runtimeId,
    evidenceAuthority: 'advisory' as const,
  };
  return {
    schemaVersion: GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS[0],
    request: {
      ...base,
      planningGuardrailBundle: bundle,
      requestRef: { refKind: 'model_request', ref: 'run/turn-001/request' },
    },
    result: {
      ...base,
      planningTurnEvidence: turnEvidence(),
      outputRef: { refKind: 'model_response', ref: 'run/turn-001/output' },
      telemetryRef: { refKind: 'telemetry', ref: 'run/turn-001/telemetry' },
    },
    staticImportProofRef: { refKind: 'telemetry', ref: 'proof/static-import-wall' },
    runtimeTelemetryProofRef: { refKind: 'telemetry', ref: 'proof/runtime-no-naked-llm' },
    evidenceAuthority: 'advisory',
    ...overrides,
  };
}

describe('GuardedPlanningRouter proof contract (T-158)', () => {
  it('exposes diagnostic constants and accepts a valid proof', () => {
    expect(GUARDED_PLANNING_ROUTER_DIAGNOSTIC_KINDS).toEqual([
      'request_invalid',
      'bundle_invalid',
      'hash_mismatch',
      'missing_runtime_identity',
      'evidence_invalid',
      'router_proof_invalid',
    ]);
    const candidate = proof();
    expect(GuardedPlanningRouterProofSchema.parse(candidate)).toEqual(candidate);
    expect(parseGuardedPlanningRouterProof(candidate)).toEqual({
      ok: true,
      proof: candidate,
    });
  });

  it('requires explicit rail runtime and planner turn identities', () => {
    const missingRuntime = proof({
      request: { ...proof().request, railRuntimeId: '' },
    });
    const parsed = parseGuardedPlanningRouterProof(missingRuntime);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics.some((d) => (
        d.kind === 'missing_runtime_identity'
      ))).toBe(true);
    }

    expect(GuardedPlanningRouterProofSchema.safeParse(proof({
      result: { ...proof().result, plannerTurnId: '' },
    })).success).toBe(false);
  });

  it('fails typed when contract, bundle, or evidence hashes do not match', () => {
    const parsed = parseGuardedPlanningRouterProof(proof({
      result: {
        ...proof().result,
        planningTurnEvidence: turnEvidence({ guardrailBundleHash: VALID_HASH_B }),
      },
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics.some((d) => d.kind === 'hash_mismatch')).toBe(true);
    }
  });

  it('rejects raw prompt, model response, and reasoning smuggling', () => {
    for (const key of ['prompt', 'modelResponse', 'reasoningTrace']) {
      expect(GuardedPlanningRouterProofSchema.safeParse({
        ...proof(),
        [key]: 'raw hidden material',
      }).success).toBe(false);
    }
  });

  it('keeps all router evidence advisory even for block outcomes', () => {
    const blocked = proof({
      result: {
        ...proof().result,
        planningTurnEvidence: turnEvidence({
          outcome: 'block',
          railId: 'rail.tool.shell',
          clauseId: 'tool.deny',
        }),
      },
    });
    expect(GuardedPlanningRouterProofSchema.parse(blocked).evidenceAuthority)
      .toBe('advisory');
  });
});
