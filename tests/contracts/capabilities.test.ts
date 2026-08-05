import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CapabilityContractReportSchema,
  CapabilityDescriptorSchema,
  DescribeCapabilitiesRequestSchema,
  DescribeCapabilitiesResultSchema,
} from '../../src/index.js';

const VALID_DESCRIPTOR = {
  contractSchemaVersion: 1,
  capabilityId: 'versionSyncedIntelligence',
  name: 'Version-Synced Intelligence Metadata',
  integrationPoint: 'host_composition',
  runtimeState: 'contract_only',
  defaultBinding: 'none',
  defaultWritePosture: 'read_only',
  sideEffectPosture: 'none',
  failureIsolation: 'host_invoked_only',
  invocationMode: 'host_invoked',
  correlationFields: ['engineId', 'correlationId', 'projectId', 'runId', 'snapshotRefId'],
  versionMetadata: [
    'capability_contract_v1',
    'provider_version',
    'workspace_revision',
    'manifest_schema_version',
    'snapshot_ref',
  ],
  dataAccess: [
    { dataClass: 'workspace_content', access: 'read_only' },
    { dataClass: 'snapshot_metadata', access: 'read_only' },
    { dataClass: 'provider_metadata', access: 'read_only' },
  ],
  notes:
    'Target-state contract only. The seam preserves revision-aware metadata without hardcoding a provider or storage engine.',
} as const;

describe('capability contracts', () => {
  it('accepts a valid capability descriptor', () => {
    expect(CapabilityDescriptorSchema.safeParse(VALID_DESCRIPTOR).success).toBe(true);
  });

  it('rejects an invalid runtimeState', () => {
    expect(
      CapabilityDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        runtimeState: 'enabled',
      }).success,
    ).toBe(false);
  });

  it('accepts semantic advisory-ready and degraded runtime states', () => {
    expect(
      CapabilityDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        capabilityId: 'semanticSearch',
        runtimeState: 'advisory_ready',
      }).success,
    ).toBe(true);
    expect(
      CapabilityDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        capabilityId: 'semanticSearch',
        runtimeState: 'degraded',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid capability contract report', () => {
    expect(
      CapabilityContractReportSchema.safeParse({
        descriptor: VALID_DESCRIPTOR,
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid correlation field entry', () => {
    expect(
      CapabilityDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        correlationFields: ['engineId', 'bogusField'],
      }).success,
    ).toBe(false);
  });

  it('requires correlationId for describeCapabilities requests', () => {
    expect(DescribeCapabilitiesRequestSchema.safeParse({}).success).toBe(false);
    expect(
      DescribeCapabilitiesRequestSchema.safeParse({ correlationId: 'corr-cap-1' }).success,
    ).toBe(true);
  });

  it('accepts a valid describeCapabilities result envelope', () => {
    const result = {
      catalogVersion: 1,
      engineId: 'engine-cap-0',
      capabilities: [{ descriptor: VALID_DESCRIPTOR, healthStatus: 'available' }],
    };

    expect(DescribeCapabilitiesResultSchema.safeParse(result).success).toBe(true);
  });

  it('emits non-empty JSON Schema for the result envelope', () => {
    const jsonSchema = zodToJsonSchema(
      DescribeCapabilitiesResultSchema,
      'DescribeCapabilitiesResult',
    );
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(100);
  });
});
