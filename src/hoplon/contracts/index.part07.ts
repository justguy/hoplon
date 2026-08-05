/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// Planning guardrails — PlanningGuardrailBundle + PlanningTurnEvidence (t-156)
export {
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM,
  PLANNING_GUARDRAIL_ENFORCEMENT_MODES,
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
  PLANNING_GUARDRAIL_GENERATED_CONFIG_KINDS,
  PlanningGuardrailBundleSchemaVersionSchema,
  PlanningGuardrailEnforcementModeSchema,
  PlanningGuardrailEvidenceAuthoritySchema,
  PlanningGuardrailTargetRuntimeSchema,
  PlanningGuardrailGeneratedConfigKindSchema,
  PlanningGuardrailGeneratedConfigSchema,
  PlanningGuardrailClauseRailMappingSchema,
  PlanningGuardrailBundleBodySchema,
  PlanningGuardrailBundleSchema,
  hashPlanningGuardrailBundle,
} from './planningGuardrailBundle.js';
export type {
  PlanningGuardrailBundleSchemaVersion,
  PlanningGuardrailEnforcementMode,
  PlanningGuardrailEvidenceAuthority,
  PlanningGuardrailTargetRuntime,
  PlanningGuardrailGeneratedConfig,
  PlanningGuardrailClauseRailMapping,
  PlanningGuardrailBundleBody,
  PlanningGuardrailBundle,
} from './planningGuardrailBundle.js';
export {
  PLANNING_GUARDRAIL_BUNDLE_DIAGNOSTIC_KINDS,
  PlanningGuardrailBundleDiagnosticKindSchema,
  PlanningGuardrailBundleDiagnosticSchema,
  parsePlanningGuardrailBundle,
} from './planningGuardrailBundleParser.js';
export type {
  PlanningGuardrailBundleDiagnosticKind,
  PlanningGuardrailBundleDiagnostic,
  ParsedPlanningGuardrailBundle,
} from './planningGuardrailBundleParser.js';
export {
  PLANNING_TURN_EVIDENCE_SCHEMA_VERSIONS,
  PLANNING_TURN_OUTCOMES,
  PlanningTurnEvidenceSchemaVersionSchema,
  PlanningTurnOutcomeSchema,
  PlanningTurnEvidenceSchema,
} from './planningTurnEvidence.js';
export type {
  PlanningTurnEvidenceSchemaVersion,
  PlanningTurnOutcome,
  PlanningTurnEvidence,
} from './planningTurnEvidence.js';
export {
  PLANNING_GUARDRAIL_COMPILER_ID,
  PLANNING_GUARDRAIL_COMPILER_DIAGNOSTIC_KINDS,
  PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES,
  PlanningGuardrailCompilerDiagnosticKindSchema,
  PlanningGuardrailCompilerDiagnosticSchema,
  PlanningGuardrailCompilerRequestSchema,
  PlanningGuardrailGeneratedArtifactSchema,
  compileFencedContractToPlanningGuardrailBundle,
} from './planningGuardrailCompiler.js';
export type {
  PlanningGuardrailCompilerDiagnosticKind,
  PlanningGuardrailCompilerDiagnostic,
  PlanningGuardrailCompilerRequest,
  PlanningGuardrailGeneratedArtifact,
  CompiledPlanningGuardrailBundle,
} from './planningGuardrailCompiler.js';
export {
  GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS,
  GUARDED_PLANNING_POINTER_REF_KINDS,
  GUARDED_PLANNING_ROUTER_DIAGNOSTIC_KINDS,
  GuardedPlanningRouterSchemaVersionSchema,
  GuardedPlanningPointerRefKindSchema,
  GuardedPlanningPointerRefSchema,
  GuardedPlanningModelRequestSchema,
  GuardedPlanningModelResultSchema,
  GuardedPlanningRouterProofSchema,
  GuardedPlanningRouterDiagnosticKindSchema,
  GuardedPlanningRouterDiagnosticSchema,
  parseGuardedPlanningRouterProof,
} from './guardedPlanningRouter.js';
export type {
  GuardedPlanningRouterSchemaVersion,
  GuardedPlanningPointerRef,
  GuardedPlanningModelRequest,
  GuardedPlanningModelResult,
  GuardedPlanningRouterProof,
  GuardedPlanningRouterDiagnosticKind,
  GuardedPlanningRouterDiagnostic,
  ParsedGuardedPlanningRouterProof,
} from './guardedPlanningRouter.js';
export {
  CONTROL_ROOM_REVIEW_EVIDENCE_SCHEMA_VERSIONS,
  ControlRoomReviewEvidenceSchemaVersionSchema,
  ReviewControlAuthoritySchema,
  ExecutionBlueprintPreviewSchema,
  ReviewWarningSchema,
  DeterministicHandoffPreviewSchema,
  ControlRoomReviewEvidenceAttachmentSchema,
} from './controlRoomReviewEvidence.js';
export type {
  ControlRoomReviewEvidenceSchemaVersion,
  ReviewControlAuthority,
  ExecutionBlueprintPreview,
  ReviewWarning,
  DeterministicHandoffPreview,
  ControlRoomReviewEvidenceAttachment,
} from './controlRoomReviewEvidence.js';
export {
  DETERMINISTIC_POLICY_BUNDLE_SCHEMA_VERSIONS,
  DETERMINISTIC_POLICY_AUTHORITY,
  DETERMINISTIC_POLICY_COMPILER_DIAGNOSTIC_KINDS,
  DeterministicPolicyBundleSchemaVersionSchema,
  DeterministicPolicyAuthoritySchema,
  DeterministicPolicyKindSchema,
  DeterministicPolicyEntrySchema,
  AdvisoryClauseMappingSchema,
  DeterministicPolicyBundleBodySchema,
  DeterministicPolicyBundleSchema,
  DeterministicPolicyCompilerDiagnosticKindSchema,
  DeterministicPolicyCompilerDiagnosticSchema,
  DeterministicPolicyCompilerRequestSchema,
  compileFencedContractToDeterministicPolicyBundle,
  hashDeterministicPolicyBundle,
} from './deterministicPolicyBundle.js';
export type {
  DeterministicPolicyBundleSchemaVersion,
  DeterministicPolicyAuthority,
  DeterministicPolicyKind,
  DeterministicPolicyEntry,
  AdvisoryClauseMapping,
  DeterministicPolicyBundleBody,
  DeterministicPolicyBundle,
  DeterministicPolicyCompilerDiagnosticKind,
  DeterministicPolicyCompilerDiagnostic,
  DeterministicPolicyCompilerRequest,
  CompiledDeterministicPolicyBundle,
} from './deterministicPolicyBundle.js';
export {
  PLANNING_GUARDRAIL_CORPUS_SCHEMA_VERSIONS,
  PlanningGuardrailCorpusSchemaVersionSchema,
  PlanningGuardrailCorpusLabelSchema,
  PlanningGuardrailObservedOutcomeSchema,
  PlanningGuardrailRiskTypeSchema,
  PlanningGuardrailCorpusCaseSchema,
  PlanningGuardrailAdversarialCorpusSchema,
  PlanningGuardrailCorpusScoreSchema,
  scorePlanningGuardrailCorpus,
} from './planningGuardrailAdversarialCorpus.js';
export type {
  PlanningGuardrailCorpusSchemaVersion,
  PlanningGuardrailCorpusLabel,
  PlanningGuardrailObservedOutcome,
  PlanningGuardrailRiskType,
  PlanningGuardrailCorpusCase,
  PlanningGuardrailAdversarialCorpus,
  PlanningGuardrailCorpusScore,
} from './planningGuardrailAdversarialCorpus.js';

// Errors
export {
  HoplonError,
  EngineError,
  AdapterError,
  SemanticError,
  ValidationError,
} from './errors.js';
export type {
  HoplonErrorOptions,
  EngineErrorKind,
  EngineErrorOptions,
  AdapterErrorKind,
  AdapterErrorOptions,
  SemanticErrorKind,
  SemanticErrorOptions,
  ValidationErrorKind,
  ValidationErrorOptions,
} from './errors.js';
