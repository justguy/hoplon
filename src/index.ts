/**
 * @phalanx/hoplon — public re-export barrel.
 *
 * Phase 1: contracts, adapter interfaces, engine factory.
 * Adapter implementations (C1–C8) re-exported here after their slices land.
 *
 * Per INTEGRATION.md § 2, consumers import:
 *   - Values (error classes, factory functions): direct import
 *   - Pure types: `import type { ... }`
 */

// Contracts (schemas + inferred types)
export * from './hoplon/contracts/index.js';

// Adapter interfaces + Phase 1/2 default adapter factories
// (createNodeFsAdapter, createMemFsAdapter, createIsomorphicGitVersioning,
//  createSqliteSnapshotStore, createIsolatedTestStore, createAsyncMutexLockProvider,
//  createNoopEmitter, createConsoleEmitter, createMemoryEmitter,
//  assertEventIsContentFree, createTreeSitterIntelligence, detectLanguage,
//  charPosToBytePos, createTreeSitterIntelligenceWithPool, createBuiltinRegexScanner,
//  BUILTIN_PATTERNS, createNoopAnalyzer,
//  createNoopEmbedding, createNoopVectorStore, createNoopAnomalyDetector)
export * from './hoplon/adapters/index.js';

// Engine factory and types
export { createHoplonEngine, createDefaultHoplonEngine } from './hoplon/engine/factory.js';
export type { SemanticRuntimeAdapters } from './hoplon/engine/factory.js';
export type {
  HoplonEngine,
  HoplonAdapters,
  HoplonEngineConfig,
} from './hoplon/engine/types.js';

// Phase 2 Stage D concurrency primitives — W1 parser pool + W4 engine pool
// (createParserPool, createHoplonEnginePool, pool types)
export * from './hoplon/concurrency/index.js';

// Phase 3 Stage A — TR1: transport contracts
// TransportError, HoplonEngineTransport, serializeRequest, deserializeResponse
export * from './hoplon/transport/index.js';

// Opt-in dynamic authorization clients. Hosts may inject these into
// OpaAuthorizationAdapter; defaults remain StaticAuthorizationAdapter.
export { ControlPlaneActiveGrantClient } from './hoplon/authorization/controlPlaneActiveGrantClient.js';
export type { ControlPlaneActiveGrantClientDeps } from './hoplon/authorization/controlPlaneActiveGrantClient.js';
export { HttpOpaClient } from './hoplon/authorization/httpOpaClient.js';
export type { HttpOpaClientDeps } from './hoplon/authorization/httpOpaClient.js';

// Opt-in RBAA v1 authorization compatibility binding. This is exported for
// hosts that explicitly inject an AuthorizationAdapter; launcher defaults
// remain static when no adapter is supplied.
export { RbaaAuthorizationAdapter } from './hoplon/authorization/rbaaAuthorizationAdapter.js';
export type { RbaaAuthorizationAdapterDeps } from './hoplon/authorization/rbaaAuthorizationAdapter.js';
export {
  DEFAULT_RBAA_OPA_DECISION_PATH,
  RBAA_HOST_PROFILES,
  RbaaOpaAuthorizationClient,
} from './hoplon/authorization/rbaaAuthorizationClient.js';
export type {
  RbaaActiveGrantProvider,
  RbaaActiveGrantsResult,
  RbaaAuthorizationClient,
  RbaaAuthorizationClientResult,
  RbaaHostProfile,
  RbaaOpaAuthorizationClientDeps,
  RbaaRiskFactsProvider,
  RbaaRiskFactsResult,
} from './hoplon/authorization/rbaaAuthorizationClient.js';

// MCP wrapper — createHoplonMcpServer + transport helpers
// createHoplonMcpServer, McpServerOptions,
// createStdioTransport, createHttpSseTransport, HttpSseServer
export * from './hoplon/mcp/index.js';

// Local launcher surface (t-044) — runStatus, runMcpServe, runHttpServe,
// runCli, parseCli, resolveLauncherWorkspace. Thin wrappers over the
// engine + MCP + HTTP surfaces above; no new core semantics.
export * from './hoplon/launcher/index.js';

// Edit session contract (t-045) — host-owned orchestration over the
// ordered Hoplon self-edit loop. Pure wrapper over engine operations;
// no retry, escalation, or policy lives here.
export * from './hoplon/session/index.js';

// Error classes (values — not type-only, need to be callable)
// Already exported via contracts/index.ts above, but re-listed for clarity:
// HoplonError, EngineError, AdapterError, SemanticError, ValidationError

// Pure utilities — convergence telemetry (Track CV), canonical forms, and
// other util exports.
// measureConvergence, emitConvergenceEvent, ConvergenceMetrics, canonicalForm
export { measureConvergence, emitConvergenceEvent } from './hoplon/util/convergence.js';
export type { ConvergenceMetrics } from './hoplon/util/convergence.js';
export { canonicalForm } from './hoplon/util/canonicalForm.js';
export type { CanonicalFormMode, SerializedCanonicalForm } from './hoplon/util/canonicalForm.js';

// ML5 — retry dedup via structural equivalence (canonical-form hash)
// computeCandidateHash, dedupRetryAttempts, RetryCandidate, ParseFn, DetectLangFn
export { computeCandidateHash, dedupRetryAttempts } from './hoplon/util/retryDedup.js';
export type { RetryCandidate, ParseFn, DetectLangFn } from './hoplon/util/retryDedup.js';

// t-040 — Multi-agent AST merge
// mergeAstEdits, AstEdit, ConflictDescriptor, MergeResult, MergeAstEditsOptions
export { mergeAstEdits } from './hoplon/util/astMerge.js';
export type {
  AstEdit,
  ConflictDescriptor,
  MergeResult,
  MergeResultSuccess,
  MergeResultConflict,
  MergeAstEditsOptions,
} from './hoplon/util/astMerge.js';

// t-032 — Fine-tuning dataset export
// exportFineTuningDataset, writeFineTuningDatasetToFile, projectRunQueryFn,
// defaultQueryFn, FineTuningRecordSchema, FineTuningRecord, ExportFilters, QueryFn
export {
  exportFineTuningDataset,
  writeFineTuningDatasetToFile,
  defaultQueryFn,
  projectRunQueryFn,
  FineTuningRecordSchema,
} from './hoplon/util/fineTuningExport.js';
export type {
  FineTuningRecord,
  ExportFilters,
  ExportOptions,
  WriteOptions,
  QueryFn,
} from './hoplon/util/fineTuningExport.js';
