/**
 * capabilities.ts — versioned DTOs for capability introspection.
 *
 * These contracts describe intelligence / extension seams without introducing
 * a runtime registry or provider execution path into core semantics.
 */

import { z } from 'zod';

export const CapabilityIdSchema = z.enum([
  'codeIntelligence',
  'secretScanner',
  'staticAnalysis',
  'summarizer',
  'embedding',
  'vectorStore',
  'semanticSearch',
  'anomalyDetector',
  'violationPredictor',
  'dlp',
  'blastRadius',
  'versionSyncedIntelligence',
  'semanticGapAnalysis',
  'semanticTwins',
  'mutationTesting',
  'complianceExports',
]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const CapabilityIntegrationPointSchema = z.enum([
  'core_adapter',
  'plugin_contract',
  'host_composition',
  'host_export',
]);
export type CapabilityIntegrationPoint = z.infer<
  typeof CapabilityIntegrationPointSchema
>;

export const CapabilityRuntimeStateSchema = z.enum([
  'shipped',
  'seam_only',
  'contract_only',
  'advisory_ready',
  'degraded',
]);
export type CapabilityRuntimeState = z.infer<typeof CapabilityRuntimeStateSchema>;

export const CapabilityDefaultBindingSchema = z.enum([
  'builtin',
  'noop',
  'none',
]);
export type CapabilityDefaultBinding = z.infer<
  typeof CapabilityDefaultBindingSchema
>;

export const CapabilityDefaultWritePostureSchema = z.enum(['read_only']);
export type CapabilityDefaultWritePosture = z.infer<
  typeof CapabilityDefaultWritePostureSchema
>;

export const CapabilitySideEffectPostureSchema = z.enum([
  'none',
  'warning_only',
  'export_only',
]);
export type CapabilitySideEffectPosture = z.infer<
  typeof CapabilitySideEffectPostureSchema
>;

export const CapabilityFailureIsolationSchema = z.enum([
  'core_operation',
  'advisory_only',
  'host_invoked_only',
]);
export type CapabilityFailureIsolation = z.infer<
  typeof CapabilityFailureIsolationSchema
>;

export const CapabilityInvocationModeSchema = z.enum([
  'typed_engine_method',
  'host_invoked',
  'explicit_extension_call',
]);
export type CapabilityInvocationMode = z.infer<
  typeof CapabilityInvocationModeSchema
>;

export const CapabilityCorrelationFieldSchema = z.enum([
  'engineId',
  'correlationId',
  'projectId',
  'runId',
  'snapshotRefId',
]);
export type CapabilityCorrelationField = z.infer<
  typeof CapabilityCorrelationFieldSchema
>;

export const CapabilityVersionMetadataSchema = z.enum([
  'capability_contract_v1',
  'provider_version',
  'workspace_revision',
  'manifest_schema_version',
  'snapshot_ref',
]);
export type CapabilityVersionMetadata = z.infer<
  typeof CapabilityVersionMetadataSchema
>;

export const CapabilityDataClassSchema = z.enum([
  'workspace_content',
  'workspace_metadata',
  'snapshot_metadata',
  'provider_metadata',
  'audit_evidence',
  'host_objective',
]);
export type CapabilityDataClass = z.infer<typeof CapabilityDataClassSchema>;

export const CapabilityDataAccessEntrySchema = z.object({
  dataClass: CapabilityDataClassSchema,
  access: z.literal('read_only'),
});
export type CapabilityDataAccessEntry = z.infer<
  typeof CapabilityDataAccessEntrySchema
>;

export const CapabilityDescriptorSchema = z.object({
  contractSchemaVersion: z.literal(1),
  capabilityId: CapabilityIdSchema,
  name: z.string().min(1),
  integrationPoint: CapabilityIntegrationPointSchema,
  runtimeState: CapabilityRuntimeStateSchema,
  defaultBinding: CapabilityDefaultBindingSchema,
  defaultWritePosture: CapabilityDefaultWritePostureSchema,
  sideEffectPosture: CapabilitySideEffectPostureSchema,
  failureIsolation: CapabilityFailureIsolationSchema,
  invocationMode: CapabilityInvocationModeSchema,
  correlationFields: z
    .array(CapabilityCorrelationFieldSchema)
    .min(1)
    .refine(
      (fields) => fields.includes('engineId') && fields.includes('correlationId'),
      'correlation fields must include engineId and correlationId',
    ),
  versionMetadata: z.array(CapabilityVersionMetadataSchema).min(1),
  dataAccess: z.array(CapabilityDataAccessEntrySchema).min(1),
  notes: z.string().min(1),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const CapabilityHealthStatusSchema = z.enum([
  'available',
  'degraded',
  'unavailable',
]);
export type CapabilityHealthStatus = z.infer<
  typeof CapabilityHealthStatusSchema
>;

export const CapabilityContractReportSchema = z.object({
  descriptor: CapabilityDescriptorSchema,
  healthStatus: CapabilityHealthStatusSchema.optional(),
});
export type CapabilityContractReport = z.infer<
  typeof CapabilityContractReportSchema
>;

export const CapabilityContractReportListSchema = z.array(
  CapabilityContractReportSchema,
);
export type CapabilityContractReportList = z.infer<
  typeof CapabilityContractReportListSchema
>;

export const DescribeCapabilitiesRequestSchema = z.object({
  correlationId: z.string().min(1),
});
export type DescribeCapabilitiesRequest = z.infer<
  typeof DescribeCapabilitiesRequestSchema
>;

export const DescribeCapabilitiesResultSchema = z.object({
  catalogVersion: z.literal(1),
  engineId: z.string().min(1),
  capabilities: CapabilityContractReportListSchema,
});
export type DescribeCapabilitiesResult = z.infer<
  typeof DescribeCapabilitiesResultSchema
>;
