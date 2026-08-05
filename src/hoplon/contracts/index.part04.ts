/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// InterfaceStubs (t-028 — deterministic interface-stub synthesis)
export {
  STUB_QUALITIES,
  STUB_PLACEHOLDER_REASONS,
  STUBS_STATUSES,
  InterfaceStubTargetSchema,
  StubQualitySchema,
  StubPlaceholderReasonSchema,
  InterfaceStubSchema,
  SynthesizeInterfaceStubsStatusSchema,
  SynthesizeInterfaceStubsRequestSchema,
  SynthesizeInterfaceStubsResultSchema,
} from './interfaceStubs.js';
export type {
  InterfaceStubTarget,
  StubQuality,
  StubPlaceholderReason,
  InterfaceStub,
  SynthesizeInterfaceStubsStatus,
  SynthesizeInterfaceStubsRequest,
  SynthesizeInterfaceStubsResult,
} from './interfaceStubs.js';

// Ephemeral structural sandbox (t-108)
export {
  SandboxLanguageSchema,
  StructuralSandboxExpectationsSchema,
  StructuralSandboxSnippetSchema,
  StructuralSandboxOptionsSchema,
  EphemeralStructuralSandboxRequestSchema,
  StructuralSandboxStatusSchema,
  StructuralSandboxSnippetStatusSchema,
  StructuralSandboxParseCheckSchema,
  StructuralSandboxSymbolSchema,
  StructuralSandboxExpectationFailureSchema,
  StructuralSandboxStructureCheckSchema,
  StructuralSandboxSnippetResultSchema,
  StructuralSandboxTypeProviderCheckSchema,
  StructuralSandboxSideEffectProfileSchema,
  StructuralSandboxNonBypassSchema,
  EphemeralStructuralSandboxResultSchema,
  createStructuralSandboxSideEffectProfile,
  createStructuralSandboxNonBypass,
} from './structuralSandbox.js';
export type {
  SandboxLanguage,
  StructuralSandboxExpectations,
  StructuralSandboxSnippet,
  StructuralSandboxOptions,
  EphemeralStructuralSandboxRequest,
  StructuralSandboxStatus,
  StructuralSandboxSnippetStatus,
  StructuralSandboxParseCheck,
  StructuralSandboxSymbol,
  StructuralSandboxExpectationFailure,
  StructuralSandboxStructureCheck,
  StructuralSandboxSnippetResult,
  StructuralSandboxTypeProviderCheck,
  StructuralSandboxSideEffectProfile,
  StructuralSandboxNonBypass,
  EphemeralStructuralSandboxResult,
} from './structuralSandbox.js';

// Speculative edit sandbox (t-127)
export {
  SpeculativeEditCandidateSchema,
  SpeculativeCandidateOutcomeSchema,
  SpeculativeCandidateCleanupStatusSchema,
  SpeculativeCandidateEvaluationSchema,
  SpeculativeAdoptionStatusSchema,
  SpeculativeEditAdoptionSchema,
  SpeculativeEditSandboxOutcomeSchema,
  SpeculativeEditSandboxResultSchema,
} from './speculativeEditSandbox.js';
export type {
  SpeculativeEditCandidate,
  SpeculativeCandidateOutcome,
  SpeculativeCandidateCleanupStatus,
  SpeculativeCandidateEvaluation,
  SpeculativeAdoptionStatus,
  SpeculativeEditAdoption,
  SpeculativeEditSandboxOutcome,
  SpeculativeEditSandboxResult,
} from './speculativeEditSandbox.js';

// AnomalyDetector (t-037 — advisory anomaly-detector seam)
export {
  ANOMALY_METRIC_NAMES,
  AnomalyMetricNameSchema,
  ProjectMetricsSchema,
  AnomalySignalSchema,
  AnomalyScoreSchema,
  ScoreAnomalyRequestSchema,
} from './anomalyDetector.js';
export type {
  AnomalyMetricName,
  ProjectMetrics,
  AnomalySignal,
  AnomalyScore,
  ScoreAnomalyRequest,
} from './anomalyDetector.js';

// ViolationPredictor (t-036 — advisory violation risk predictor seam)
export {
  PredictorFeaturesSchema,
  ViolationRiskBandSchema,
  ViolationPredictionSchema,
  PredictViolationRiskRequestSchema,
} from './violationPredictor.js';
export type {
  PredictorFeatures,
  ViolationRiskBand,
  ViolationPrediction,
  PredictViolationRiskRequest,
} from './violationPredictor.js';

// AdvisoryIntelligence (t-101 — shared sidecar envelope for read,

// write-preview, and verification metadata)
export {
  ADVISORY_INTELLIGENCE_SURFACES,
  ADVISORY_INTELLIGENCE_PROVIDER_STATUSES,
  ADVISORY_EVIDENCE_STATUSES,
  AdvisoryIntelligenceSurfaceSchema,
  AdvisoryIntelligenceProviderStatusSchema,
  AdvisoryEvidenceStatusSchema,
  AdvisoryEvidenceStateSchema,
  AdvisoryIntelligenceProviderStateSchema,
  AdvisoryIntelligenceAuthoritySchema,
  StrictAgentIntelligenceAccessSchema,
  AdvisoryIntelligenceSidecarEnvelopeSchema,
  createAdvisoryEvidenceState,
  createAdvisoryEvidenceStateFromProvider,
  createSampleBackedAdvisoryEvidenceState,
  createAdvisoryIntelligenceAuthority,
  createStrictAgentIntelligenceAccess,
} from './advisoryIntelligence.js';
export type {
  AdvisoryIntelligenceSurface,
  AdvisoryIntelligenceProviderStatus,
  AdvisoryEvidenceStatus,
  AdvisoryEvidenceState,
  CreateAdvisoryEvidenceStateInput,
  AdvisoryIntelligenceProviderState,
  AdvisoryIntelligenceAuthority,
  StrictAgentIntelligenceAccess,
  AdvisoryIntelligenceSidecarEnvelope,
} from './advisoryIntelligence.js';

// Dlp (t-026 — semantic DLP seam)
export {
  DLP_CLASSIFICATIONS,
  DLP_POLICY_MODES,
  DEFAULT_DLP_POLICY_MODE,
  DlpClassificationSchema,
  DlpPolicyModeSchema,
  DlpFindingSchema,
  DlpScanInputSchema,
} from './dlp.js';
export type {
  DlpClassification,
  DlpPolicyMode,
  DlpFinding,
} from './dlp.js';

// PostEditPolicy (t-115 — advisory post-edit content policy sidecar)
export {
  POST_EDIT_POLICY_FINDING_CATEGORIES,
  POST_EDIT_POLICY_REASONS,
  PostEditPolicyFindingCategorySchema,
  PostEditPolicyFindingSchema,
  PostEditPolicyReasonSchema,
  PostEditPolicyScanSidecarSchema,
  createPostEditPolicyUnavailable,
} from './postEditPolicy.js';
export type {
  PostEditPolicyFindingCategory,
  PostEditPolicyFinding,
  PostEditPolicyReason,
  PostEditPolicyScanInput,
  PostEditPolicyScanSidecar,
  PostEditPolicyScanner,
} from './postEditPolicy.js';

// DescribeProject (t-056 — local AST-aware project orientation)
export {
  SUPPORTED_PROJECT_LANGUAGES,
  ProjectLanguageSchema,
  DescribeProjectRequestSchema,
  DescribeProjectResultSchema,
} from './describeProject.js';
export type {
  ProjectLanguage,
  DescribeProjectRequest,
  DescribeProjectResult,
} from './describeProject.js';
