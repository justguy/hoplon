/**
 * launcher/projectAwareEngine.ts — registered-project engine routing helper.
 *
 * The launcher still owns the default workspace engine, but packaged server
 * surfaces also need to honor t-080 registered roots. This wrapper keeps the
 * public HoplonEngine shape unchanged while routing request-bearing methods to
 * the engine for a registered projectId (or the active project when omitted).
 */

import type { HoplonEngine } from '../engine/types.js';
import type { HoplonEngineRouter } from '../concurrency/engineRouter.js';
import type { ProjectRegistry } from '../concurrency/projectRegistry.js';

export interface CreateProjectAwareEngineOptions {
  defaultEngine: HoplonEngine;
  router: HoplonEngineRouter;
  registry: ProjectRegistry;
}

export function createProjectAwareEngine(
  opts: CreateProjectAwareEngineOptions,
): HoplonEngine {
  const { defaultEngine, router, registry } = opts;

  async function resolveEngine(req: unknown): Promise<HoplonEngine> {
    if (registry.size() === 0) return defaultEngine;
    const projectId = extractProjectId(req);
    if (projectId !== undefined) {
      const resolved = await router.resolve({ projectId });
      return resolved.engine;
    }
    const active = registry.getActive();
    if (active === null) return defaultEngine;
    const resolved = await router.resolve({});
    return resolved.engine;
  }

  return {
    createSnapshot: async (req, signal) =>
      (await resolveEngine(req)).createSnapshot(req, signal),
    auditDiff: async (req, signal) =>
      (await resolveEngine(req)).auditDiff(req, signal),
    revertUncontracted: async (req, signal) =>
      (await resolveEngine(req)).revertUncontracted(req, signal),
    packContext: async (req, signal) =>
      (await resolveEngine(req)).packContext(req, signal),
    health: (signal) => defaultEngine.health(signal),
    describeCapabilities: async (req, signal) =>
      (await resolveEngine(req)).describeCapabilities(req, signal),
    reconcile: (signal) => defaultEngine.reconcile(signal),
    dryRun: async (req, signal) =>
      (await resolveEngine(req)).dryRun(req, signal),
    preflight: async (req, signal) =>
      (await resolveEngine(req)).preflight(req, signal),
    queryStructure: async (req, signal) =>
      (await resolveEngine(req)).queryStructure(req, signal),
    extractStructuralTemplate: async (req, signal) =>
      (await resolveEngine(req)).extractStructuralTemplate(req, signal),
    gc: async (opts) => (await resolveEngine(opts)).gc(opts),
    compressRetryContext: (attempts) =>
      defaultEngine.compressRetryContext(attempts),
    computeMinimalPatch: (req) => defaultEngine.computeMinimalPatch(req),
    getRelevantTests: async (req, signal) =>
      (await resolveEngine(req)).getRelevantTests(req, signal),
    extractRollbackTemplate: async (req, signal) =>
      (await resolveEngine(req)).extractRollbackTemplate(req, signal),
    searchSymbols: async (req, signal) =>
      (await resolveEngine(req)).searchSymbols(req, signal),
    describeProject: async (req, signal) =>
      (await resolveEngine(req)).describeProject(req, signal),
    findReferencingSymbols: async (req, signal) =>
      (await resolveEngine(req)).findReferencingSymbols(req, signal),
    findSyntaxNode: async (req, signal) =>
      (await resolveEngine(req)).findSyntaxNode(req, signal),
    seeCodebase: async (req, signal) =>
      (await resolveEngine(req)).seeCodebase(req, signal),
    predictViolationRisk: async (req, signal) =>
      (await resolveEngine(req)).predictViolationRisk(req, signal),
    scoreAnomaly: async (req, signal) =>
      (await resolveEngine(req)).scoreAnomaly(req, signal),
    analyzeBlastRadius: async (req, signal) =>
      (await resolveEngine(req)).analyzeBlastRadius(req, signal),
    synthesizeInterfaceStubs: async (req, signal) =>
      (await resolveEngine(req)).synthesizeInterfaceStubs(req, signal),
    semanticSearch: async (req, signal) =>
      (await resolveEngine(req)).semanticSearch(req, signal),
    refreshSemanticOverlay: async (req, signal) =>
      (await resolveEngine(req)).refreshSemanticOverlay(req, signal),
    clearSemanticOverlay: async (req, signal) =>
      (await resolveEngine(req)).clearSemanticOverlay(req, signal),
    indexSemanticCorpus: async (req, signal) =>
      (await resolveEngine(req)).indexSemanticCorpus(req, signal),
    ephemeralStructuralSandbox: async (req, signal) =>
      (await resolveEngine(req)).ephemeralStructuralSandbox(req, signal),
  };
}

function extractProjectId(req: unknown): string | undefined {
  if (req === null || typeof req !== 'object') return undefined;
  const body = req as Record<string, unknown>;
  const direct = body.projectId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const manifest = body.manifest;
  if (manifest !== null && typeof manifest === 'object') {
    const nested = (manifest as Record<string, unknown>).projectId;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}
