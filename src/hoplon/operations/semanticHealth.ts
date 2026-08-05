import type { SemanticStorageProfileAdapter } from '../adapters/semanticStorageProfile.js';
import {
  SemanticHealthSchema,
  type SemanticBindingStatus,
  type SemanticHealth,
  type SemanticPersistenceMode,
  type SemanticRuntimeProfile,
} from '../contracts/semanticHealth.js';
import type { SemanticSearchStatus } from '../contracts/semanticSearch.js';
import type { SemanticSessionOverlayStore } from './semanticSessionOverlay.js';

export interface SemanticHealthDeps {
  readonly embeddingProvided: boolean;
  readonly vectorStoreProvided: boolean;
  readonly embeddingCacheProvided?: boolean;
  readonly semanticIndexStoreProvided?: boolean;
  readonly lexicalIndexProvided?: boolean;
  readonly vectorIndexProvided?: boolean;
  readonly semanticStorageProfileProvided?: boolean;
  readonly semanticStorageProfile: SemanticStorageProfileAdapter;
  readonly sessionOverlayStore?: SemanticSessionOverlayStore;
  readonly manifestStorageMode?: 'inline' | 'hash_only';
}

export async function semanticHealth(
  deps: SemanticHealthDeps,
): Promise<SemanticHealth> {
  const hashOnly = deps.manifestStorageMode === 'hash_only';
  const storage = hashOnly || deps.semanticStorageProfileProvided !== true
    ? null
    : await deps.semanticStorageProfile.describe().catch(() => null);
  const overlays = deps.sessionOverlayStore?.stats() ?? {
    activeOverlayCount: 0,
    reapedOverlayCount: 0,
    documentCount: 0,
    vectorCount: 0,
    maskCount: 0,
  };
  const reasons = uniqueStrings([
    hashOnly ? 'hash_only_manifest_storage' : null,
    storage === null && !hashOnly ? 'semantic_storage_profile_unavailable' : null,
    ...(storage?.degradationReasons ?? []),
    deps.embeddingProvided ? null : 'embedding_provider_not_bound',
    deps.vectorStoreProvided || deps.vectorIndexProvided === true
      ? null
      : 'vector_provider_not_bound',
    deps.lexicalIndexProvided === true &&
      deps.vectorStoreProvided === false &&
      deps.vectorIndexProvided !== true
      ? 'lexical_only_profile'
      : null,
  ]);
  const status = semanticStatus(deps, hashOnly, storage?.status ?? 'UNAVAILABLE');
  const capabilityClass = semanticCapabilityClass(deps, hashOnly, status);
  const value: SemanticHealth = {
    status,
    capabilityClass,
    runtimeProfile: runtimeProfile(hashOnly, storage?.kind, storage?.nativeRuntime),
    persistenceMode: persistenceMode(hashOnly, storage?.durableLexical, storage?.durableVector),
    adapters: {
      embedding: bindingStatus(deps.embeddingProvided, hashOnly),
      vectorStore: bindingStatus(deps.vectorStoreProvided, hashOnly),
      embeddingCache: bindingStatus(deps.embeddingCacheProvided === true, hashOnly),
      semanticIndexStore: bindingStatus(
        deps.semanticIndexStoreProvided === true,
        hashOnly,
      ),
      lexicalIndex: bindingStatus(deps.lexicalIndexProvided === true, hashOnly),
      vectorIndex: bindingStatus(deps.vectorIndexProvided === true, hashOnly),
      semanticStorageProfile: bindingStatus(
        deps.semanticStorageProfileProvided === true,
        hashOnly,
      ),
    },
    embedding: {
      modelStatus: hashOnly ? 'disabled' : deps.embeddingProvided ? 'unverified' : 'missing',
      artifactStatus: hashOnly ? 'disabled' : deps.embeddingProvided ? 'unverified' : 'missing',
    },
    runtimeArtifacts: {
      nativeExtensionStatus: hashOnly
        ? 'disabled'
        : storage?.nativeRuntime === true
          ? 'loaded'
          : 'unavailable',
    },
    cache: { reachable: !hashOnly && deps.embeddingCacheProvided === true },
    index: {
      reachable:
        !hashOnly &&
        (deps.semanticIndexStoreProvided === true ||
          deps.lexicalIndexProvided === true ||
          deps.vectorIndexProvided === true ||
          deps.vectorStoreProvided),
    },
    overlays,
    tombstones: {
      reachable: !hashOnly && deps.semanticIndexStoreProvided === true,
    },
    degradationReasons: reasons,
  };
  return SemanticHealthSchema.parse(value);
}

function semanticStatus(
  deps: SemanticHealthDeps,
  hashOnly: boolean,
  storageStatus: SemanticSearchStatus,
): SemanticSearchStatus {
  if (hashOnly) return 'UNAVAILABLE';
  const hasVector =
    deps.vectorStoreProvided || deps.vectorIndexProvided === true;
  if (!deps.embeddingProvided && deps.lexicalIndexProvided !== true) {
    return 'UNAVAILABLE';
  }
  if (deps.embeddingProvided && hasVector && storageStatus === 'AVAILABLE') {
    return 'AVAILABLE';
  }
  return deps.lexicalIndexProvided === true || deps.embeddingProvided
    ? 'DEGRADED'
    : 'UNAVAILABLE';
}

function semanticCapabilityClass(
  deps: SemanticHealthDeps,
  hashOnly: boolean,
  status: SemanticSearchStatus,
): SemanticHealth['capabilityClass'] {
  if (hashOnly) return 'disabled';
  if (status === 'AVAILABLE') return 'advisory_ready';
  if (status === 'DEGRADED') return 'degraded';
  return deps.embeddingProvided || deps.vectorStoreProvided || deps.lexicalIndexProvided === true
    ? 'contract_only'
    : 'seam_only';
}

function runtimeProfile(
  hashOnly: boolean,
  kind: string | undefined,
  nativeRuntime: boolean | undefined,
): SemanticRuntimeProfile {
  if (hashOnly) return 'hash_only_disabled';
  if (nativeRuntime === true || kind === 'native_sqlite_vec') return 'native_performance';
  if (kind === 'wasm_sqlite_fts_vector') return 'portable_wasm';
  if (kind === 'lexical_only_degraded') return 'lexical_only_degraded';
  return 'noop';
}

function persistenceMode(
  hashOnly: boolean,
  durableLexical: boolean | undefined,
  durableVector: boolean | undefined,
): SemanticPersistenceMode {
  if (hashOnly) return 'hash_only_disabled';
  if (durableLexical === true || durableVector === true) return 'host_snapshot_storage';
  return 'process_local_overlay';
}

function bindingStatus(bound: boolean, disabled: boolean): SemanticBindingStatus {
  if (disabled) return 'disabled';
  return bound ? 'bound' : 'noop';
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== undefined))];
}
