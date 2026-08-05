/**
 * contracts/verificationIntelligence.ts — t-104 advisory verification
 * semantic-gap sidecar.
 *
 * This sidecar is derived only from Hoplon-mediated verification DTOs:
 * `changedFiles`, `getRelevantTests` selection output, runner counts, and
 * failing-test identities. It never reads source files, never runs tests, and
 * never changes deterministic PASS/BLOCK or behavior-verification outcomes.
 */

import { z } from 'zod';

import type { VerifyBehaviorResult } from './verifyBehavior.js';
import {
  AdvisoryIntelligenceSidecarEnvelopeSchema,
  createAdvisoryIntelligenceAuthority,
  createStrictAgentIntelligenceAccess,
} from './advisoryIntelligence.js';
import { deriveVerificationEvidenceState } from './verificationEvidence.js';
import type {
  AdvisoryIntelligenceProviderState,
  AdvisoryIntelligenceSidecarEnvelope,
} from './advisoryIntelligence.js';

export const VERIFICATION_SEMANTIC_GAP_OBSERVATIONS = [
  'behavior_failed',
  'behavior_passed',
  'behavior_not_run',
  'runner_degraded',
  'oracle_unavailable',
  'conservative_coverage',
  'selection_override',
  'full_suite_fallback',
  'changed_files_without_oracle_match',
  'failing_tests_without_file',
] as const;
export const VerificationSemanticGapObservationSchema = z.enum(
  VERIFICATION_SEMANTIC_GAP_OBSERVATIONS,
);
export type VerificationSemanticGapObservation = z.infer<
  typeof VerificationSemanticGapObservationSchema
>;

export const VerificationSemanticGapChangedFileSubjectSchema = z.object({
  kind: z.literal('file'),
  path: z.string().min(1),
  origin: z.literal('verify_behavior_linkage'),
});
export const VerificationSemanticGapChangedSymbolSubjectSchema = z.object({
  kind: z.literal('symbol'),
  path: z.string().min(1),
  symbolName: z.string().min(1),
  symbolKind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  origin: z.literal('verify_behavior_linkage'),
});
export const VerificationSemanticGapChangedSubjectSchema = z.discriminatedUnion(
  'kind',
  [
    VerificationSemanticGapChangedFileSubjectSchema,
    VerificationSemanticGapChangedSymbolSubjectSchema,
  ],
);
export type VerificationSemanticGapChangedSubject = z.infer<
  typeof VerificationSemanticGapChangedSubjectSchema
>;

export const VerificationSemanticGapFailingTestSchema = z.object({
  testId: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1).nullable(),
  hasFailureMessage: z.boolean(),
  hasStack: z.boolean(),
  assertionCount: z.number().int().nonnegative().nullable(),
});
export type VerificationSemanticGapFailingTest = z.infer<
  typeof VerificationSemanticGapFailingTestSchema
>;

export const VerificationSemanticGapPayloadSchema = z.object({
  semanticGapSchemaVersion: z.literal(1),
  behavior: z.object({
    status: z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']),
    outcome: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
    unavailabilityReason: z.string().min(1).nullable(),
    failingTestCount: z.number().int().nonnegative(),
    passingTestCount: z.number().int().nonnegative(),
    skippedTestCount: z.number().int().nonnegative(),
  }),
  linkage: z.object({
    changedFiles: z.array(z.string().min(1)),
    attemptNumber: z.number().int().positive().nullable(),
    snapshotRefId: z.string().min(1).nullable(),
  }),
  mutatedSubjects: z.array(VerificationSemanticGapChangedSubjectSchema),
  relevantTests: z.object({
    strategy: z.enum([
      'oracle',
      'override',
      'full_suite_fallback',
      'none',
    ]),
    coverageConfidence: z.enum([
      'exact',
      'conservative',
      'override',
      'full_suite',
      'not_applicable',
    ]),
    modifiedFilesSource: z.enum([
      'session_changed_files',
      'caller_supplied',
      'none',
    ]),
    testsExecuted: z.array(z.string().min(1)),
    oracleRelevantTests: z.array(z.string().min(1)),
    oracleUnusedModifiedFiles: z.array(z.string().min(1)),
  }),
  failingTests: z.array(VerificationSemanticGapFailingTestSchema),
  observations: z.array(VerificationSemanticGapObservationSchema),
});
export type VerificationSemanticGapPayload = z.infer<
  typeof VerificationSemanticGapPayloadSchema
>;

export const VerificationSemanticGapSidecarSchema =
  AdvisoryIntelligenceSidecarEnvelopeSchema.extend({
    surface: z.literal('verification'),
    sidecarKind: z.literal('verification_semantic_gap'),
    payload: VerificationSemanticGapPayloadSchema,
  });
export type VerificationSemanticGapSidecar =
  AdvisoryIntelligenceSidecarEnvelope & {
    surface: 'verification';
    sidecarKind: 'verification_semantic_gap';
    payload: VerificationSemanticGapPayload;
  };

export function composeVerificationSemanticGapSidecar(input: {
  readonly verification: VerifyBehaviorResult;
  readonly includeSemanticGapIntelligence?: boolean | undefined;
}): VerificationSemanticGapSidecar | null {
  if (input.includeSemanticGapIntelligence !== true) return null;

  const payload = buildPayload(input.verification);
  return {
    version: 1,
    advisory: true,
    surface: 'verification',
    sidecarKind: 'verification_semantic_gap',
    provider: deriveProviderState(input.verification),
    evidence: deriveVerificationEvidenceState(input.verification),
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
    payload,
  };
}

function buildPayload(
  verification: VerifyBehaviorResult,
): VerificationSemanticGapPayload {
  const oracle = verification.selection.oracleResult;
  const failingTests = verification.evidence.failingTests.map((test) => ({
    testId: test.testId,
    name: test.name,
    file: test.file,
    hasFailureMessage: test.failureMessage.length > 0,
    hasStack: test.stack !== null && test.stack.length > 0,
    assertionCount: test.assertions === null ? null : test.assertions.length,
  }));

  return {
    semanticGapSchemaVersion: 1,
    behavior: {
      status: verification.status,
      outcome: verification.outcome,
      unavailabilityReason: verification.unavailabilityReason,
      failingTestCount: verification.evidence.failingTests.length,
      passingTestCount: verification.evidence.passingTestCount,
      skippedTestCount: verification.evidence.skippedTestCount,
    },
    linkage: {
      changedFiles: [...verification.linkage.changedFiles],
      attemptNumber: verification.linkage.attemptNumber,
      snapshotRefId: verification.linkage.snapshotRefId,
    },
    mutatedSubjects: verification.linkage.changedFiles.map(
      (path): VerificationSemanticGapChangedSubject => ({
        kind: 'file',
        path,
        origin: 'verify_behavior_linkage',
      }),
    ),
    relevantTests: {
      strategy: verification.selection.strategy,
      coverageConfidence: verification.selection.coverageConfidence,
      modifiedFilesSource: verification.selection.modifiedFilesSource,
      testsExecuted: [...verification.selection.testsExecuted],
      oracleRelevantTests: oracle === null ? [] : [...oracle.relevantTests],
      oracleUnusedModifiedFiles:
        oracle === null ? [] : [...oracle.unusedModifiedFiles],
    },
    failingTests,
    observations: deriveObservations(verification, failingTests),
  };
}

function deriveProviderState(
  verification: VerifyBehaviorResult,
): AdvisoryIntelligenceProviderState {
  if (verification.selection.oracleResult === null) {
    return {
      providerId: 'hoplon-verification-linkage',
      status: 'degraded',
      reason: 'oracle_unavailable',
      detail: verification.unavailabilityReason,
    };
  }
  if (verification.outcome === 'NOT_RUN') {
    return {
      providerId: 'hoplon-verification-linkage',
      status: 'degraded',
      reason: 'behavior_not_run',
      detail: verification.unavailabilityReason,
    };
  }
  if (verification.selection.coverageConfidence === 'conservative') {
    return {
      providerId: 'hoplon-verification-linkage',
      status: 'degraded',
      reason: 'conservative_coverage',
      detail: null,
    };
  }
  return {
    providerId: 'hoplon-verification-linkage',
    status: 'available',
    reason: null,
    detail: null,
  };
}

function deriveObservations(
  verification: VerifyBehaviorResult,
  failingTests: readonly VerificationSemanticGapFailingTest[],
): VerificationSemanticGapObservation[] {
  const observations = new Set<VerificationSemanticGapObservation>();
  if (verification.outcome === 'FAIL') observations.add('behavior_failed');
  if (verification.outcome === 'PASS') observations.add('behavior_passed');
  if (verification.outcome === 'NOT_RUN') observations.add('behavior_not_run');
  if (verification.status === 'DEGRADED') observations.add('runner_degraded');
  if (verification.selection.oracleResult === null) {
    observations.add('oracle_unavailable');
  }
  if (verification.selection.coverageConfidence === 'conservative') {
    observations.add('conservative_coverage');
  }
  if (verification.selection.strategy === 'override') {
    observations.add('selection_override');
  }
  if (verification.selection.strategy === 'full_suite_fallback') {
    observations.add('full_suite_fallback');
  }
  if (
    (verification.selection.oracleResult?.unusedModifiedFiles.length ?? 0) > 0
  ) {
    observations.add('changed_files_without_oracle_match');
  }
  if (failingTests.some((test) => test.file === null)) {
    observations.add('failing_tests_without_file');
  }
  return [...observations].sort();
}
