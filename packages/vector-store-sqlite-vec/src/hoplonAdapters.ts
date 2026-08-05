import type {
  NativeLexicalIndexAdapter,
  NativeSemanticIndexResult,
  NativeSemanticMatch,
  NativeVectorIndexAdapter,
  NodeSqliteVecDescription,
  NodeSqliteVecSemanticIndex,
} from './types.js';

type HoplonIndexStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';
type HoplonStorageProfileStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
type HoplonMetadata = Record<string, string | number | boolean>;
type HoplonSourceBranchKind = 'local_branch' | 'remote_tracking_branch';
type HoplonSourceStaleState = 'fresh' | 'stale' | 'unindexed' | 'missing';

interface HoplonSourceCommitSnapshot {
  readonly sourceSnapshotId: string;
  readonly projectId: string;
  readonly commitOid: string;
  readonly corpusSchemaVersion: string;
  readonly embeddingProfileHash?: string;
  readonly modelProfileHash?: string;
}

interface HoplonBranchAlias {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly branchName: string;
  readonly branchKind: HoplonSourceBranchKind;
  readonly commitOid: string;
  readonly observedAtIso: string;
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  readonly staleState: HoplonSourceStaleState;
  readonly remote?: string;
}

interface HoplonChunkIdentity {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly chunkId: string;
  readonly canonicalPath: string;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly chunkIndex: number;
  readonly lineRange?: { readonly startLine: number; readonly endLine: number };
  readonly sourceProvenance: {
    readonly commitOid: string;
    readonly branchNames?: readonly string[];
  };
  readonly embeddingCacheKey: string;
}

export interface HoplonIndexResult {
  readonly status: HoplonIndexStatus;
  readonly resultCount: number;
  readonly matches: NativeSemanticMatch[];
  readonly degradationReasons: string[];
}

export interface HoplonLexicalIndexAdapter {
  upsert(
    projectId: string,
    documents: readonly {
      readonly id: string;
      readonly text: string;
      readonly metadata: HoplonMetadata;
      readonly sourceSnapshot?: HoplonSourceCommitSnapshot;
      readonly branchAliases?: readonly HoplonBranchAlias[];
      readonly chunkIdentity?: HoplonChunkIdentity;
    }[],
  ): Promise<HoplonIndexResult>;
  search(
    projectId: string,
    query: string,
    topK: number,
  ): Promise<HoplonIndexResult>;
  delete(
    projectId: string,
    documentIds: readonly string[],
    options?: { readonly tombstoneKind?: string },
  ): Promise<HoplonIndexResult>;
}

export interface HoplonVectorIndexAdapter {
  upsert(
    projectId: string,
    records: readonly {
      readonly id: string;
      readonly vector: number[];
      readonly metadata: HoplonMetadata;
      readonly sourceSnapshot?: HoplonSourceCommitSnapshot;
      readonly branchAliases?: readonly HoplonBranchAlias[];
      readonly chunkIdentity?: HoplonChunkIdentity;
    }[],
  ): Promise<HoplonIndexResult>;
  search(
    projectId: string,
    query: readonly number[],
    topK: number,
  ): Promise<HoplonIndexResult>;
  delete(
    projectId: string,
    recordIds: readonly string[],
    options?: { readonly tombstoneKind?: string },
  ): Promise<HoplonIndexResult>;
}

export interface HoplonSemanticStorageProfile {
  readonly kind: 'native_sqlite_vec';
  readonly status: HoplonStorageProfileStatus;
  readonly durableLexical: boolean;
  readonly durableVector: boolean;
  readonly nativeRuntime: boolean;
  readonly degradationReasons: string[];
}

export interface HoplonSemanticStorageProfileAdapter {
  describe(): Promise<HoplonSemanticStorageProfile>;
}

export interface HoplonSemanticAdapters {
  readonly lexicalIndex: HoplonLexicalIndexAdapter;
  readonly vectorIndex: HoplonVectorIndexAdapter;
  readonly semanticStorageProfile: HoplonSemanticStorageProfileAdapter;
}

export function createNodeSqliteVecHoplonAdapters(
  index: NodeSqliteVecSemanticIndex,
): HoplonSemanticAdapters {
  return {
    lexicalIndex: bridgeLexicalIndex(index.lexicalIndex),
    vectorIndex: bridgeVectorIndex(index.vectorIndex),
    semanticStorageProfile: bridgeStorageProfile(index),
  };
}

function bridgeLexicalIndex(
  native: NativeLexicalIndexAdapter,
): HoplonLexicalIndexAdapter {
  return {
    async upsert(projectId, documents): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.upsert(projectId, documents));
    },
    async search(projectId, query, topK): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.search(projectId, query, topK));
    },
    async delete(projectId, documentIds): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.delete(projectId, documentIds));
    },
  };
}

function bridgeVectorIndex(
  native: NativeVectorIndexAdapter,
): HoplonVectorIndexAdapter {
  return {
    async upsert(projectId, records): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.upsert(projectId, records));
    },
    async search(projectId, query, topK): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.search(projectId, query, topK));
    },
    async delete(projectId, recordIds): Promise<HoplonIndexResult> {
      return normalizeNativeResult(await native.delete(projectId, recordIds));
    },
  };
}

function bridgeStorageProfile(
  index: NodeSqliteVecSemanticIndex,
): HoplonSemanticStorageProfileAdapter {
  return {
    async describe(): Promise<HoplonSemanticStorageProfile> {
      return storageProfile(await index.describe());
    },
  };
}

function normalizeNativeResult(
  result: NativeSemanticIndexResult,
): HoplonIndexResult {
  const status: HoplonIndexStatus =
    result.status === 'AVAILABLE' || result.status === 'EMPTY'
      ? result.status
      : 'UNAVAILABLE';
  return {
    status,
    resultCount: status === 'UNAVAILABLE' ? 0 : result.resultCount,
    matches: status === 'UNAVAILABLE' ? [] : [...result.matches],
    degradationReasons: normalizeReasons(result.degradationReasons),
  };
}

function storageProfile(
  description: NodeSqliteVecDescription,
): HoplonSemanticStorageProfile {
  return {
    kind: 'native_sqlite_vec',
    status: description.status,
    durableLexical: description.lexicalAvailable,
    durableVector: description.vectorAvailable,
    nativeRuntime: description.nativeRuntime,
    degradationReasons: normalizeReasons(description.degradationReasons),
  };
}

function normalizeReasons(reasons: readonly string[]): string[] {
  if (reasons.length === 0) return [];
  return [...new Set(reasons.map((reason) => normalizeReason(reason)))];
}

function normalizeReason(reason: string): string {
  switch (reason) {
    case 'vector_extension_unavailable':
    case 'native_extension_hash_mismatch':
    case 'invalid_vector_shape':
    case 'native_sqlite_operation_failed':
    case 'node_sqlite_runtime_unavailable':
      return 'native_extension_failure';
    default:
      return 'native_extension_failure';
  }
}
