import type { HoplonEngine } from '../../engine/types.js';
import { EngineError } from '../../contracts/errors.js';
import { AnalyzeBlastRadiusRequestSchema, AnalyzeBlastRadiusResultSchema } from '../../contracts/blastRadius.js';
import { AnomalyScoreSchema, ScoreAnomalyRequestSchema } from '../../contracts/anomalyDetector.js';
import { EphemeralStructuralSandboxRequestSchema, EphemeralStructuralSandboxResultSchema } from '../../contracts/structuralSandbox.js';
import { FindReferencingSymbolsRequestSchema, FindReferencingSymbolsResultSchema } from '../../contracts/referencingSymbols.js';
import { PredictViolationRiskRequestSchema, ViolationPredictionSchema } from '../../contracts/violationPredictor.js';
import { SeeCodebaseEnvelopeSchema, SeeCodebaseRequestSchema } from '../../contracts/seeCodebase.js';
import {
  IndexSemanticCorpusRequestSchema,
  IndexSemanticCorpusResultSchema,
  SemanticOverlayClearRequestSchema,
  SemanticOverlayClearResultSchema,
  SemanticOverlayRefreshRequestSchema,
  SemanticOverlayRefreshResultSchema,
  SemanticSearchRequestSchema,
  SemanticSearchResultSchema,
} from '../../contracts/semanticSearch.js';
import { SynthesizeInterfaceStubsRequestSchema, SynthesizeInterfaceStubsResultSchema } from '../../contracts/interfaceStubs.js';
import type { RemoteClientContext } from './clientDispatch.js';

type AdvisoryRemoteMethods = Pick<
  HoplonEngine,
  | 'predictViolationRisk'
  | 'scoreAnomaly'
  | 'analyzeBlastRadius'
  | 'findReferencingSymbols'
  | 'findSyntaxNode'
  | 'synthesizeInterfaceStubs'
  | 'ephemeralStructuralSandbox'
  | 'indexSemanticCorpus'
  | 'semanticSearch'
  | 'refreshSemanticOverlay'
  | 'clearSemanticOverlay'
  | 'seeCodebase'
>;

function correlationId(req: { correlationId?: string }): string {
  return req.correlationId ?? 'unknown';
}

export function createRemoteAdvisoryMethods(
  client: RemoteClientContext,
): AdvisoryRemoteMethods {
  const post = client.post.bind(client);
  return {
    predictViolationRisk: (req, signal) =>
      post('predictViolationRisk', PredictViolationRiskRequestSchema, ViolationPredictionSchema, req, signal, correlationId(req)),
    scoreAnomaly: (req, signal) =>
      post('scoreAnomaly', ScoreAnomalyRequestSchema, AnomalyScoreSchema, req, signal, correlationId(req)),
    analyzeBlastRadius: (req, signal) =>
      post('analyzeBlastRadius', AnalyzeBlastRadiusRequestSchema, AnalyzeBlastRadiusResultSchema, req, signal, correlationId(req)),
    findReferencingSymbols: (req, signal) =>
      post('findReferencingSymbols', FindReferencingSymbolsRequestSchema, FindReferencingSymbolsResultSchema, req, signal, correlationId(req)),
    findSyntaxNode: (req) => {
      throw new EngineError(
        {
          kind: 'remote_not_supported',
          engineId: client.resolved.engineId,
          correlationId: correlationId(req),
        },
        'findSyntaxNode is exposed through the in-process engine and MCP until a future transport slice exposes it.',
      );
    },
    synthesizeInterfaceStubs: (req, signal) =>
      post('synthesizeInterfaceStubs', SynthesizeInterfaceStubsRequestSchema, SynthesizeInterfaceStubsResultSchema, req, signal, correlationId(req)),
    ephemeralStructuralSandbox: (req, signal) =>
      post('ephemeralStructuralSandbox', EphemeralStructuralSandboxRequestSchema, EphemeralStructuralSandboxResultSchema, req, signal, correlationId(req)),
    indexSemanticCorpus: (req, signal) =>
      post('indexSemanticCorpus', IndexSemanticCorpusRequestSchema, IndexSemanticCorpusResultSchema, req, signal, correlationId(req)),
    semanticSearch: (req, signal) =>
      post('semanticSearch', SemanticSearchRequestSchema, SemanticSearchResultSchema, req, signal, correlationId(req)),
    refreshSemanticOverlay: (req, signal) =>
      post('refreshSemanticOverlay', SemanticOverlayRefreshRequestSchema, SemanticOverlayRefreshResultSchema, req, signal, correlationId(req)),
    clearSemanticOverlay: (req, signal) =>
      post('clearSemanticOverlay', SemanticOverlayClearRequestSchema, SemanticOverlayClearResultSchema, req, signal, correlationId(req)),
    seeCodebase: (req, signal) =>
      post('seeCodebase', SeeCodebaseRequestSchema, SeeCodebaseEnvelopeSchema, req, signal, correlationId(req)),
  };
}
