/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// SOC2 deterministic evidence bundle (t-138)
export {
  Soc2ControlEvidenceSchema,
  Soc2ControlIdSchema,
  Soc2EvidenceBundleSchema,
  Soc2EvidenceRefSchema,
  exportComplianceReport,
} from './soc2EvidenceBundle.js';
export type {
  Soc2ControlEvidence,
  Soc2ControlId,
  Soc2EvidenceBundle,
  Soc2EvidenceRef,
} from './soc2EvidenceBundle.js';

// ExecutionTrace / Attempt / ProofBundle / DecisionProvenance (t-068)
export {
  ExecutionIdSchema,
  ExecutionStatusSchema,
  ExecutionTraceSchema,
} from './executionTrace.js';
export type { ExecutionId, ExecutionStatus, ExecutionTrace } from './executionTrace.js';
export {
  AttemptStatusSchema,
  ActorTypeSchema,
  AttemptSchema,
} from './attempt.js';
export type { AttemptStatus, ActorType, Attempt } from './attempt.js';
export {
  ProofBundleSchema,
  ProofViolationSchema,
} from './proofBundle.js';
export type { ProofBundle, ProofViolation } from './proofBundle.js';
export {
  ProvenanceCategorySchema,
  DecisionProvenanceSchema,
} from './decisionProvenance.js';
export type { ProvenanceCategory, DecisionProvenance } from './decisionProvenance.js';

// RetryContext (LC9)
export { PriorAttemptSchema, CompressedRetryContextSchema } from './retryContext.js';
export type { PriorAttempt, CompressedRetryContext } from './retryContext.js';

// RetryContextCompression (t-107)
export {
  RETRY_CONTEXT_COMPRESSION_STATUSES,
  RetryContextCompressionStatusSchema,
  RETRY_CONTEXT_COMPRESSION_DEGRADED_REASONS,
  RetryContextCompressionDegradedReasonSchema,
  RetryContextPrimaryFailureSchema,
  RetryContextFocusedDiagnosticSchema,
  RetryContextRawLogPointerSchema,
  RetryContextCompressionSchema,
} from './retryContextCompression.js';
export type {
  RetryContextCompressionStatus,
  RetryContextCompressionDegradedReason,
  RetryContextPrimaryFailure,
  RetryContextFocusedDiagnostic,
  RetryContextRawLogPointer,
  RetryContextCompression,
} from './retryContextCompression.js';

// Declarative invariant binding (t-105)
export {
  InvariantAstTargetSchema,
  InvariantNodeProvenanceSchema,
  ExportedSymbolExistsInvariantSchema,
  FunctionShapeInvariantSchema,
  DtoFieldPresenceInvariantSchema,
  RouteToolContractShapeInvariantSchema,
  UnsupportedInvariantSchema,
  DeclarativeInvariantBindingSchema,
  INVARIANT_CHECK_STATUSES,
  InvariantCheckStatusSchema,
  INVARIANT_CHECK_REASONS,
  InvariantCheckReasonSchema,
  InvariantCheckResultSchema,
  DeclarativeInvariantReportSchema,
} from './invariantBinding.js';
export type {
  InvariantAstTarget,
  InvariantNodeProvenance,
  DeclarativeInvariantBinding,
  InvariantCheckStatus,
  InvariantCheckReason,
  InvariantCheckResult,
  DeclarativeInvariantReport,
} from './invariantBinding.js';

// ComputeMinimalPatch (LC5)
export {
  MinimalPatchActionSchema,
  MinimalPatchSchema,
  ComputeMinimalPatchRequestSchema,
} from './computeMinimalPatch.js';
export type { MinimalPatchAction, MinimalPatch, ComputeMinimalPatchRequest } from './computeMinimalPatch.js';

// StructuralTemplate (LC4)
export {
  SymbolKindSchema,
  ExportEntrySchema,
  ImportEntrySchema,
  TypeEntrySchema,
  StructuralTemplateFileSchema,
  StructuralTemplateSchema,
  ExtractStructuralTemplateRequestSchema,
  SYMBOL_KINDS,
} from './structuralTemplate.js';
export type {
  SymbolKind,
  ExportEntry,
  ImportEntry,
  TypeEntry,
  StructuralTemplateFile,
  StructuralTemplate,
  ExtractStructuralTemplateRequest,
} from './structuralTemplate.js';

// RollbackTemplate (LC11)
export {
  RollbackTemplateFileSchema,
  RollbackTemplateSchema,
  ExtractRollbackTemplateRequestSchema,
} from './rollbackTemplate.js';
export type {
  RollbackTemplateFile,
  RollbackTemplate,
  ExtractRollbackTemplateRequest,
} from './rollbackTemplate.js';

// RepairContext (t-070 — reusable failed-audit repair-loop packaging)
export {
  FailedAttemptRefSchema,
  NextAttemptPlanSchema,
  RepairContextSchema,
} from './repairContext.js';
export type {
  FailedAttemptRef,
  NextAttemptPlan,
  RepairContext,
} from './repairContext.js';

// SearchSymbols (t-056 — local AST-aware structural search)
export {
  SEARCHABLE_SYMBOL_KINDS,
  SearchableSymbolKindSchema,
  SearchSymbolMatchSchema,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
} from './searchSymbols.js';
export type {
  SearchableSymbolKind,
  SearchSymbolMatch,
  SearchSymbolsRequest,
  SearchSymbolsResult,
} from './searchSymbols.js';

// BlastRadius (t-027 — advisory blast-radius seam)
export {
  DEFAULT_BLAST_RADIUS_WARN_THRESHOLD,
  BlastRadiusSymbolSchema,
  BlastRadiusClassificationSchema,
  BlastRadiusEntrySchema,
  BlastRadiusStatusSchema,
  AnalyzeBlastRadiusRequestSchema,
  AnalyzeBlastRadiusResultSchema,
} from './blastRadius.js';
export type {
  BlastRadiusSymbol,
  BlastRadiusClassification,
  BlastRadiusEntry,
  BlastRadiusStatus,
  AnalyzeBlastRadiusRequest,
  AnalyzeBlastRadiusResult,
} from './blastRadius.js';

// ReferencingSymbols (t-118 — advisory referencing-symbol lookup)
export {
  ReferencingSymbolIdentitySchema,
  ReferencingSymbolTargetSchema,
  FindReferencingSymbolsRequestSchema,
  ReferencingSymbolTargetResolutionSchema,
  ReferencingSymbolReferenceSchema,
  FindReferencingSymbolsResultSchema,
} from './referencingSymbols.js';
export type {
  ReferencingSymbolIdentity,
  ReferencingSymbolTarget,
  FindReferencingSymbolsRequest,
  ReferencingSymbolTargetResolution,
  ReferencingSymbolReference,
  FindReferencingSymbolsResult,
} from './referencingSymbols.js';

// DependencyImpact (t-077 — canonical advisory dependency-impact sidecar

// shared by review-payload and repair-context packaging)
export {
  DEPENDENCY_IMPACT_CHANGE_MODES,
  DEPENDENCY_IMPACT_SUBJECT_ORIGINS,
  DEPENDENCY_IMPACT_FILE_FALLBACK_REASONS,
  DEPENDENCY_IMPACT_STATUSES,
  DEPENDENCY_IMPACT_REASONS,
  DependencyImpactChangeModeSchema,
  DependencyImpactSubjectOriginSchema,
  DependencyImpactFileFallbackReasonSchema,
  DependencyImpactSymbolSubjectSchema,
  DependencyImpactFileSubjectSchema,
  DependencyImpactSubjectSchema,
  DependencyImpactStatusSchema,
  DependencyImpactReasonSchema,
  DependencyImpactSidecarSchema,
  DependencyImpactOptionsSchema,
} from './dependencyImpact.js';
export type {
  DependencyImpactChangeMode,
  DependencyImpactSubjectOrigin,
  DependencyImpactFileFallbackReason,
  DependencyImpactSymbolSubject,
  DependencyImpactFileSubject,
  DependencyImpactSubject,
  DependencyImpactStatus,
  DependencyImpactReason,
  DependencyImpactSidecar,
  DependencyImpactOptions,
} from './dependencyImpact.js';
