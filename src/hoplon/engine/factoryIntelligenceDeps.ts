/** Advisory/intelligence dependency assembly for the engine facade. */

import type { FactoryRuntime } from './factoryRuntimeConfig.js';
import type { FactoryCoreDeps } from './factoryCoreDeps.js';
import { packContext } from '../operations/packContext.js';
import { extractStructuralTemplate } from '../operations/extractStructuralTemplate.js';
import { searchSymbols } from '../operations/searchSymbols.js';
import { describeProject } from '../operations/describeProject.js';
import { semanticSearch as semanticSearchOp } from '../operations/semanticSearch.js';
import type { SemanticSearchDeps } from '../operations/semanticSearch.js';
import type { GetRelevantTestsDeps } from '../operations/getRelevantTests.js';
import type { SearchSymbolsDeps } from '../operations/searchSymbols.js';
import type { DescribeProjectDeps } from '../operations/describeProject.js';
import type { SeeCodebaseDeps } from '../operations/seeCodebase.js';
import type { PredictViolationRiskDeps } from '../operations/predictViolationRisk.js';
import type { ScoreAnomalyDeps } from '../operations/scoreAnomaly.js';
import type { AnalyzeBlastRadiusDeps } from '../operations/analyzeBlastRadius.js';
import type { FindReferencingSymbolsDeps } from '../operations/findReferencingSymbols.js';
import type { FindSyntaxNodeDeps } from '../operations/findSyntaxNode.js';
import type { SynthesizeInterfaceStubsDeps } from '../operations/synthesizeInterfaceStubs.js';
import type { EphemeralStructuralSandboxDeps } from '../operations/ephemeralStructuralSandbox.js';
import type { GcDeps } from '../operations/gc.js';
import type { ExtractRollbackTemplateDeps } from '../operations/extractRollbackTemplate.js';

export function buildFactoryIntelligenceDeps(
  runtime: FactoryRuntime,
  core: FactoryCoreDeps,
) {
  const {
    resolvedAdapters,
    engineId,
    fsRoot,
    gitRepoDir,
    maxFileBytes,
    parseTimeoutMs,
    manifestStorageMode,
    embedding,
    vectorStore,
    embeddingCache,
    semanticIndexStore,
    lexicalIndex,
    vectorIndex,
    semanticDocumentBuilder,
    semanticStorageProfile,
    sessionOverlayStore,
    anomalyDetector,
    violationPredictor,
    embeddingProvided,
    vectorStoreProvided,
    embeddingCacheProvided,
    semanticIndexStoreProvided,
    lexicalIndexProvided,
    vectorIndexProvided,
  } = runtime;
  const { packContextDeps, extractStructuralTemplateDeps } = core;

  // LC10: getRelevantTests — static test oracle via import graph BFS.
  const getRelevantTestsDeps: GetRelevantTestsDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: {
      maxFileBytes,
      parseTimeoutMs,
    },
  };

  // t-056: searchSymbols — AST-aware structural search over the project.
  const searchSymbolsDeps: SearchSymbolsDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: { maxFileBytes, parseTimeoutMs },
  };

  // t-056: describeProject — AST-aware project orientation.
  const describeProjectDeps: DescribeProjectDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: { maxFileBytes, parseTimeoutMs },
  };

  // t-061: seeCodebase — unified agent-facing read/search macro. The deps
  // hold pre-bound structural primitives so no second parallel code-path
  // gets built. Raw file read + raw text search live behind the fs adapter.
  const seeCodebaseDeps: SeeCodebaseDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: { maxFileBytes, parseTimeoutMs },
    packContext: (req, signal?) => packContext(packContextDeps, req, signal),
    extractStructuralTemplate: (req, signal?) =>
      extractStructuralTemplate(extractStructuralTemplateDeps, req, signal),
    searchSymbols: (req, signal?) => searchSymbols(searchSymbolsDeps, req, signal),
    describeProject: (req, signal?) => describeProject(describeProjectDeps, req, signal),
  };

  // t-036: advisory-only violation predictor. The engine seam consults the
  // adapter and re-validates output through the ViolationPredictionSchema so an
  // adapter cannot silently return advisory=false. No PASS/BLOCK path reads it.
  const predictViolationRiskDeps: PredictViolationRiskDeps = {
    violationPredictor,
    emitter: resolvedAdapters.emitter,
    engineId,
  };

  // t-037: advisory-only anomaly detector. Same pattern as t-036 — the seam
  // re-validates output through AnomalyScoreSchema so `advisory: true` can
  // never be silently flipped. No PASS/BLOCK path reads it.
  const scoreAnomalyDeps: ScoreAnomalyDeps = {
    anomalyDetector,
    emitter: resolvedAdapters.emitter,
    engineId,
  };

  // t-027: advisory-only blast-radius consumer over the existing
  // CodeIntelligence seam. No threshold override at construction — callers
  // pass warnThreshold on the request or accept the reference default
  // (DEFAULT_BLAST_RADIUS_WARN_THRESHOLD). Surfaced explicitly on the
  // result so it can never be retuned silently.
  const analyzeBlastRadiusDeps: AnalyzeBlastRadiusDeps = {
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
  };

  // t-118: advisory referencing-symbol lookup over the same optional
  // CodeIntelligenceAdapter.findReferences seam used by analyzeBlastRadius.
  // The fs adapter is only used to resolve symbol queries and containing
  // symbols for returned references; no PASS/BLOCK path reads this result.
  const findReferencingSymbolsDeps: FindReferencingSymbolsDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: { maxFileBytes, parseTimeoutMs },
  };

  const findSyntaxNodeDeps: FindSyntaxNodeDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: { maxFileBytes, parseTimeoutMs },
  };

  // t-028: deterministic interface-stub synthesis over manifest-truth
  // SignatureContracts. Pure string transform — no adapter dependency. The
  // operation re-validates its own output through
  // SynthesizeInterfaceStubsResultSchema so the `advisory: true` literal
  // cannot be silently flipped by a future refactor.
  const synthesizeInterfaceStubsDeps: SynthesizeInterfaceStubsDeps = {
    emitter: resolvedAdapters.emitter,
    engineId,
  };

  const ephemeralStructuralSandboxDeps: EphemeralStructuralSandboxDeps = {
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: { parseTimeoutMs },
  };

  // t-034: semantic-search seam. The deps object carries the provider-provided
  // booleans captured above so the operation can surface `status: 'UNAVAILABLE'`
  // whenever the host has not wired both an embedding and a vector store.
  const semanticSearchDeps: SemanticSearchDeps = {
    embedding,
    vectorStore,
    embeddingCache,
    semanticIndexStore,
    lexicalIndex,
    vectorIndex,
    semanticDocumentBuilder,
    semanticStorageProfile,
    emitter: resolvedAdapters.emitter,
    engineId,
    embeddingProvided,
    vectorStoreProvided,
    embeddingCacheProvided,
    semanticIndexStoreProvided,
    lexicalIndexProvided,
    vectorIndexProvided,
    sessionOverlayStore,
    ...(manifestStorageMode === 'hash_only'
      ? { semanticDisabledReason: 'hash_only_manifest_storage' as const }
      : {}),
  };
  getRelevantTestsDeps.semanticSearch = (req, signal?) =>
    semanticSearchOp(semanticSearchDeps, req, signal);
  seeCodebaseDeps.semanticSearch = (req, signal?) =>
    semanticSearchOp(semanticSearchDeps, req, signal);

  const gcDeps: GcDeps = {
    snapshotStore: resolvedAdapters.snapshotStore,
    sessionOverlayStore,
  };

  // LC11: extractRollbackTemplate — composes LC4 in snapshot mode to produce
  // per-file structural skeletons for retry prompt injection after revert.
  const extractRollbackTemplateDeps: ExtractRollbackTemplateDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: {
      maxFileBytes,
      parseTimeoutMs,
      gitRepoDir,
    },
  };

  // -------------------------------------------------------------------------

  return {
    getRelevantTestsDeps,
    searchSymbolsDeps,
    describeProjectDeps,
    seeCodebaseDeps,
    predictViolationRiskDeps,
    scoreAnomalyDeps,
    analyzeBlastRadiusDeps,
    findReferencingSymbolsDeps,
    findSyntaxNodeDeps,
    synthesizeInterfaceStubsDeps,
    ephemeralStructuralSandboxDeps,
    semanticSearchDeps,
    gcDeps,
    extractRollbackTemplateDeps,
  };
}

export type FactoryIntelligenceDeps = ReturnType<
  typeof buildFactoryIntelligenceDeps
>;
