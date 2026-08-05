export type PortableSemanticIndexRuntimeProfile = 'lexical_only_degraded';
export type PortableSemanticIndexPersistenceMode = 'host_snapshot_storage';

export type PortableLexicalIndexStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';
export type PortableVectorIndexStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'EMPTY';
export type PortableTombstoneKind = 'deleted' | 'ignored' | 'policy_banned';
export type PortableSemanticStorageProfileStatus =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'UNAVAILABLE';

export type PortableMetadata = Record<string, string | number | boolean>;

export type PortableSourceBranchKind =
  | 'local_branch'
  | 'remote_tracking_branch';
export type PortableSourceStaleState =
  | 'fresh'
  | 'stale'
  | 'unindexed'
  | 'missing';

export interface PortableLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface PortableSourceCommitSnapshot {
  readonly sourceSnapshotId: string;
  readonly projectId: string;
  readonly commitOid: string;
  readonly corpusSchemaVersion: string;
  readonly embeddingProfileHash?: string;
  readonly modelProfileHash?: string;
}

export interface PortableBranchAlias {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly branchName: string;
  readonly branchKind: PortableSourceBranchKind;
  readonly commitOid: string;
  readonly observedAtIso: string;
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  readonly staleState: PortableSourceStaleState;
  readonly remote?: string;
}

export interface PortableChunkIdentity {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly chunkId: string;
  readonly canonicalPath: string;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly chunkIndex: number;
  readonly lineRange?: PortableLineRange;
  readonly sourceProvenance: {
    readonly commitOid: string;
    readonly branchNames?: readonly string[];
  };
  readonly embeddingCacheKey: string;
}

export interface LexicalIndexDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata: PortableMetadata;
  readonly sourceSnapshot?: PortableSourceCommitSnapshot;
  readonly branchAliases?: readonly PortableBranchAlias[];
  readonly chunkIdentity?: PortableChunkIdentity;
}

export interface LexicalIndexMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: PortableMetadata;
}

export interface LexicalIndexResult {
  readonly status: PortableLexicalIndexStatus;
  readonly resultCount: number;
  readonly matches: LexicalIndexMatch[];
  readonly degradationReasons: string[];
}

export interface LexicalIndexAdapter {
  upsert(
    projectId: string,
    documents: readonly LexicalIndexDocument[],
  ): Promise<LexicalIndexResult>;
  search(projectId: string, query: string, topK: number): Promise<LexicalIndexResult>;
  delete(
    projectId: string,
    documentIds: readonly string[],
    options?: { readonly tombstoneKind?: PortableTombstoneKind },
  ): Promise<LexicalIndexResult>;
}

export interface VectorIndexRecord {
  readonly id: string;
  readonly vector: number[];
  readonly metadata: PortableMetadata;
  readonly sourceSnapshot?: PortableSourceCommitSnapshot;
  readonly branchAliases?: readonly PortableBranchAlias[];
  readonly chunkIdentity?: PortableChunkIdentity;
}

export interface VectorIndexMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: PortableMetadata;
}

export interface VectorIndexResult {
  readonly status: PortableVectorIndexStatus;
  readonly resultCount: number;
  readonly matches: VectorIndexMatch[];
  readonly degradationReasons: string[];
}

export interface VectorIndexAdapter {
  upsert(
    projectId: string,
    records: readonly VectorIndexRecord[],
  ): Promise<VectorIndexResult>;
  search(
    projectId: string,
    query: readonly number[],
    topK: number,
  ): Promise<VectorIndexResult>;
  delete(
    projectId: string,
    recordIds: readonly string[],
    options?: { readonly tombstoneKind?: PortableTombstoneKind },
  ): Promise<VectorIndexResult>;
}

export interface SemanticStorageProfile {
  readonly kind: 'lexical_only_degraded';
  readonly status: PortableSemanticStorageProfileStatus;
  readonly durableLexical: boolean;
  readonly durableVector: boolean;
  readonly nativeRuntime: boolean;
  readonly degradationReasons: string[];
}

export interface SemanticStorageProfileAdapter {
  describe(): Promise<SemanticStorageProfile>;
}

export interface PortableSemanticIndexStoredDocument extends LexicalIndexDocument {
  readonly updatedAtIso: string;
}

export interface PortableSemanticIndexTombstone {
  readonly id: string;
  readonly kind: PortableTombstoneKind;
  readonly updatedAtIso: string;
}

export interface PortableSemanticIndexSnapshot {
  readonly version: 1;
  readonly projects: Record<
    string,
    Record<string, PortableSemanticIndexStoredDocument>
  >;
  readonly tombstones: Record<
    string,
    Record<string, PortableSemanticIndexTombstone>
  >;
}

export interface PortableSemanticIndexStorage {
  load(): Promise<PortableSemanticIndexSnapshot | null>;
  save(snapshot: PortableSemanticIndexSnapshot): Promise<void>;
}

export interface PortableSemanticIndexMaintenanceResult {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';
  readonly cacheEntriesDeleted: number;
  readonly overlaysReaped: number;
  readonly tombstonesDeleted: number;
  readonly degradationReasons: string[];
}

export interface PortableSemanticIndexMaintenanceAdapter {
  gc(opts: {
    readonly semanticCache?: boolean;
    readonly semanticOverlays?: boolean;
    readonly semanticTombstones?: boolean;
  }): Promise<PortableSemanticIndexMaintenanceResult>;
}

export interface PortableSemanticIndexScaleLimits {
  readonly maxRecommendedDocuments: number;
  readonly maxRecommendedTokensPerDocument: number;
}

export interface PortableSemanticIndexDescription {
  readonly runtimeProfile: PortableSemanticIndexRuntimeProfile;
  readonly persistenceMode: PortableSemanticIndexPersistenceMode;
  readonly lexicalAvailable: true;
  readonly vectorAvailable: false;
  readonly nativeRuntime: false;
  readonly storageProfile: SemanticStorageProfile;
  readonly scaleLimits: PortableSemanticIndexScaleLimits;
  readonly degradationReasons: string[];
}

export interface PortableSemanticIndexAdapters {
  readonly lexicalIndex: LexicalIndexAdapter;
  readonly vectorIndex: VectorIndexAdapter;
  readonly storageProfile: SemanticStorageProfileAdapter;
  readonly maintenance: PortableSemanticIndexMaintenanceAdapter;
  describe(): Promise<PortableSemanticIndexDescription>;
}

export interface PortableSemanticIndexOptions {
  readonly storage: PortableSemanticIndexStorage;
  readonly maxRecommendedDocuments?: number;
  readonly maxRecommendedTokensPerDocument?: number;
}
