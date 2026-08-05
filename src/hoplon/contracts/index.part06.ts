/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// VerifyBehavior (t-067 — host-facing behavior verification)
export {
  VERIFY_BEHAVIOR_STATUSES,
  VERIFY_BEHAVIOR_OUTCOMES,
  VERIFY_BEHAVIOR_SELECTION_STRATEGIES,
  VERIFY_BEHAVIOR_UNAVAILABILITY_REASONS,
  VERIFY_BEHAVIOR_EXIT_KINDS,
  VERIFY_BEHAVIOR_NOTES,
  VerifyBehaviorStatusSchema,
  VerifyBehaviorOutcomeSchema,
  VerifyBehaviorSelectionStrategySchema,
  VerifyBehaviorUnavailabilityReasonSchema,
  VerifyBehaviorExitKindSchema,
  VerifyBehaviorNoteSchema,
  VerifyBehaviorExitStatusSchema,
  VerifyBehaviorFailingTestSchema,
  VerifyBehaviorEvidenceSchema,
  VerifyBehaviorSelectionSchema,
  VerifyBehaviorExecutionSchema,
  VerifyBehaviorLinkageSchema,
  VerifyBehaviorResultSchema,
  VerifyBehaviorOptionsSchema,
} from './verifyBehavior.js';
export type {
  VerifyBehaviorStatus,
  VerifyBehaviorOutcome,
  VerifyBehaviorSelectionStrategy,
  VerifyBehaviorUnavailabilityReason,
  VerifyBehaviorExitKind,
  VerifyBehaviorNote,
  VerifyBehaviorExitStatus,
  VerifyBehaviorFailingTest,
  VerifyBehaviorEvidence,
  VerifyBehaviorSelection,
  VerifyBehaviorExecution,
  VerifyBehaviorLinkage,
  VerifyBehaviorResult,
  VerifyBehaviorOptions,
} from './verifyBehavior.js';

// VerificationIntelligence (t-104 — advisory verification semantic-gap

// metadata)
export {
  VERIFICATION_SEMANTIC_GAP_OBSERVATIONS,
  VerificationSemanticGapObservationSchema,
  VerificationSemanticGapChangedFileSubjectSchema,
  VerificationSemanticGapChangedSymbolSubjectSchema,
  VerificationSemanticGapChangedSubjectSchema,
  VerificationSemanticGapFailingTestSchema,
  VerificationSemanticGapPayloadSchema,
  VerificationSemanticGapSidecarSchema,
  composeVerificationSemanticGapSidecar,
} from './verificationIntelligence.js';
export type {
  VerificationSemanticGapObservation,
  VerificationSemanticGapChangedSubject,
  VerificationSemanticGapFailingTest,
  VerificationSemanticGapPayload,
  VerificationSemanticGapSidecar,
} from './verificationIntelligence.js';

// Parallel-batch behavior verification (t-091 — macro composition over t-067)
export {
  BATCH_BEHAVIOR_VERIFICATION_OUTCOMES,
  BatchBehaviorVerificationOutcomeSchema,
  BatchBehaviorVerificationSessionInputSchema,
  BatchBehaviorVerificationSelectionSchema,
  BatchBehaviorFailureLinkageEntrySchema,
  BatchBehaviorFailureLinkageSchema,
  BatchBehaviorVerificationResultSchema,
  BatchBehaviorVerificationOptionsSchema,
} from './parallelBatchBehaviorVerification.js';
export type {
  BatchBehaviorVerificationOutcome,
  BatchBehaviorVerificationSessionInput,
  BatchBehaviorVerificationSelection,
  BatchBehaviorFailureLinkageEntry,
  BatchBehaviorFailureLinkage,
  BatchBehaviorVerificationResult,
  BatchBehaviorVerificationOptions,
} from './parallelBatchBehaviorVerification.js';

// Regression bisect macro (t-126 — isolated behavior-verification history search)
export {
  REGRESSION_BISECT_OUTCOMES,
  REGRESSION_BISECT_VERDICTS,
  RegressionBisectOutcomeSchema,
  RegressionBisectVerifierVerdictSchema,
  RegressionBisectRevisionSchema,
  RegressionBisectTranscriptEntrySchema,
  RegressionBisectResultSchema,
} from './regressionBisect.js';
export type {
  RegressionBisectOutcome,
  RegressionBisectVerifierVerdict,
  RegressionBisectRevision,
  RegressionBisectTranscriptEntry,
  RegressionBisectResult,
  RegressionBisectVerifierResult,
  RegressionBisectRunner,
} from './regressionBisect.js';

// Planning guardrails — FencedContract canonical Semantix output (t-155)
export {
  FENCED_CONTRACT_SCHEMA_VERSIONS,
  FENCED_CONTRACT_HASH_ALGORITHM,
  FENCED_CONTRACT_DIAGNOSTIC_KINDS,
  FencedContractSchemaVersionSchema,
  FencedContractProvenanceSchema,
  FencedContractCompilerTargetSchema,
  FencedContractGoalClauseSchema,
  FencedContractBoundaryClauseSchema,
  FencedContractDomainAllowlistClauseSchema,
  FencedContractDomainDenylistClauseSchema,
  FencedContractToolIntentAllowlistClauseSchema,
  FencedContractToolIntentDenylistClauseSchema,
  FencedContractSuccessCriterionClauseSchema,
  FencedContractEvidenceRequirementClauseSchema,
  FencedContractClauseSchema,
  FencedContractBodySchema,
  FencedContractSchema,
  FencedContractDiagnosticKindSchema,
  FencedContractDiagnosticSchema,
  hashFencedContract,
  parseFencedContract,
} from './planningGuardrails.js';
export type {
  FencedContractSchemaVersion,
  FencedContractProvenance,
  FencedContractCompilerTarget,
  FencedContractClause,
  FencedContractClauseType,
  FencedContractBody,
  FencedContract,
  FencedContractDiagnosticKind,
  FencedContractDiagnostic,
  ParsedFencedContract,
} from './planningGuardrails.js';
