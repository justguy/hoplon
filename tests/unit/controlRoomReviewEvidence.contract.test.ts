import { describe, expect, it } from 'vitest';

import {
  CONTROL_ROOM_REVIEW_EVIDENCE_SCHEMA_VERSIONS,
  ControlRoomReviewEvidenceAttachmentSchema,
  type ControlRoomReviewEvidenceAttachment,
  type PlanningTurnEvidence,
} from '../../src/hoplon/contracts/index.js';
import { makeBundle } from './planningGuardrailBundle.fixtures.js';

function evidence(
  outcome: PlanningTurnEvidence['outcome'],
  overrides: Partial<PlanningTurnEvidence> = {},
): PlanningTurnEvidence {
  const bundle = makeBundle();
  return {
    schemaVersion: 'hoplon.planning-turn-evidence/v1',
    contractHash: bundle.contractHash,
    guardrailBundleHash: bundle.bundleHash,
    plannerTurnId: `turn-${outcome}`,
    outcome,
    correctionAttempt: outcome === 'retry' ? 1 : 0,
    escalationReason: outcome === 'escalate' ? 'Human review required' : undefined,
    evidenceAuthority: 'advisory',
    ...overrides,
  };
}

function attachment(
  overrides: Partial<ControlRoomReviewEvidenceAttachment> = {},
): ControlRoomReviewEvidenceAttachment {
  const bundle = makeBundle();
  return {
    schemaVersion: CONTROL_ROOM_REVIEW_EVIDENCE_SCHEMA_VERSIONS[0],
    attachmentId: 'control-room-review.t-159',
    generatedAt: '2026-05-03T12:00:00.000Z',
    executionBlueprint: {
      blueprintId: 'blueprint-001',
      contractHash: bundle.contractHash,
      guardrailBundleHash: bundle.bundleHash,
      plannedActionRefs: ['action/ref-001'],
    },
    contractHash: bundle.contractHash,
    guardrailBundleHash: bundle.bundleHash,
    guardrailBundleIdentity: {
      compilerId: bundle.compilerId,
      compilerVersion: bundle.compilerVersion,
      targetRuntime: bundle.targetRuntime,
      generatedConfigs: bundle.generatedConfigs,
    },
    plannerTurnIds: ['turn-allow', 'turn-block', 'turn-retry', 'turn-escalate'],
    allowedPlanning: [{ evidence: evidence('allow'), summary: 'Within contract.' }],
    blockedDriftAttempts: [{
      evidence: evidence('block', { railId: 'rail.tool.shell', clauseId: 'tool.deny' }),
      summary: 'Drift attempt blocked by planning rail.',
    }],
    retries: [{ evidence: evidence('retry'), summary: 'Planner corrected once.' }],
    escalations: [{ evidence: evidence('escalate'), summary: 'Needs human review.' }],
    unresolvedWarnings: [{
      warningId: 'warning-001',
      clauseId: 'domain.deny',
      summary: 'Semantic warning remains advisory.',
      authority: 'semantic_advisory',
    }],
    deterministicHandoffPreview: {
      deterministicControlRefs: [{
        controlId: 'policy.deny_tool_intent.tool.deny',
        clauseId: 'tool.deny',
        summary: 'Deny exact tool intent in handoff preview.',
        authority: 'deterministic_preview',
      }],
      semanticAdvisoryRefs: [{
        controlId: 'semantic.domain.deny',
        clauseId: 'domain.deny',
        summary: 'Domain classification remains advisory.',
        authority: 'semantic_advisory',
      }],
    },
    requiresHumanApproval: true,
    evidenceAuthority: 'advisory',
    ...overrides,
  };
}

describe('Control Room review evidence attachment (T-159)', () => {
  it('parses a valid attachment with separated evidence buckets', () => {
    const parsed = ControlRoomReviewEvidenceAttachmentSchema.parse(attachment());
    expect(parsed.allowedPlanning[0]?.evidence.outcome).toBe('allow');
    expect(parsed.blockedDriftAttempts[0]?.evidence.outcome).toBe('block');
    expect(parsed.retries[0]?.evidence.outcome).toBe('retry');
    expect(parsed.escalations[0]?.evidence.outcome).toBe('escalate');
    expect(parsed.requiresHumanApproval).toBe(true);
    expect(parsed.evidenceAuthority).toBe('advisory');
  });

  it('rejects evidence placed in the wrong outcome bucket', () => {
    expect(ControlRoomReviewEvidenceAttachmentSchema.safeParse(attachment({
      blockedDriftAttempts: [{ evidence: evidence('allow'), summary: 'wrong bucket' }],
    })).success).toBe(false);
  });

  it('rejects raw hidden reasoning and prompt smuggling', () => {
    for (const key of ['reasoningTrace', 'prompt', 'modelResponse', 'apiKey']) {
      expect(ControlRoomReviewEvidenceAttachmentSchema.safeParse({
        ...attachment(),
        [key]: 'not allowed',
      }).success).toBe(false);
    }
  });

  it('requires blueprint hash linkage and keeps deterministic controls preview-only', () => {
    const broken = attachment({
      executionBlueprint: {
        ...attachment().executionBlueprint,
        contractHash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      },
    });
    expect(ControlRoomReviewEvidenceAttachmentSchema.safeParse(broken).success)
      .toBe(false);

    const preview = attachment().deterministicHandoffPreview.deterministicControlRefs[0];
    expect(preview?.authority).toBe('deterministic_preview');
  });
});
