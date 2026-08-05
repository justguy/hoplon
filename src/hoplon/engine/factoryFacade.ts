/** Engine facade wiring over already-built dependency bundles. */

import type { HoplonEngine } from './types.js';
import type { FactoryCoreDeps } from './factoryCoreDeps.js';
import type { FactoryIntelligenceDeps } from './factoryIntelligenceDeps.js';
import type { ReconcileDeps } from '../operations/reconcile.js';
import { packContext } from '../operations/packContext.js';
import { createSnapshot } from '../operations/createSnapshot.js';
import { auditDiff } from '../operations/auditDiff.js';
import { dryRun } from '../operations/dryRun.js';
import { preflight } from '../operations/preflight.js';
import { revertUncontracted } from '../operations/revertUncontracted.js';
import { queryStructure } from '../operations/queryStructure.js';
import { extractStructuralTemplate } from '../operations/extractStructuralTemplate.js';
import { health as healthOp } from '../operations/health.js';
import { describeCapabilities as describeCapabilitiesOp } from '../operations/describeCapabilities.js';
import { reconcile as reconcileOp } from '../operations/reconcile.js';
import { gc as gcOp } from '../operations/gc.js';
import { compressRetryContext } from '../operations/compressRetryContext.js';
import { computeMinimalPatch } from '../operations/computeMinimalPatch.js';
import { getRelevantTests } from '../operations/getRelevantTests.js';
import { extractRollbackTemplate } from '../operations/extractRollbackTemplate.js';
import { searchSymbols } from '../operations/searchSymbols.js';
import { describeProject } from '../operations/describeProject.js';
import { seeCodebase } from '../operations/seeCodebase.js';
import { predictViolationRisk as predictViolationRiskOp } from '../operations/predictViolationRisk.js';
import { scoreAnomaly as scoreAnomalyOp } from '../operations/scoreAnomaly.js';
import { analyzeBlastRadius as analyzeBlastRadiusOp } from '../operations/analyzeBlastRadius.js';
import { findReferencingSymbols as findReferencingSymbolsOp } from '../operations/findReferencingSymbols.js';
import { findSyntaxNode as findSyntaxNodeOp } from '../operations/findSyntaxNode.js';
import { synthesizeInterfaceStubs as synthesizeInterfaceStubsOp } from '../operations/synthesizeInterfaceStubs.js';
import { ephemeralStructuralSandbox as ephemeralStructuralSandboxOp } from '../operations/ephemeralStructuralSandbox.js';
import { semanticSearch as semanticSearchOp, indexSemanticCorpus as indexSemanticCorpusOp } from '../operations/semanticSearch.js';
import { clearSemanticOverlay as clearSemanticOverlayOp, refreshSemanticOverlay as refreshSemanticOverlayOp } from '../operations/semanticSessionOverlay.js';

export function createFactoryFacade(
  core: FactoryCoreDeps,
  intelligence: FactoryIntelligenceDeps,
  reconcileDeps: ReconcileDeps,
): HoplonEngine {
  const {
    packContextDeps,
    createSnapshotDeps,
    auditDiffDeps,
    dryRunDeps,
    preflightDeps,
    revertUncontractedDeps,
    healthDeps,
    describeCapabilitiesDeps,
    queryStructureDeps,
    extractStructuralTemplateDeps,
  } = core;
  const {
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
  } = intelligence;

  const engine: HoplonEngine = {
    packContext: (req, signal?) => packContext(packContextDeps, req, signal),
    createSnapshot: (req, signal?) => createSnapshot(createSnapshotDeps, req, signal),
    auditDiff: (req, signal?) => auditDiff(auditDiffDeps, req, signal),
    dryRun: (req, signal?) => dryRun(dryRunDeps, req, signal),
    preflight: (req, signal?) => preflight(preflightDeps, req, signal),
    revertUncontracted: (req, signal?) => revertUncontracted(revertUncontractedDeps, req, signal),
    queryStructure: (req, signal?) => queryStructure(queryStructureDeps, req, signal),
    extractStructuralTemplate: (req, signal?) =>
      extractStructuralTemplate(extractStructuralTemplateDeps, req, signal),
    health: (signal?) => healthOp(healthDeps, signal),
    describeCapabilities: (req, signal?) =>
      describeCapabilitiesOp(describeCapabilitiesDeps, req, signal),
    reconcile: (signal?) => reconcileOp(reconcileDeps, signal),
    gc: (opts) => gcOp(gcDeps, opts),
    // LC9: synchronous pure-data transform — no deps captured, no closure needed.
    compressRetryContext: (attempts) => compressRetryContext(attempts),
    // LC5: synchronous pure function over data — no deps, no I/O.
    computeMinimalPatch: (req) => computeMinimalPatch(req),
    // LC10: static test oracle — BFS over import graph built from tree-sitter queries.
    getRelevantTests: (req, signal?) => getRelevantTests(getRelevantTestsDeps, req, signal),
    // LC11: rollback template — composes LC4 (extractStructuralTemplate) in snapshot mode.
    extractRollbackTemplate: (req, signal?) =>
      extractRollbackTemplate(extractRollbackTemplateDeps, req, signal),
    // t-056: AST-aware structural search.
    searchSymbols: (req, signal?) => searchSymbols(searchSymbolsDeps, req, signal),
    // t-056: AST-aware project orientation.
    describeProject: (req, signal?) => describeProject(describeProjectDeps, req, signal),
    // t-061: unified agent-facing read/search macro.
    seeCodebase: (req, signal?) => seeCodebase(seeCodebaseDeps, req, signal),
    // t-036: advisory-only violation risk predictor seam.
    predictViolationRisk: (req, signal?) =>
      predictViolationRiskOp(predictViolationRiskDeps, req, signal),
    // t-037: advisory-only anomaly detector seam.
    scoreAnomaly: (req, signal?) => scoreAnomalyOp(scoreAnomalyDeps, req, signal),
    // t-027: advisory-only blast-radius consumer over codeIntelligence.findReferences.
    analyzeBlastRadius: (req, signal?) =>
      analyzeBlastRadiusOp(analyzeBlastRadiusDeps, req, signal),
    // t-118: advisory-only referencing-symbol lookup over the same reference seam.
    findReferencingSymbols: (req, signal?) =>
      findReferencingSymbolsOp(findReferencingSymbolsDeps, req, signal),
    // t-120: advisory-only syntax-node lookup and parser-health sidecar.
    findSyntaxNode: (req, signal?) =>
      findSyntaxNodeOp(findSyntaxNodeDeps, req, signal),
    // t-028: deterministic interface-stub synthesis over manifest-truth
    // SignatureContracts. Pure string transform; no adapter call.
    synthesizeInterfaceStubs: (req, signal?) =>
      synthesizeInterfaceStubsOp(synthesizeInterfaceStubsDeps, req, signal),
    // t-108: in-memory planning macro. No fs/versioning/snapshot/lock deps.
    ephemeralStructuralSandbox: (req, signal?) =>
      ephemeralStructuralSandboxOp(ephemeralStructuralSandboxDeps, req, signal),
    // t-034: first real Layer 1 semantic-search retrieval consumer.
    semanticSearch: (req, signal?) =>
      semanticSearchOp(semanticSearchDeps, req, signal),
    refreshSemanticOverlay: (req, signal?) =>
      refreshSemanticOverlayOp(semanticSearchDeps, req, signal),
    clearSemanticOverlay: (req) =>
      Promise.resolve(clearSemanticOverlayOp(semanticSearchDeps, req)),
    // t-034: project-scoped semantic corpus indexing seam.
    indexSemanticCorpus: (req, signal?) =>
      indexSemanticCorpusOp(semanticSearchDeps, req, signal),
  };

  return engine;
}
