import { describe, expect, it } from 'vitest';

import { describeCapabilities } from '../../src/hoplon/operations/describeCapabilities.js';
import type { DescribeCapabilitiesDeps } from '../../src/hoplon/operations/describeCapabilities.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createNoopAnalyzer } from '../../src/hoplon/adapters/staticAnalysis/noop.js';
import { createNoopSemanticStorageProfile } from '../../src/hoplon/adapters/semanticStorageProfile.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { LockProvider } from '../../src/hoplon/adapters/lock.js';
import type { SecretScannerAdapter } from '../../src/hoplon/adapters/secretScanner.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { createInMemorySemanticSessionOverlayStore } from '../../src/hoplon/operations/semanticSearch.js';

function makeDeps(overrides: Partial<DescribeCapabilitiesDeps> = {}) {
  const emitter = createMemoryEmitter();
  const codeIntelligence: CodeIntelligenceAdapter = {
    async parse() {
      return { rootNode: { kind: 'program', children: [] } };
    },
    getTopLevelSymbols() {
      return [];
    },
  };

  const deps: DescribeCapabilitiesDeps = {
    fs: createMemFsAdapter(),
    versioning: {} as VersioningAdapter,
    snapshotStore: {
      async listPending() {
        return [];
      },
    } as SnapshotStore,
    lockProvider: {
      async acquire() {
        return () => {};
      },
    } as LockProvider,
    emitter,
    codeIntelligence,
    secretScanner: {
      async scan() {
        return [];
      },
    } as SecretScannerAdapter,
    staticAnalysis: createNoopAnalyzer(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    embeddingProvided: false,
    vectorStoreProvided: false,
    embeddingCacheProvided: false,
    semanticIndexStoreProvided: false,
    lexicalIndexProvided: false,
    vectorIndexProvided: false,
    semanticStorageProfileProvided: false,
    sessionOverlayStore: createInMemorySemanticSessionOverlayStore(),
    engineId: 'engine-cap-test',
    startedAt: Date.now() - 10,
    gitRepoDir: '.hoplon/repo',
    ...overrides,
  };

  return { deps, emitter };
}

describe('describeCapabilities', () => {
  it('returns the typed catalog with correlation-aware events', async () => {
    const { deps, emitter } = makeDeps();

    const result = await describeCapabilities(deps, { correlationId: 'corr-cap-1' });

    expect(result.catalogVersion).toBe(1);
    expect(result.engineId).toBe('engine-cap-test');
    expect(result.capabilities.map((c) => c.descriptor.capabilityId)).toEqual([
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
    expect(result.capabilities[0]?.healthStatus).toBe('available');
    expect(result.capabilities[2]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[3]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[3]?.descriptor.defaultBinding).toBe('noop');
    expect(result.capabilities[3]?.healthStatus).toBeUndefined();
    // t-034: the embedding + vectorStore slots default to the noop pair; their
    // runtimeState remains 'seam_only' until the host wires real providers.
    expect(result.capabilities[4]?.descriptor.capabilityId).toBe('embedding');
    expect(result.capabilities[4]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[4]?.descriptor.invocationMode).toBe('typed_engine_method');
    expect(result.capabilities[4]?.descriptor.failureIsolation).toBe('advisory_only');
    expect(result.capabilities[5]?.descriptor.capabilityId).toBe('vectorStore');
    expect(result.capabilities[5]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[5]?.descriptor.invocationMode).toBe('typed_engine_method');
    expect(result.capabilities[5]?.descriptor.failureIsolation).toBe('advisory_only');
    // t-034: the semanticSearch composite consumer appears between vectorStore
    // and anomalyDetector. It is seam_only whenever either provider is absent,
    // advisory_only by schema (`advisory: true` literal), and never participates
    // in PASS/BLOCK.
    expect(result.capabilities[6]?.descriptor.capabilityId).toBe('semanticSearch');
    expect(result.capabilities[6]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[6]?.healthStatus).toBe('unavailable');
    expect(result.capabilities[6]?.descriptor.defaultBinding).toBe('noop');
    expect(result.capabilities[6]?.descriptor.invocationMode).toBe('typed_engine_method');
    expect(result.capabilities[6]?.descriptor.failureIsolation).toBe('advisory_only');
    expect(result.capabilities[6]?.descriptor.sideEffectPosture).toBe('none');
    // t-037: anomaly detector now surfaces as a typed engine seam, advisory-only.
    expect(result.capabilities[7]?.descriptor.capabilityId).toBe('anomalyDetector');
    expect(result.capabilities[7]?.descriptor.invocationMode).toBe('typed_engine_method');
    expect(result.capabilities[7]?.descriptor.failureIsolation).toBe('advisory_only');
    expect(result.capabilities[7]?.descriptor.defaultBinding).toBe('noop');
    // t-026: semantic DLP seam — warn-mode-by-default, advisory-only isolation.
    expect(result.capabilities[9]?.descriptor.capabilityId).toBe('dlp');
    expect(result.capabilities[9]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[9]?.descriptor.defaultBinding).toBe('noop');
    expect(result.capabilities[9]?.descriptor.sideEffectPosture).toBe('warning_only');
    expect(result.capabilities[9]?.descriptor.failureIsolation).toBe('advisory_only');
    // t-027: blast-radius advisory consumer — runtimeState=seam_only because the
    // shipped default tree-sitter adapter does not implement findReferences.
    expect(result.capabilities[10]?.descriptor.capabilityId).toBe('blastRadius');
    expect(result.capabilities[10]?.descriptor.runtimeState).toBe('seam_only');
    expect(result.capabilities[10]?.descriptor.failureIsolation).toBe('advisory_only');
    expect(result.capabilities[10]?.descriptor.invocationMode).toBe('typed_engine_method');
    expect(
      result.capabilities.every((c) =>
        c.descriptor.correlationFields.includes('engineId') &&
        c.descriptor.correlationFields.includes('correlationId'),
      ),
    ).toBe(true);

    const events = emitter.getEvents().filter((e) => e.op === 'describeCapabilities');
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(events.every((e) => e.correlationId === 'corr-cap-1')).toBe(true);
  });

  it('still returns the catalog when unrelated health probes fail', async () => {
    const failingFs: HoplonFsAdapter = {
      stat: async () => {
        throw new Error('fs offline');
      },
    } as HoplonFsAdapter;
    const failingStore: SnapshotStore = {
      async listPending() {
        throw new Error('store offline');
      },
    } as SnapshotStore;

    const { deps } = makeDeps({
      fs: failingFs,
      snapshotStore: failingStore,
    });

    const result = await describeCapabilities(deps, { correlationId: 'corr-cap-2' });
    expect(result.capabilities).toHaveLength(16);
    expect(result.capabilities[0]?.healthStatus).toBe('available');
  });

  it('distinguishes advisory-ready and degraded semantic capability states', async () => {
    const advisoryReady = await describeCapabilities(makeDeps({
      embeddingProvided: true,
      vectorStoreProvided: true,
      semanticStorageProfileProvided: true,
      semanticStorageProfile: {
        async describe() {
          return {
            kind: 'wasm_sqlite_fts_vector',
            status: 'AVAILABLE',
            durableLexical: true,
            durableVector: true,
            nativeRuntime: false,
            degradationReasons: [],
          };
        },
      },
    }).deps, { correlationId: 'corr-cap-ready' });
    const degraded = await describeCapabilities(makeDeps({
      lexicalIndexProvided: true,
    }).deps, { correlationId: 'corr-cap-degraded' });

    const readySemantic = advisoryReady.capabilities.find(
      (c) => c.descriptor.capabilityId === 'semanticSearch',
    );
    const degradedSemantic = degraded.capabilities.find(
      (c) => c.descriptor.capabilityId === 'semanticSearch',
    );
    expect(readySemantic?.descriptor.runtimeState).toBe('advisory_ready');
    expect(readySemantic?.healthStatus).toBe('available');
    expect(readySemantic?.descriptor.notes).toContain('unified baseline/branch/overlay retrieval');
    expect(readySemantic?.descriptor.notes).toContain('deterministic exact reads/searches stay on seeCodebase');
    expect(degradedSemantic?.descriptor.runtimeState).toBe('degraded');
    expect(degradedSemantic?.healthStatus).toBe('degraded');
    expect(degradedSemantic?.descriptor.notes).toContain('suggest recovery');
    expect(readySemantic?.descriptor.failureIsolation).toBe('advisory_only');
    expect(degradedSemantic?.descriptor.failureIsolation).toBe('advisory_only');
  });
});
