/**
 * operations/index.ts — barrel export for engine operations.
 *
 * Operations are engine-internal; they compose adapters but do not own the
 * engine facade. The facade (E1) wires them into the HoplonEngine interface.
 *
 * Consumers should import from the engine facade, not from this barrel directly.
 */

export { packContext } from './packContext.js';
export type { PackContextDeps } from './packContext.js';
export { createSnapshot } from './createSnapshot.js';
export type { CreateSnapshotDeps } from './createSnapshot.js';
export { revertUncontracted, pathMatchesAllowlist } from './revertUncontracted.js';
export type { RevertUncontractedDeps } from './revertUncontracted.js';
export {
  getSnapshotPresence,
  wasPresentAtSnapshot,
  listPostSnapshotPaths,
  listWorkspacePaths,
  normalizeWorkspacePath,
} from './snapshotPresence.js';
export type {
  SnapshotPresence,
  SnapshotPresenceKnown,
  SnapshotPresenceMissing,
} from './snapshotPresence.js';
export { auditDiff, AUDITED_NODE_KINDS } from './auditDiff.js';
export type { AuditDiffDeps } from './auditDiff.js';
export { dryRun } from './dryRun.js';
export type { DryRunDeps } from './dryRun.js';
export { evaluateInvariantBindings } from './invariantBinding.js';
export type { EvaluateInvariantBindingsInput } from './invariantBinding.js';
export { validateImports } from './validateImports.js';
export type { ValidateImportsDeps, ImportCheckResult, ImportCheckStatus } from './validateImports.js';
export { checkSignatures } from './checkSignatures.js';
export type { CheckSignaturesDeps, SignatureCheckResult, SignatureCheckStatus } from './checkSignatures.js';
export { preflight, pathTraversalGate, aggregatePreflightResult } from './preflight.js';
export type { PreflightDeps, PreflightGate, PreflightGateContext } from './preflight.js';
export { checkTargetsGate } from './gates/checkTargets.js';
export { reconcile } from './reconcile.js';
export type { ReconcileDeps } from './reconcile.js';
export { health } from './health.js';
export type { HealthDeps } from './health.js';
export { gc } from './gc.js';
export type { GcDeps } from './gc.js';
export { createGcScheduler } from './gcSnapshot.js';
export type { GcSchedulerHandle, GcSchedulerDeps } from './gcSnapshot.js';
export { queryStructure } from './queryStructure.js';
export type { QueryStructureDeps, CodeIntelligenceAdapterWithLanguages } from './queryStructure.js';
export {
  extractStructuralTemplate,
  STD_QUERY_TYPES,
  DEFAULT_TEMPLATE_QUERY_ID,
} from './extractStructuralTemplate.js';
export type { ExtractStructuralTemplateDeps } from './extractStructuralTemplate.js';
export { compressRetryContext } from './compressRetryContext.js';
export { computeMinimalPatch } from './computeMinimalPatch.js';
export { getRelevantTests } from './getRelevantTests.js';
export type { GetRelevantTestsDeps } from './getRelevantTests.js';
export { extractRollbackTemplate, DEFAULT_INJECTION_HINT } from './extractRollbackTemplate.js';
export type { ExtractRollbackTemplateDeps } from './extractRollbackTemplate.js';
export { searchSymbols } from './searchSymbols.js';
export type { SearchSymbolsDeps } from './searchSymbols.js';
export { describeProject } from './describeProject.js';
export type { DescribeProjectDeps } from './describeProject.js';
export { seeCodebase } from './seeCodebase.js';
export type { SeeCodebaseDeps } from './seeCodebase.js';
export { analyzeBlastRadius } from './analyzeBlastRadius.js';
export type { AnalyzeBlastRadiusDeps } from './analyzeBlastRadius.js';
export { findReferencingSymbols } from './findReferencingSymbols.js';
export type { FindReferencingSymbolsDeps } from './findReferencingSymbols.js';
export { findSyntaxNode } from './findSyntaxNode.js';
export type { FindSyntaxNodeDeps } from './findSyntaxNode.js';
export { synthesizeInterfaceStubs } from './synthesizeInterfaceStubs.js';
export type { SynthesizeInterfaceStubsDeps } from './synthesizeInterfaceStubs.js';
export { ephemeralStructuralSandbox } from './ephemeralStructuralSandbox.js';
export type { EphemeralStructuralSandboxDeps } from './ephemeralStructuralSandbox.js';
export { runRegressionBisect } from './regressionBisect.js';
export type { RunRegressionBisectInput } from './regressionBisect.js';
export { buildSemanticIndexBoundaryDocuments } from './semanticIndexBoundary.js';
export { buildIndexSemanticCorpusRequestFromBoundary } from './semanticProjectCorpus.js';
export type {
  SemanticIndexBoundaryDeps,
  SemanticIndexBoundaryDocument,
  SemanticIndexBoundaryRequest,
  SemanticIndexBoundaryResult,
} from './semanticIndexBoundary.js';
export type {
  ProjectSemanticCorpusBuildOptions,
  ProjectSemanticCorpusBuildResult,
} from './semanticProjectCorpus.js';
export {
  EXTRACT_FUNCTION_SIGNATURES_JS,
  EXTRACT_FUNCTION_SIGNATURES_TS,
  EXTRACT_FUNCTION_SIGNATURES_TSX,
  EXTRACT_EXPORTS_JS,
  EXTRACT_EXPORTS_TS,
  EXTRACT_EXPORTS_TSX,
  EXTRACT_IMPORTS_JS,
  EXTRACT_IMPORTS_TS,
  EXTRACT_IMPORTS_TSX,
  EXTRACT_CLASS_METHODS_JS,
  EXTRACT_CLASS_METHODS_TS,
  EXTRACT_CLASS_METHODS_TSX,
  STD_QUERY_FUNCTION_SIGNATURES,
  STD_QUERY_EXPORTS,
  STD_QUERY_IMPORTS,
  STD_QUERY_CLASS_METHODS,
} from './stdQueries.js';
