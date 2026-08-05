/**
 * adapters/index.ts — barrel re-export of all adapter interfaces and schemas.
 *
 * Core adapter contracts (7 mandatory + 5 optional):
 *   Mandatory: fs, versioning, snapshotStore, lockProvider,
 *              emitter, codeIntelligence, secretScanner
 *   Optional:  staticAnalysis, embedding, vectorStore, anomalyDetector, summarizer
 */

export type { HoplonFsAdapter } from './fs.js';
export type { VersioningAdapter } from './versioning.js';
export { SnapshotRecordSchema } from './snapshotStore.js';
export type { SnapshotRecord, SnapshotStore } from './snapshotStore.js';
export type { Release, LockProvider } from './lock.js';
export { createAsyncMutexLockProvider } from './lock-async-mutex.js';
export type { AsyncMutexLockProvider } from './lock-async-mutex.js';
export { createPerProjectLockProvider } from './lock-per-project.js';
export type { PerProjectLockProviderOptions } from './lock-per-project.js';
export { HoplonEventSchema } from './emitter.js';
export type { HoplonEvent, HoplonEmitter } from './emitter.js';
export { createNoopEmitter } from './emitter/noop.js';
export { createConsoleEmitter } from './emitter/console.js';
export type { ConsoleEmitterOptions } from './emitter/console.js';
export { createMemoryEmitter } from './emitter/memory.js';
export type { MemoryEmitter } from './emitter/memory.js';
export { assertEventIsContentFree } from './emitter/assert.js';
export { createOtelEmitter } from './emitter/otel.js';
export type { OtelEmitterOptions } from './emitter/otel.js';
export { SecretFindingSchema } from './secretScanner.js';
export type { SecretFinding, SecretScannerAdapter } from './secretScanner.js';
export { createBuiltinRegexScanner } from './secretScanner/builtin.js';
export type { BuiltinRegexScannerOptions } from './secretScanner/builtin.js';
export { BUILTIN_PATTERNS } from './secretScanner/patterns.js';
export type { BuiltinPattern } from './secretScanner/patterns.js';
export { createGitleaksSecretScanner } from './secretScanner/gitleaks.js';
export type {
  GitleaksFinding,
  GitleaksProvider,
  GitleaksScannerOptions,
} from './secretScanner/gitleaks.js';
export { createMockGitleaksProvider } from './secretScanner/mockGitleaksProvider.js';
export type { MockFileFixture } from './secretScanner/mockGitleaksProvider.js';
export type {
  SyntaxTree,
  Symbol,
  Reference,
  Diagnostic,
  Location,
  CallHierarchy,
  CodeIntelligenceAdapter,
} from './codeIntelligence.js';
export type { AnalysisFinding, StaticAnalysisAdapter } from './staticAnalysis.js';
export { createNoopAnalyzer } from './staticAnalysis/noop.js';
export type { EmbeddingAdapter } from './embedding.js';
export { createNoopEmbedding } from './embedding.js';
export { createHashingTextEmbedding } from './embedding/hashing.js';
export type { HashingTextEmbeddingOptions } from './embedding/hashing.js';
export type { VectorRecord, VectorSearchResult, VectorStoreAdapter } from './vectorStore.js';
export { createNoopVectorStore } from './vectorStore.js';
export { createInMemoryVectorStore } from './vectorStore/inMemory.js';
export type {
  EmbeddingCacheAdapter,
  EmbeddingCacheLookupResult,
  EmbeddingCacheRecord,
  EmbeddingCacheWriteResult,
} from './embeddingCache.js';
export { createNoopEmbeddingCache } from './embeddingCache.js';
export type {
  LexicalIndexAdapter,
  LexicalIndexDocument,
  LexicalIndexMatch,
  LexicalIndexResult,
} from './lexicalIndex.js';
export { createNoopLexicalIndex } from './lexicalIndex.js';
export type {
  SemanticDocument,
  SemanticDocumentBuilderAdapter,
  SemanticDocumentBuildInput,
  SemanticDocumentBuildResult,
} from './semanticDocumentBuilder.js';
export { createNoopSemanticDocumentBuilder } from './semanticDocumentBuilder.js';
export type {
  SemanticIndexDocument,
  SemanticIndexLookupResult,
  SemanticIndexStoreAdapter,
  SemanticIndexWriteResult,
} from './semanticIndexStore.js';
export { createNoopSemanticIndexStore } from './semanticIndexStore.js';
export type {
  SemanticStorageProfile,
  SemanticStorageProfileAdapter,
} from './semanticStorageProfile.js';
export { createNoopSemanticStorageProfile } from './semanticStorageProfile.js';
export type {
  VectorIndexAdapter,
  VectorIndexMatch,
  VectorIndexRecord,
  VectorIndexResult,
} from './vectorIndex.js';
export { createNoopVectorIndex } from './vectorIndex.js';
export type {
  ProjectMetrics,
  AnomalyScore,
  AnomalySignal,
  AnomalyMetricName,
  AnomalyDetectorAdapter,
  AnomalyDetectorInput,
  StatisticalAnomalyDetectorOptions,
} from './anomalyDetector.js';
export {
  createNoopAnomalyDetector,
  createStatisticalAnomalyDetector,
  computeStatisticalAnomalyScore,
} from './anomalyDetector.js';
export type {
  PredictorInput,
  ViolationPredictorAdapter,
  BaseRateViolationPredictorOptions,
} from './violationPredictor.js';
export {
  createNoopViolationPredictor,
  createBaseRateViolationPredictor,
  computeBaseRatePrediction,
} from './violationPredictor.js';
export type { SummarizerInput, SummarizerOutput, SummarizerAdapter } from './summarizer.js';
export { createNoopSummarizer } from './summarizer.js';
export type {
  BehaviorTestRunRequest,
  BehaviorTestRunnerAdapter,
  BehaviorTestRunnerAvailability,
  BehaviorTestRunOutcome,
  StubBehaviorTestRunnerFixture,
  StubBehaviorTestRunnerOptions,
} from './behaviorTestRunner.js';
export {
  createNoopBehaviorTestRunner,
  createStubBehaviorTestRunner,
  createEmptyEvidence,
  createNotRunExitStatus,
} from './behaviorTestRunner.js';
export type {
  DlpAdapter,
  DlpScanInput,
  MockDlpRule,
  MockPatternDlpAdapterOptions,
} from './dlp.js';
export { createNoopDlpAdapter, createMockPatternDlpAdapter } from './dlp.js';
export { createTreeSitterIntelligence, detectLanguage, charPosToBytePos } from './codeIntelligence/treeSitter.js';
export type {
  TreeSitterIntelligenceOptions,
  RefinedSyntaxTree,
  RefinedSyntaxNode,
} from './codeIntelligence/treeSitter.js';
export { createTreeSitterIntelligenceWithPool } from './codeIntelligence/treeSitterPooled.js';
export type { TreeSitterPooledOptions } from './codeIntelligence/treeSitterPooled.js';
export { createLspCodeIntelligence } from './codeIntelligence/lsp.js';
export type {
  LspProvider,
  LspSignature,
  LspImportResolution,
  LspReference,
  LspCodeIntelligenceOptions,
} from './codeIntelligence/lsp.js';
export { createMockLspProvider } from './codeIntelligence/mockLspProvider.js';
export type {
  MockLspProviderOptions,
  SignatureFixtures,
  ImportFixtures,
  ReferenceFixtures,
  PositionSignatureFixtures,
} from './codeIntelligence/mockLspProvider.js';
export { createFullscopeCodeIntelligence } from './codeIntelligence/fullscope.js';
export type {
  FullscopeProvider,
  FullscopeReference,
  FullscopeCodeIntelligenceOptions,
} from './codeIntelligence/fullscope.js';
export { FullscopeProviderUnavailableError } from './codeIntelligence/fullscope.js';
export { createMockFullscopeProvider } from './codeIntelligence/mockFullscopeProvider.js';
export type {
  MockFullscopeProviderOptions,
  FullscopeReferenceFixtures,
} from './codeIntelligence/mockFullscopeProvider.js';
export {
  createSqliteSnapshotStore,
  createIsolatedTestStore,
} from './snapshot-store-sqlite.js';
export { createPostgresSnapshotStore } from './snapshotStore/postgres.js';
export type { PostgresSnapshotStoreOptions } from './snapshotStore/postgres.js';
export type { TraceStore, TraceSearchFilters, TraceExportBundle } from './traceStore.js';
export { createInMemoryTraceStore } from './trace-store-memory.js';
export { createSqliteTraceStore, createInMemorySqliteTraceStore } from './trace-store-sqlite.js';
export { createPostgresTraceStore, createIsolatedPgTestTraceStore } from './traceStore/postgres.js';
export type { PostgresTraceStoreOptions } from './traceStore/postgres.js';
export { createNodeFsAdapter } from './fs/node.js';
export type { NodeFsAdapterOptions } from './fs/node.js';
export { createMemFsAdapter } from './fs/memfs.js';
export { createIsomorphicGitVersioning } from './versioning/isomorphicGit.js';
export type { IsomorphicGitFsShim, IsomorphicGitStat } from './versioning/fsShim.js';
export { createRedisRedlockProvider } from './lockProvider/redisRedlock.js';
export type {
  LostLockInfo,
  RedisRedlockOptions,
  RedisClient,
} from './lockProvider/redisRedlock.js';
export {
  createSubFileAstLockProvider,
  astNodeLockKey,
  lockAstRegion,
  lockAstRegionMulti,
  buildOverlapKeySet,
} from './lockProvider/subFileAst.js';
export type {
  SubFileAstLockProviderOptions,
  AstNodeDescriptor,
} from './lockProvider/subFileAst.js';
