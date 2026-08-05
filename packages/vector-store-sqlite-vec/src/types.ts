export type NativeSemanticStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'EMPTY';
export type NativeSemanticSqlRuntime = 'node:sqlite' | 'unavailable';
export type NativeSemanticVectorRuntime = 'sqlite-vec-native' | 'lexical-only';
export type NativeSemanticRuntimeProfile = 'native_performance';

export type NativeMetadata = Record<string, string | number | boolean>;
export type NativeSourceBranchKind =
  | 'local_branch'
  | 'remote_tracking_branch';
export type NativeSourceStaleState =
  | 'fresh'
  | 'stale'
  | 'unindexed'
  | 'missing';

export interface NativeLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface NativeSourceCommitSnapshot {
  readonly sourceSnapshotId: string;
  readonly projectId: string;
  readonly commitOid: string;
  readonly corpusSchemaVersion: string;
  readonly embeddingProfileHash?: string;
  readonly modelProfileHash?: string;
}

export interface NativeBranchAlias {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly branchName: string;
  readonly branchKind: NativeSourceBranchKind;
  readonly commitOid: string;
  readonly observedAtIso: string;
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  readonly staleState: NativeSourceStaleState;
  readonly remote?: string;
}

export interface NativeChunkIdentity {
  readonly projectId: string;
  readonly sourceSnapshotId: string;
  readonly chunkId: string;
  readonly canonicalPath: string;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly chunkIndex: number;
  readonly lineRange?: NativeLineRange;
  readonly sourceProvenance: {
    readonly commitOid: string;
    readonly branchNames?: readonly string[];
  };
  readonly embeddingCacheKey: string;
}

export interface NativeLexicalIndexDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata: NativeMetadata;
  readonly sourceSnapshot?: NativeSourceCommitSnapshot;
  readonly branchAliases?: readonly NativeBranchAlias[];
  readonly chunkIdentity?: NativeChunkIdentity;
}

export interface NativeVectorIndexRecord {
  readonly id: string;
  readonly vector: number[];
  readonly metadata: NativeMetadata;
  readonly sourceSnapshot?: NativeSourceCommitSnapshot;
  readonly branchAliases?: readonly NativeBranchAlias[];
  readonly chunkIdentity?: NativeChunkIdentity;
}

export interface NativeSemanticMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: NativeMetadata;
}

export interface NativeSemanticIndexResult {
  readonly status: NativeSemanticStatus;
  readonly resultCount: number;
  readonly matches: NativeSemanticMatch[];
  readonly degradationReasons: string[];
}

export interface NativeLexicalIndexAdapter {
  upsert(
    projectId: string,
    documents: readonly NativeLexicalIndexDocument[],
  ): Promise<NativeSemanticIndexResult>;
  search(
    projectId: string,
    query: string,
    topK: number,
  ): Promise<NativeSemanticIndexResult>;
  delete(
    projectId: string,
    documentIds: readonly string[],
  ): Promise<NativeSemanticIndexResult>;
}

export interface NativeVectorIndexAdapter {
  upsert(
    projectId: string,
    records: readonly NativeVectorIndexRecord[],
  ): Promise<NativeSemanticIndexResult>;
  search(
    projectId: string,
    query: readonly number[],
    topK: number,
  ): Promise<NativeSemanticIndexResult>;
  delete(
    projectId: string,
    recordIds: readonly string[],
  ): Promise<NativeSemanticIndexResult>;
}

export interface NodeSqliteVecDescription {
  readonly runtimeProfile: NativeSemanticRuntimeProfile;
  readonly status: Exclude<NativeSemanticStatus, 'EMPTY'>;
  readonly snapshotSqlRuntime: 'not_owned_by_plugin';
  readonly semanticSqlRuntime: NativeSemanticSqlRuntime;
  readonly semanticVectorRuntime: NativeSemanticVectorRuntime;
  readonly lexicalAvailable: boolean;
  readonly vectorAvailable: boolean;
  readonly nativeRuntime: boolean;
  readonly nativeExtensionLoaded: boolean;
  readonly nativeExtensionBinaryHash?: string;
  readonly nativeExtensionPath?: string;
  readonly sqliteVecVersion?: string;
  readonly fts5Available: boolean;
  readonly walMode?: string;
  readonly busyTimeoutMs?: number;
  readonly vectorSchemaAvailable: boolean;
  readonly sqlLevelExtensionLoadBlocked: boolean;
  readonly degradationReasons: string[];
}

export interface NodeSqliteVecSemanticIndex {
  readonly lexicalIndex: NativeLexicalIndexAdapter;
  readonly vectorIndex: NativeVectorIndexAdapter;
  describe(): Promise<NodeSqliteVecDescription>;
  close(): Promise<void>;
}

export interface NodeSqliteVecOptions {
  readonly databasePath: string;
  readonly vectorDimension: number;
  readonly expectedExtensionSha256?: string;
  readonly extensionPath?: string;
  readonly sqliteVec?: SqliteVecModule;
  readonly loadNodeSqlite?: () => Promise<NodeSqliteModule>;
}

export interface SqliteVecModule {
  getLoadablePath(): string;
}

export interface NodeSqliteModule {
  readonly DatabaseSync: new (
    path: string,
    options?: { readonly allowExtension?: boolean },
  ) => NodeSqliteDatabase;
}

export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  loadExtension(path: string): void;
  enableLoadExtension(enabled: boolean): void;
  close(): void;
}

export interface NodeSqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
