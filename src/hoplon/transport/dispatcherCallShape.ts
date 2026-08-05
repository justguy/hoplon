import type { HoplonEngine } from '../engine/types.js';

export type DispatchCallShape =
  | 'async_body_signal'
  | 'async_signal_only'
  | 'async_body_no_signal'
  | 'sync_body';

export const DISPATCH_CALL_SHAPE: Readonly<
  Record<keyof HoplonEngine, DispatchCallShape>
> = {
  createSnapshot: 'async_body_signal',
  auditDiff: 'async_body_signal',
  revertUncontracted: 'async_body_signal',
  packContext: 'async_body_signal',
  dryRun: 'async_body_signal',
  preflight: 'async_body_signal',
  queryStructure: 'async_body_signal',
  extractStructuralTemplate: 'async_body_signal',
  extractRollbackTemplate: 'async_body_signal',
  getRelevantTests: 'async_body_signal',
  searchSymbols: 'async_body_signal',
  describeProject: 'async_body_signal',
  predictViolationRisk: 'async_body_signal',
  scoreAnomaly: 'async_body_signal',
  analyzeBlastRadius: 'async_body_signal',
  findReferencingSymbols: 'async_body_signal',
  findSyntaxNode: 'async_body_signal',
  synthesizeInterfaceStubs: 'async_body_signal',
  ephemeralStructuralSandbox: 'async_body_signal',
  describeCapabilities: 'async_body_signal',
  semanticSearch: 'async_body_signal',
  indexSemanticCorpus: 'async_body_signal',
  refreshSemanticOverlay: 'async_body_signal',
  clearSemanticOverlay: 'async_body_signal',
  seeCodebase: 'async_body_signal',
  health: 'async_signal_only',
  reconcile: 'async_signal_only',
  gc: 'async_body_no_signal',
  computeMinimalPatch: 'sync_body',
  compressRetryContext: 'sync_body',
};
