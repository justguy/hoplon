/**
 * providerMapping.ts — design-time ecosystem → seam mapping schema (t-047).
 *
 * Static, introspection-only reference data. No runtime registry, no provider
 * execution, no hot-path decision. This schema only exists to keep the
 * capability catalog, architecture docs, and forward plan aligned on where
 * external tool ecosystems are intended to bind.
 *
 * The actual mapping data lives in `./providerMappingCatalog.ts`.
 * Consistency against `buildCapabilityCatalog()` is enforced by
 * `tests/contracts/providerMapping.test.ts`.
 */

import { z } from 'zod';

import {
  CapabilityDataAccessEntrySchema,
  CapabilityFailureIsolationSchema,
  CapabilityIdSchema,
  CapabilityInvocationModeSchema,
  CapabilityRuntimeStateSchema,
  CapabilitySideEffectPostureSchema,
} from './capabilities.js';

export const ProviderMappingSeamKindSchema = z.enum([
  'capability',
  'core_adapter',
]);
export type ProviderMappingSeamKind = z.infer<
  typeof ProviderMappingSeamKindSchema
>;

export const ProviderMappingCoreAdapterSchema = z.enum([
  'emitter',
  'lockProvider',
  'snapshotStore',
  'versioning',
  'filesystem',
]);
export type ProviderMappingCoreAdapter = z.infer<
  typeof ProviderMappingCoreAdapterSchema
>;

export const ProviderMappingEntrySchema = z
  .object({
    mappingSchemaVersion: z.literal(1),
    ecosystem: z.string().min(1),
    ecosystemName: z.string().min(1),
    candidateTools: z.array(z.string().min(1)).min(1),
    seamKind: ProviderMappingSeamKindSchema,
    capabilityId: CapabilityIdSchema.optional(),
    coreAdapter: ProviderMappingCoreAdapterSchema.optional(),
    runtimeState: CapabilityRuntimeStateSchema,
    invocationMode: CapabilityInvocationModeSchema,
    sideEffectPosture: CapabilitySideEffectPostureSchema,
    failureIsolation: CapabilityFailureIsolationSchema,
    dataAccess: z.array(CapabilityDataAccessEntrySchema).min(1),
    notes: z.string().min(1),
  })
  .refine(
    (entry) =>
      entry.seamKind === 'capability'
        ? entry.capabilityId !== undefined && entry.coreAdapter === undefined
        : entry.coreAdapter !== undefined && entry.capabilityId === undefined,
    {
      message:
        'seamKind=capability requires capabilityId; seamKind=core_adapter requires coreAdapter',
    },
  );
export type ProviderMappingEntry = z.infer<typeof ProviderMappingEntrySchema>;

export const ProviderMappingListSchema = z
  .array(ProviderMappingEntrySchema)
  .min(1);
export type ProviderMappingList = z.infer<typeof ProviderMappingListSchema>;
