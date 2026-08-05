/**
 * operations/semanticSearch.ts — public compatibility module.
 *
 * The implementation is split so cache/indexing and query freshness logic stay
 * readable while the shipped `indexSemanticCorpus` and `semanticSearch` exports
 * remain the public compatibility anchor.
 */

export { indexSemanticCorpus } from './semanticIndexCorpus.js';
export { indexSemanticRefs } from './semanticRefIndexing.js';
export { semanticSearch } from './semanticSearchQuery.js';
export {
  clearSemanticOverlay,
  createInMemorySemanticSessionOverlayStore,
  refreshSemanticOverlay,
} from './semanticSessionOverlay.js';
export type { SemanticSearchDeps } from './semanticSearchShared.js';
export type {
  SemanticRefIndexingDeps,
  SemanticRefIndexingRequest,
  SemanticRefIndexingResult,
} from './semanticRefIndexing.js';
