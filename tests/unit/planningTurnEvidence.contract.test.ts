import { describe, expect, it } from 'vitest';

import {
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
} from '../../src/hoplon/contracts/planningGuardrailBundle.js';
import {
  PLANNING_TURN_EVIDENCE_SCHEMA_VERSIONS,
  PLANNING_TURN_OUTCOMES,
  PlanningTurnEvidenceSchema,
  PlanningTurnOutcomeSchema,
  type PlanningTurnEvidence,
  type PlanningTurnOutcome,
} from '../../src/hoplon/contracts/planningTurnEvidence.js';

const VALID_HASH_A =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const VALID_HASH_B =
  'sha256:2222222222222222222222222222222222222222222222222222222222222222';

function makeEvidence(
  overrides: Partial<PlanningTurnEvidence> = {},
): PlanningTurnEvidence {
  return {
    schemaVersion: PLANNING_TURN_EVIDENCE_SCHEMA_VERSIONS[0],
    contractHash: VALID_HASH_A,
    guardrailBundleHash: VALID_HASH_B,
    plannerTurnId: 'planner.session-1.turn-7',
    outcome: 'allow',
    correctionAttempt: 0,
    evidenceAuthority: PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
    ...overrides,
  };
}

describe('PlanningTurnEvidence schema (T-156)', () => {
  it('exposes the four-outcome closed enum', () => {
    expect(PLANNING_TURN_OUTCOMES).toEqual(['allow', 'block', 'retry', 'escalate']);
    for (const outcome of PLANNING_TURN_OUTCOMES) {
      expect(PlanningTurnOutcomeSchema.parse(outcome)).toBe(outcome);
    }
  });

  it('accepts every outcome on the canonical fixture', () => {
    for (const outcome of ['allow', 'block', 'retry'] satisfies PlanningTurnOutcome[]) {
      expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({ outcome })).success).toBe(true);
    }
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      outcome: 'escalate',
      escalationReason: 'unhandled rail signal',
    })).success).toBe(true);
  });

  it('locks evidenceAuthority to the advisory literal', () => {
    expect(PlanningTurnEvidenceSchema.safeParse({
      ...makeEvidence(),
      evidenceAuthority: 'block',
    }).success).toBe(false);
  });

  it('requires escalationReason when outcome is escalate', () => {
    const result = PlanningTurnEvidenceSchema.safeParse(makeEvidence({ outcome: 'escalate' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('escalationReason is required when outcome is escalate');
    }
  });

  it('rejects escalationReason on non-escalate outcomes', () => {
    const result = PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      outcome: 'allow',
      escalationReason: 'should not be here',
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('escalationReason is only permitted when outcome is escalate');
    }
  });

  it('accepts optional railId and clauseId pointers', () => {
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      outcome: 'block',
      railId: 'rail.tool.shell',
      clauseId: 'tool.deny',
    })).success).toBe(true);
  });

  it('rejects malformed railId or clauseId values', () => {
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      railId: '1leading-digit',
    })).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      clauseId: '1leading-digit',
    })).success).toBe(false);
  });

  it('requires correctionAttempt to be a non-negative integer', () => {
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({ correctionAttempt: -1 })).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({ correctionAttempt: 1.5 })).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({ correctionAttempt: 3 })).success).toBe(true);
  });

  it('rejects malformed contractHash and guardrailBundleHash values', () => {
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      contractHash: 'not-a-hash',
    })).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      guardrailBundleHash: 'not-a-hash',
    })).success).toBe(false);
  });

  it('rejects unsupported schemaVersion values', () => {
    expect(PlanningTurnEvidenceSchema.safeParse({
      ...makeEvidence(),
      schemaVersion: 'hoplon.planning-turn-evidence/v999',
    }).success).toBe(false);
  });

  it('rejects unknown extra fields via strict() — no reasoning trace smuggling', () => {
    const reasoningSmuggled = {
      ...makeEvidence(),
      reasoningTrace: 'stop-token: do nothing harmful',
    } as unknown;
    const promptSmuggled = {
      ...makeEvidence(),
      prompt: 'system-prompt body',
    } as unknown;
    const responseSmuggled = {
      ...makeEvidence(),
      modelResponse: 'final answer raw text',
    } as unknown;
    expect(PlanningTurnEvidenceSchema.safeParse(reasoningSmuggled).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(promptSmuggled).success).toBe(false);
    expect(PlanningTurnEvidenceSchema.safeParse(responseSmuggled).success).toBe(false);
  });

  it('imposes no maximum-length cap on agent-facing string fields', () => {
    const longText = 'x'.repeat(8192);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      plannerTurnId: longText,
    })).success).toBe(true);
    expect(PlanningTurnEvidenceSchema.safeParse(makeEvidence({
      outcome: 'escalate',
      escalationReason: longText,
    })).success).toBe(true);
  });
});
