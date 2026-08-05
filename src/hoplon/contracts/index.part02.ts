/** Explicit contract re-exports split from index.ts for the 300-line architecture limit. */

// Capability introspection (t-046)
export {
  CapabilityIdSchema,
  CapabilityIntegrationPointSchema,
  CapabilityRuntimeStateSchema,
  CapabilityDefaultBindingSchema,
  CapabilityDefaultWritePostureSchema,
  CapabilitySideEffectPostureSchema,
  CapabilityFailureIsolationSchema,
  CapabilityInvocationModeSchema,
  CapabilityCorrelationFieldSchema,
  CapabilityVersionMetadataSchema,
  CapabilityDataClassSchema,
  CapabilityDataAccessEntrySchema,
  CapabilityDescriptorSchema,
  CapabilityHealthStatusSchema,
  CapabilityContractReportSchema,
  CapabilityContractReportListSchema,
  DescribeCapabilitiesRequestSchema,
  DescribeCapabilitiesResultSchema,
} from './capabilities.js';
export type {
  CapabilityId,
  CapabilityIntegrationPoint,
  CapabilityRuntimeState,
  CapabilityDefaultBinding,
  CapabilityDefaultWritePosture,
  CapabilitySideEffectPosture,
  CapabilityFailureIsolation,
  CapabilityInvocationMode,
  CapabilityCorrelationField,
  CapabilityVersionMetadata,
  CapabilityDataClass,
  CapabilityDataAccessEntry,
  CapabilityDescriptor,
  CapabilityHealthStatus,
  CapabilityContractReport,
  CapabilityContractReportList,
  DescribeCapabilitiesRequest,
  DescribeCapabilitiesResult,
} from './capabilities.js';

// Reconcile
export { ReconcileReportSchema } from './reconcile.js';
export type { ReconcileReport } from './reconcile.js';

// GC
export { GcRequestSchema, GcResultSchema } from './gc.js';
export type { GcRequest, GcResult } from './gc.js';

// AuditLog
export {
  AuditLogOperationSchema,
  AuditLogResultSchema,
  AuditLogRecordSchema,
} from './auditLog.js';
export type { AuditLogOperation, AuditLogResult, AuditLogRecord } from './auditLog.js';

// PolicyAudit (t-088) — folder-scoped handshake + gated access audit evidence
export {
  PolicyAuditActionSchema,
  PolicyAuditAccessSchema,
  PolicyAuditReasonSchema,
  PolicyAuditEventSchema,
} from './policyAudit.js';
export type {
  PolicyAuditAction,
  PolicyAuditAccess,
  PolicyAuditReason,
  PolicyAuditEvent,
} from './policyAudit.js';

// PolicyAuditQuery (t-089) — bounded read-only retrieval contract
export {
  PolicyAuditEntrySchema,
  PolicyAuditOperationSchema,
  PolicyAuditOutcomeSchema,
  PolicyAuditPrincipalFilterSchema,
  PolicyAuditQueryRequestSchema,
  PolicyAuditQueryResponseSchema,
  POLICY_AUDIT_QUERY_DEFAULT_LIMIT,
  POLICY_AUDIT_QUERY_MAX_LIMIT,
} from './policyAuditQuery.js';
export type {
  PolicyAuditEntry,
  PolicyAuditOperation,
  PolicyAuditOutcome,
  PolicyAuditPrincipalFilter,
  PolicyAuditQueryRequest,
  PolicyAuditQueryResponse,
} from './policyAuditQuery.js';

// Dynamic RBAA authorization contracts (opt-in surface only)
export {
  RBAA_SCHEMA_VERSIONS,
  RBAA_RISK_BANDS,
  RBAA_AUTONOMY_TIERS,
  RBAA_RUNTIME_CONTROLS,
  RBAA_CAPABILITY_KEYS,
  RbaaSchemaVersionSchema,
  RbaaRiskBandSchema,
  RbaaAutonomyTierSchema,
  RbaaRuntimeControlSchema,
  RbaaCapabilityKeySchema,
  RbaaRelativePathPatternSchema,
  RbaaPrincipalSchema,
  RbaaTaskContextSchema,
  RbaaScopeClaimSchema,
  RbaaTokenCapabilitiesSchema,
  RbaaUsageLimitsSchema,
  RbaaRiskFactorSchema,
  RbaaRiskFactsSchema,
  RbaaRiskPostureSchema,
  RbaaActiveGrantSchema,
  RbaaAuthorizationRequestSchema,
  RbaaAuthorizationDecisionSchema,
  RbaaEngagementTokenClaimsSchema,
  RbaaPolicyAuditEvidenceSchema,
} from './rbaaAuthorization.js';
export type {
  RbaaSchemaVersion,
  RbaaRiskBand,
  RbaaAutonomyTier,
  RbaaRuntimeControl,
  RbaaCapabilityKey,
  RbaaRelativePathPattern,
  RbaaPrincipal,
  RbaaTaskContext,
  RbaaScopeClaim,
  RbaaTokenCapabilities,
  RbaaUsageLimits,
  RbaaRiskFactor,
  RbaaRiskFacts,
  RbaaRiskPosture,
  RbaaActiveGrant,
  RbaaAuthorizationRequest,
  RbaaAuthorizationDecision,
  RbaaEngagementTokenClaims,
  RbaaPolicyAuditEvidence,
} from './rbaaAuthorization.js';

// Compliance evidence primitives (t-134+)
export {
  AUDIT_LOG_CHAIN_ALGORITHM,
  AUDIT_LOG_CHAIN_VERSION,
  AuditLogChainAlgorithmSchema,
  AuditLogIntegrityCheckpointSchema,
  AuditLogIntegrityFailureKindSchema,
  AuditLogIntegrityFailureSchema,
  AuditLogIntegrityRequestSchema,
  AuditLogIntegrityResultSchema,
  AuditLogIntegrityStatusSchema,
  auditLogChainHash,
  auditLogRowHash,
  canonicalizeAuditLogValue,
  finalizeAuditLogChainRecord,
  sha256Hex,
  verifyAuditLogChain,
} from './compliance.js';
export type {
  AuditLogChainAlgorithm,
  AuditLogIntegrityCheckpoint,
  AuditLogIntegrityFailure,
  AuditLogIntegrityFailureKind,
  AuditLogIntegrityRequest,
  AuditLogIntegrityResult,
  AuditLogIntegrityStatus,
} from './compliance.js';

// SOC2 retention policy primitives (t-135)
export {
  RetentionActionSchema,
  RetentionCandidateSchema,
  RetentionDisposalModeSchema,
  RetentionEvidenceClassSchema,
  RetentionPolicySchema,
  RetentionReasonCodeSchema,
  RetentionSummarySchema,
  auditLogRecordToRetentionCandidate,
  enforceRetention,
  planRetention,
} from './complianceRetention.js';
export type {
  RetentionAction,
  RetentionCandidate,
  RetentionDisposalMode,
  RetentionEvidenceClass,
  RetentionExecutor,
  RetentionPolicy,
  RetentionReasonCode,
  RetentionSummary,
} from './complianceRetention.js';

// SOC2 proof/export access audit primitives (t-136)
export {
  ProofAccessAuditEventSchema,
  ProofAccessClassSchema,
  ProofAccessDecisionSchema,
  ProofAccessObjectTypeSchema,
  ProofAccessOutcomeSchema,
  ProofAccessReasonCodeSchema,
  ProofAccessRequestSchema,
  allowAllProofAccessPolicy,
  authorizeAndAuditProofAccess,
  proofAccessEventToAuditLogRecord,
  roleBasedProofAccessPolicy,
} from './complianceAccess.js';
export type {
  ProofAccessAuditEvent,
  ProofAccessAuditSink,
  ProofAccessClass,
  ProofAccessDecision,
  ProofAccessObjectType,
  ProofAccessOutcome,
  ProofAccessPolicy,
  ProofAccessReasonCode,
  ProofAccessRequest,
} from './complianceAccess.js';

// SOC2 per-principal access evidence (t-137)
export {
  AccessEvidenceEntrySchema,
  AccessEvidencePrincipalSummarySchema,
  AccessEvidenceReportSchema,
  buildAccessEvidenceReport,
} from './complianceEvidence.js';
export type {
  AccessEvidenceEntry,
  AccessEvidencePrincipalSummary,
  AccessEvidenceReport,
} from './complianceEvidence.js';
