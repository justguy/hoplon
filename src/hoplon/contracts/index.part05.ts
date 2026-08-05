/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// SemanticSearch (t-034 — first real Layer 1 semantic-search seam)
export {
  SemanticDegradationReasonSchema,
  SemanticFreshnessSchema,
  SemanticProviderEnvelopeSchema,
  SemanticSidecarStatusSchema,
  SemanticSearchStatusSchema,
  SemanticStorageProfileKindSchema,
  SemanticSearchMetadataSchema,
  SemanticSourceCommitOidSchema,
  SemanticSourceBranchKindSchema,
  SemanticSourceStaleStateSchema,
  SemanticLineRangeSchema,
  SemanticSourceCommitSnapshotSchema,
  SemanticBranchAliasSchema,
  SemanticChunkIdentitySchema,
  SemanticCorpusDocumentSchema,
  IndexSemanticCorpusRequestSchema,
  IndexSemanticCorpusResultSchema,
  SemanticSearchRequestSchema,
  SemanticSearchMatchSchema,
  SemanticSearchResultSchema,
  SemanticOverlayModeSchema,
  SemanticOverlayInputSourceSchema,
  SemanticOverlayRefreshRequestSchema,
  SemanticOverlayRefreshResultSchema,
  SemanticOverlayClearRequestSchema,
  SemanticOverlayClearResultSchema,
} from './semanticSearch.js';
export {
  SemanticSearchBranchScopeModeSchema,
  SemanticSearchBranchScopeSchema,
  SemanticSearchStalePolicySchema,
  SemanticSearchSuggestionModeSchema,
  SemanticSearchRecoveryDiagnosticSchema,
  SemanticSearchRecoveryEnvelopeSchema,
  SemanticSearchRequestValidationError,
  buildSemanticSearchRecoveryEnvelope,
} from './semanticSearchRecovery.js';
export type {
  SemanticDegradationReason,
  SemanticFreshness,
  SemanticProviderEnvelope,
  SemanticSidecarStatus,
  SemanticSearchStatus,
  SemanticStorageProfileKind,
  SemanticSearchMetadata,
  SemanticSourceCommitOid,
  SemanticSourceBranchKind,
  SemanticSourceStaleState,
  SemanticLineRange,
  SemanticSourceCommitSnapshot,
  SemanticBranchAlias,
  SemanticChunkIdentity,
  SemanticCorpusDocument,
  IndexSemanticCorpusRequest,
  IndexSemanticCorpusResult,
  SemanticSearchRequest,
  SemanticSearchMatch,
  SemanticSearchResult,
  SemanticOverlayMode,
  SemanticOverlayInputSource,
  SemanticOverlayRefreshRequest,
  SemanticOverlayRefreshResult,
  SemanticOverlayClearRequest,
  SemanticOverlayClearResult,
} from './semanticSearch.js';
export type {
  SemanticSearchBranchScopeMode,
  SemanticSearchBranchScope,
  SemanticSearchStalePolicy,
  SemanticSearchSuggestionMode,
  SemanticSearchRecoveryDiagnostic,
  SemanticSearchRecoveryEnvelope,
} from './semanticSearchRecovery.js';

// SeeCodebase (t-061 — unified agent-facing read/search macro)
export {
  SEE_CODEBASE_INTENTS,
  SEE_CODEBASE_MODES,
  SEE_CODEBASE_ERROR_KINDS,
  SeeCodebaseIntentSchema,
  SeeCodebaseTargetSchema,
  SeeCodebaseModeSchema,
  SeeCodebaseRequestSchema,
  SeeCodebaseResultSchema,
  SeeCodebaseProvenanceSchema,
  SeeCodebaseErrorSchema,
  SeeCodebaseErrorKindSchema,
  SeeCodebaseEnvelopeSchema,
  SeeCodebaseSelectedPathSchema,
  SeeCodebaseFileKindSupportSchema,
  SeeCodebasePrimitiveIdSchema,
  SeeCodebaseReadProvenanceSchema,
  SeeCodebaseAstNodeSelectorSchema,
  SeeCodebaseAstNodeExpectedIdentitySchema,
  SeeCodebaseAstNodeIdentitySchema,
} from './seeCodebase.js';
export type {
  SeeCodebaseIntent,
  SeeCodebaseTarget,
  SeeCodebaseMode,
  SeeCodebaseAstNodeSelector,
  SeeCodebaseAstNodeExpectedIdentity,
  SeeCodebaseAstNodeIdentity,
  SeeCodebaseRequest,
  SeeCodebaseRequestValidated,
  SeeCodebaseResult,
  SeeCodebaseReadProvenance,
  SeeCodebaseProvenance,
  SeeCodebaseError,
  SeeCodebaseErrorKind,
  SeeCodebaseEnvelope,
  SeeCodebaseSelectedPath,
  SeeCodebaseFileKindSupport,
  SeeCodebasePrimitiveId,
} from './seeCodebase.js';

// SeeCodebaseIntelligence (t-102 — advisory read-side intelligence)
export {
  ReadAstNodeIdentitySchema,
  ReadStructuralCompressionEntrySchema,
  ReadStructuralCompressionPayloadSchema,
  ReadSemanticRankedMatchSchema,
  ReadSemanticQueryResultSchema,
  ReadSemanticTwinSchema,
  ReadSemanticSearchPayloadSchema,
} from './seeCodebaseIntelligence.js';
export type {
  ReadAstNodeIdentity,
  ReadStructuralCompressionEntry,
  ReadStructuralCompressionPayload,
  ReadSemanticRankedMatch,
  ReadSemanticQueryResult,
  ReadSemanticTwin,
  ReadSemanticSearchPayload,
} from './seeCodebaseIntelligence.js';

// ReviewPayload (t-072 — focused preview / post-edit review evidence;

// t-077 swapped `impact.blastRadius` for the canonical

// `impact.dependencyImpact` sidecar)
export {
  REVIEW_PAYLOAD_PHASES,
  REVIEW_BOUNDARY_CHANGE_MODES,
  REVIEW_BOUNDARY_SIDES,
  REVIEW_FILE_FALLBACK_REASONS,
  REVIEW_IMPACT_UNAVAILABLE_REASONS,
  REVIEW_PAYLOAD_NOTES,
  ReviewPayloadPhaseSchema,
  ReviewPayloadSessionStateSchema,
  ReviewChangeKindCountsSchema,
  ReviewBoundaryChangeModeSchema,
  ReviewBoundarySideSchema,
  ReviewBoundarySchema,
  ReviewFileFallbackReasonSchema,
  ReviewFileFallbackSchema,
  ReviewFileSchema,
  ReviewImpactUnavailableReasonSchema,
  ReviewImpactRelevantTestsSchema,
  ReviewImpactSchema,
  ReviewPayloadNoteSchema,
  SessionReviewPayloadSchema,
  GetReviewPayloadOptionsSchema,
} from './reviewPayload.js';
export type {
  ReviewPayloadPhase,
  ReviewChangeKindCounts,
  ReviewBoundaryChangeMode,
  ReviewBoundarySide,
  ReviewBoundary,
  ReviewFileFallbackReason,
  ReviewFileFallback,
  ReviewFile,
  ReviewImpactUnavailableReason,
  ReviewImpactRelevantTests,
  ReviewImpact,
  ReviewPayloadNote,
  SessionReviewPayload,
  GetReviewPayloadOptions,
} from './reviewPayload.js';

// WritePreviewIntelligence (t-103 — advisory write-preview metadata)
export {
  WRITE_PREVIEW_INTELLIGENCE_SIDECAR_KINDS,
  WRITE_PREVIEW_VIOLATION_RISK_STATUSES,
  WRITE_PREVIEW_VIOLATION_RISK_REASONS,
  WritePreviewIntelligenceSidecarKindSchema,
  WritePreviewViolationRiskStatusSchema,
  WritePreviewViolationRiskReasonSchema,
  WritePreviewRiskEvidenceSchema,
  WritePreviewRiskConfidenceSchema,
  WritePreviewViolationRiskPayloadSchema,
  WritePreviewBlastRadiusSidecarSchema,
  WritePreviewViolationRiskSidecarSchema,
  WritePreviewAdvisoryIntelligenceSchema,
  composeWritePreviewAdvisoryIntelligence,
} from './writePreviewIntelligence.js';
export type {
  WritePreviewViolationRiskReason,
  WritePreviewRiskEvidence,
  WritePreviewBlastRadiusSidecar,
  WritePreviewViolationRiskSidecar,
  WritePreviewAdvisoryIntelligence,
  PredictViolationRiskForPreview,
  ComposeWritePreviewAdvisoryIntelligenceInput,
} from './writePreviewIntelligence.js';

// GetRelevantTests (LC10 — static test oracle)
export {
  GetRelevantTestsRequestSchema,
  TestOracleResultSchema,
} from './getRelevantTests.js';
export type {
  GetRelevantTestsRequest,
  TestOracleResult,
} from './getRelevantTests.js';
