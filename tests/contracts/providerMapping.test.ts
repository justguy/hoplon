import { describe, expect, it } from 'vitest';

import { CapabilityIdSchema } from '../../src/hoplon/contracts/capabilities.js';
import type { CapabilityId } from '../../src/hoplon/contracts/capabilities.js';
import {
  ProviderMappingEntrySchema,
  ProviderMappingListSchema,
} from '../../src/hoplon/contracts/providerMapping.js';
import type { ProviderMappingEntry } from '../../src/hoplon/contracts/providerMapping.js';
import { PROVIDER_MAPPING } from '../../src/hoplon/contracts/providerMappingCatalog.js';
import { buildCapabilityCatalog } from '../../src/hoplon/operations/describeCapabilitiesCatalog.js';
import type { EngineHealth } from '../../src/hoplon/contracts/health.js';

const syntheticHealth: EngineHealth = {
  engineId: 'test-engine',
  uptimeMs: 0,
  adapters: {
    fs: 'ok',
    versioning: 'ok',
    snapshotStore: 'ok',
    lockProvider: 'ok',
    emitter: 'ok',
    codeIntelligence: 'ok',
    secretScanner: 'ok',
    staticAnalysis: 'ok',
  },
  semantic: {
    status: 'UNAVAILABLE',
    capabilityClass: 'seam_only',
    runtimeProfile: 'noop',
    persistenceMode: 'process_local_overlay',
    adapters: {
      embedding: 'noop',
      vectorStore: 'noop',
      embeddingCache: 'noop',
      semanticIndexStore: 'noop',
      lexicalIndex: 'noop',
      vectorIndex: 'noop',
      semanticStorageProfile: 'noop',
    },
    embedding: { modelStatus: 'missing', artifactStatus: 'missing' },
    runtimeArtifacts: { nativeExtensionStatus: 'unavailable' },
    cache: { reachable: false },
    index: { reachable: false },
    overlays: {
      activeOverlayCount: 0,
      reapedOverlayCount: 0,
      documentCount: 0,
      vectorCount: 0,
      maskCount: 0,
    },
    tombstones: { reachable: false },
    degradationReasons: [],
  },
};

const descriptorByCapability = new Map(
  buildCapabilityCatalog(syntheticHealth).map((report) => [
    report.descriptor.capabilityId,
    report.descriptor,
  ]),
);

describe('provider mapping catalog', () => {
  it('parses against ProviderMappingListSchema', () => {
    const result = ProviderMappingListSchema.safeParse(PROVIDER_MAPPING);
    if (!result.success) {
      throw new Error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it.each(PROVIDER_MAPPING.map((e) => [e.ecosystem, e] as const))(
    'entry "%s" parses against ProviderMappingEntrySchema',
    (_ecosystem, entry) => {
      expect(ProviderMappingEntrySchema.safeParse(entry).success).toBe(true);
    },
  );

  it('uses a unique ecosystem slug per entry', () => {
    const slugs = PROVIDER_MAPPING.map((entry) => entry.ecosystem);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has exactly one capability entry for every CapabilityId in the schema', () => {
    const mapped = PROVIDER_MAPPING.filter(
      (entry): entry is ProviderMappingEntry & { capabilityId: CapabilityId } =>
        entry.seamKind === 'capability' && entry.capabilityId !== undefined,
    );
    const mappedIds = mapped.map((entry) => entry.capabilityId);
    expect(mappedIds).toHaveLength(CapabilityIdSchema.options.length);
    expect(new Set(mappedIds).size).toBe(CapabilityIdSchema.options.length);
    const mappedSet = new Set<CapabilityId>(mappedIds);
    for (const capabilityId of CapabilityIdSchema.options) {
      expect(mappedSet.has(capabilityId)).toBe(true);
    }
  });

  it('core-adapter entries cover emitter, lockProvider, and snapshotStore exactly once', () => {
    const coreAdapters = PROVIDER_MAPPING.filter(
      (entry): entry is ProviderMappingEntry & { coreAdapter: NonNullable<ProviderMappingEntry['coreAdapter']> } =>
        entry.seamKind === 'core_adapter' && entry.coreAdapter !== undefined,
    ).map((entry) => entry.coreAdapter);
    expect(coreAdapters.sort()).toEqual([
      'emitter',
      'lockProvider',
      'snapshotStore',
    ]);
  });

  it('snapshotStore mapping stays on registry metadata and audit evidence', () => {
    const snapshotStoreEntry = PROVIDER_MAPPING.find(
      (entry) =>
        entry.seamKind === 'core_adapter' && entry.coreAdapter === 'snapshotStore',
    );
    expect(snapshotStoreEntry).toBeDefined();
    if (!snapshotStoreEntry) return;
    const entryDataAccess = snapshotStoreEntry.dataAccess
      .map((d) => `${d.dataClass}:${d.access}`)
      .sort();
    expect(entryDataAccess).toEqual([
      'audit_evidence:read_only',
      'snapshot_metadata:read_only',
    ]);
    expect(entryDataAccess).not.toContain('workspace_content:read_only');
  });

  it.each(
    PROVIDER_MAPPING.filter((e) => e.seamKind === 'capability').map(
      (e) => [e.capabilityId as CapabilityId, e] as const,
    ),
  )(
    'capability entry for "%s" preserves descriptor runtime/invocation/side-effect/failure/data-access',
    (capabilityId, entry) => {
      const descriptor = descriptorByCapability.get(capabilityId);
      expect(descriptor).toBeDefined();
      if (!descriptor) return;
      expect(entry.runtimeState).toBe(descriptor.runtimeState);
      expect(entry.invocationMode).toBe(descriptor.invocationMode);
      expect(entry.sideEffectPosture).toBe(descriptor.sideEffectPosture);
      expect(entry.failureIsolation).toBe(descriptor.failureIsolation);
      const entryDataAccess = entry.dataAccess
        .map((d) => `${d.dataClass}:${d.access}`)
        .sort();
      const descriptorDataAccess = descriptor.dataAccess
        .map((d) => `${d.dataClass}:${d.access}`)
        .sort();
      expect(entryDataAccess).toEqual(descriptorDataAccess);
    },
  );

  it('every core-adapter entry names one valid coreAdapter seam', () => {
    const coreEntries = PROVIDER_MAPPING.filter(
      (entry) => entry.seamKind === 'core_adapter',
    );
    expect(coreEntries.length).toBeGreaterThan(0);
    for (const entry of coreEntries) {
      expect(entry.coreAdapter).toBeDefined();
      expect(entry.capabilityId).toBeUndefined();
    }
  });

  it('catches drift between a capability entry runtimeState and the descriptor', () => {
    const shipped = PROVIDER_MAPPING.find(
      (entry) =>
        entry.seamKind === 'capability' && entry.runtimeState === 'shipped',
    );
    expect(shipped).toBeDefined();
    if (!shipped) return;
    const descriptor = descriptorByCapability.get(
      shipped.capabilityId as CapabilityId,
    );
    expect(descriptor?.runtimeState).toBe('shipped');
    const drifted = { ...shipped, runtimeState: 'contract_only' as const };
    expect(drifted.runtimeState).not.toBe(descriptor?.runtimeState);
  });
});
