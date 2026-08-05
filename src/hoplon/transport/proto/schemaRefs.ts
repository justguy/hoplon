/**
 * transport/proto/schemaRefs.ts — Zod schema references for GRPC-PG1.
 *
 * The proto registry imports from this file so the operation list can stay
 * below the repo's 300-line file cap while still anchoring every RPC to the
 * canonical contracts.
 */

import { z } from 'zod';

export {
  CreateSnapshotRequestSchema,
  AuditRequestSchema,
  RevertRequestSchema,
  PackContextRequestSchema,
  DryRunRequestSchema,
  PreflightRequestSchema,
} from '../../contracts/requests.js';

export {
  QueryStructureRequestSchema,
  QueryStructureResultSchema,
} from '../../contracts/queryStructure.js';

export {
  ExtractStructuralTemplateRequestSchema,
  StructuralTemplateSchema,
} from '../../contracts/structuralTemplate.js';

export {
  ExtractRollbackTemplateRequestSchema,
  RollbackTemplateSchema,
} from '../../contracts/rollbackTemplate.js';

export {
  ComputeMinimalPatchRequestSchema,
  MinimalPatchSchema,
} from '../../contracts/computeMinimalPatch.js';

export {
  PriorAttemptSchema,
  CompressedRetryContextSchema,
} from '../../contracts/retryContext.js';

export {
  GetRelevantTestsRequestSchema,
  TestOracleResultSchema,
} from '../../contracts/getRelevantTests.js';

export {
  DescribeCapabilitiesRequestSchema,
  DescribeCapabilitiesResultSchema,
} from '../../contracts/capabilities.js';

export {
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
} from '../../contracts/searchSymbols.js';

export {
  DescribeProjectRequestSchema,
  DescribeProjectResultSchema,
} from '../../contracts/describeProject.js';

export {
  SeeCodebaseRequestSchema,
  SeeCodebaseEnvelopeSchema,
} from '../../contracts/seeCodebase.js';

export {
  PredictViolationRiskRequestSchema,
  ViolationPredictionSchema,
} from '../../contracts/violationPredictor.js';

export {
  ScoreAnomalyRequestSchema,
  AnomalyScoreSchema,
} from '../../contracts/anomalyDetector.js';

export {
  AnalyzeBlastRadiusRequestSchema,
  AnalyzeBlastRadiusResultSchema,
} from '../../contracts/blastRadius.js';

export {
  FindReferencingSymbolsRequestSchema,
  FindReferencingSymbolsResultSchema,
} from '../../contracts/referencingSymbols.js';

export {
  SynthesizeInterfaceStubsRequestSchema,
  SynthesizeInterfaceStubsResultSchema,
} from '../../contracts/interfaceStubs.js';

export {
  EphemeralStructuralSandboxRequestSchema,
  EphemeralStructuralSandboxResultSchema,
} from '../../contracts/structuralSandbox.js';

export {
  IndexSemanticCorpusRequestSchema,
  IndexSemanticCorpusResultSchema,
  SemanticOverlayClearRequestSchema,
  SemanticOverlayClearResultSchema,
  SemanticOverlayRefreshRequestSchema,
  SemanticOverlayRefreshResultSchema,
  SemanticSearchRequestSchema,
  SemanticSearchResultSchema,
} from '../../contracts/semanticSearch.js';

export { SnapshotResultSchema } from '../../contracts/snapshot.js';
export { AuditResultSchema } from '../../contracts/audit.js';
export { RevertResultSchema } from '../../contracts/revert.js';
export { PackedContextSchema } from '../../contracts/context.js';
export { EngineHealthSchema } from '../../contracts/health.js';
export { ReconcileReportSchema } from '../../contracts/reconcile.js';
export { PreflightResultSchema } from '../../contracts/preflight.js';
export { GcRequestSchema, GcResultSchema } from '../../contracts/gc.js';

import { PriorAttemptSchema } from '../../contracts/retryContext.js';

export const CompressRetryContextRequestBodySchema = z.array(PriorAttemptSchema);
