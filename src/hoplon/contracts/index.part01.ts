/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// Manifest
export {
  ManifestSchemaVersionSchema,
  ManifestScopeSchema,
  ManifestScopeWholeFileSchema,
  ManifestScopeSymbolsSchema,
  ManifestIntentSchema,
  ManifestEntrySchema,
  SignatureParamSchema,
  SignatureContractSchema,
  WritableManifestSchema,
} from './manifest.js';
export type {
  ManifestSchemaVersion,
  ManifestScope,
  ManifestIntent,
  ManifestEntry,
  SignatureParam,
  SignatureContract,
  WritableManifest,
} from './manifest.js';

// ASTStrategy
export {
  ASTStrategySchema,
  ASTStrategyWholeFileSchema,
  ASTStrategySymbolsSchema,
  ASTStrategyTreeSitterQuerySchema,
} from './astStrategy.js';
export type { ASTStrategy } from './astStrategy.js';

// QueryStructure (CI3-3)
export {
  TreeSitterQuerySchema,
  QueryMatchSchema,
  QueryMatchGroupSchema,
  QueryStructureRequestSchema,
  QueryStructureResultSchema,
  SUPPORTED_QUERY_LANGUAGES,
} from './queryStructure.js';
export type {
  TreeSitterQuery,
  QueryLanguage,
  QueryMatch,
  QueryMatchGroup,
  QueryStructureRequest,
  QueryStructureResult,
} from './queryStructure.js';

// Syntax-node lookup (t-120)
export {
  FindSyntaxNodeRequestSchema,
  FindSyntaxNodeResultSchema,
  SyntaxHealthNodeSchema,
  SyntaxHealthSidecarSchema,
  SyntaxNodeSummarySchema,
} from './syntaxNodeLookup.js';
export type {
  FindSyntaxNodeRequest,
  FindSyntaxNodeResult,
  SyntaxHealthNode,
  SyntaxHealthSidecar,
  SyntaxNodeLookupTarget,
  SyntaxNodeSummary,
} from './syntaxNodeLookup.js';

// Requests
export {
  CreateSnapshotRequestSchema,
  AuditRequestSchema,
  RevertRequestSchema,
  PackContextRequestSchema,
  ProposedChangeSchema,
  StagedContentRefSchema,
  FullFileProposedChangeSchema,
  PatchHunkSchema,
  PatchProposedChangeSchema,
  StructuralSymbolTargetSchema,
  StructuralSymbolPathTargetSchema,
  StructuralTargetSchema,
  StructuralProposedChangeSchema,
  DryRunRequestSchema,
  PreflightRequestSchema,
} from './requests.js';
export type {
  CreateSnapshotRequest,
  AuditRequest,
  RevertRequest,
  PackContextRequest,
  ProposedChange,
  StagedContentRef,
  FullFileProposedChange,
  PatchHunk,
  PatchProposedChange,
  StructuralSymbolTarget,
  StructuralSymbolPathTarget,
  StructuralTarget,
  StructuralProposedChange,
  DryRunRequest,
  PreflightRequest,
} from './requests.js';

// Strict engagement context (t-096)
export { StrictEngagementContextSchema } from './engagementContext.js';
export type { StrictEngagementContext } from './engagementContext.js';

// Preflight
export {
  PreflightGateStatusSchema,
  PreflightGateResultSchema,
  PreflightResultSchema,
} from './preflight.js';
export type {
  PreflightGateStatus,
  PreflightGateResult,
  PreflightResult,
} from './preflight.js';

// Snapshot
export {
  SnapshotRefSchema,
  SnapshotWarningSchema,
  SnapshotWarningPossibleSecretSchema,
  SnapshotWarningPossibleDlpFindingSchema,
  SnapshotResultSchema,
} from './snapshot.js';
export type { SnapshotRef, SnapshotWarning, SnapshotResult } from './snapshot.js';

// Context
export {
  PackedSliceSchema,
  PackFailureSchema,
  PackFailureFileTooLargeSchema,
  PackFailureParseFailureSchema,
  PackFailureParseTimeoutSchema,
  PackFailureUnsupportedExtensionSchema,
  PackedContextSchema,
} from './context.js';
export type { PackedSlice, PackFailure, PackedContext } from './context.js';

// Audit
export {
  // Phase 1 canonical schemas (permanent — never renamed)
  AuditViolationOutOfScopeSymbolSchema,
  AuditViolationUncontractedFileSchema,
  AuditViolationParseFailureSchema,
  AuditViolationSnapshotMissingSchema,
  // Phase 2 additive schemas
  AuditViolationScopeEscapeSchema,
  AuditViolationStructuralCorruptionSchema,
  AuditViolationPathEscapeSchema,
  AuditViolationSignatureMismatchSchema,
  AuditViolationSignatureUncertainSchema,
  AuditViolationTargetNotFoundSchema,
  AuditViolationDuplicateTargetSchema,
  AuditViolationImportTargetNotFoundSchema,
  AuditViolationImportSymbolNotExportedSchema,
  AuditViolationImportAliasUnresolvedSchema,
  // Union + result schemas
  AuditViolationSchema,
  AuditResultPassSchema,
  AuditResultBlockSchema,
  AuditResultSchema,
} from './audit.js';
export type { AuditViolation, AuditResult } from './audit.js';

// Revert
export { RevertResultSchema } from './revert.js';
export type { RevertResult } from './revert.js';

// Health
export { AdapterStatusSchema, EngineHealthSchema } from './health.js';
export type { AdapterStatus, EngineHealth } from './health.js';
export {
  SemanticAdapterHealthSchema,
  SemanticArtifactStatusSchema,
  SemanticBindingStatusSchema,
  SemanticCacheHealthSchema,
  SemanticCapabilityClassSchema,
  SemanticEmbeddingHealthSchema,
  SemanticHealthSchema,
  SemanticIndexHealthSchema,
  SemanticNativeExtensionStatusSchema,
  SemanticOverlayHealthSchema,
  SemanticPersistenceModeSchema,
  SemanticRuntimeArtifactHealthSchema,
  SemanticRuntimeProfileSchema,
  SemanticTombstoneHealthSchema,
} from './semanticHealth.js';
export type {
  SemanticAdapterHealth,
  SemanticArtifactStatus,
  SemanticBindingStatus,
  SemanticCacheHealth,
  SemanticCapabilityClass,
  SemanticEmbeddingHealth,
  SemanticHealth,
  SemanticIndexHealth,
  SemanticNativeExtensionStatus,
  SemanticOverlayHealth,
  SemanticPersistenceMode,
  SemanticRuntimeArtifactHealth,
  SemanticRuntimeProfile,
  SemanticTombstoneHealth,
} from './semanticHealth.js';
