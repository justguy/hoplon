/**
 * Public-barrel smoke test — shipped access-surface factories must be reachable
 * from src/index.ts.
 *
 * This guards against a drift where implementation and tests exist on internal
 * paths, but the package barrel fails to expose the supported surface.
 */

import { describe, expect, it } from 'vitest';
import {
  AnalyzeBlastRadiusRequestSchema,
  AnalyzeBlastRadiusResultSchema,
  AdvisoryEvidenceStateSchema,
  AdvisoryIntelligenceSidecarEnvelopeSchema,
  AnomalyScoreSchema,
  DEFAULT_BLAST_RADIUS_WARN_THRESHOLD,
  DEFAULT_DLP_POLICY_MODE,
  DlpFindingSchema,
  DlpPolicyModeSchema,
  FullscopeProviderUnavailableError,
  InterfaceStubSchema,
  SynthesizeInterfaceStubsRequestSchema,
  SynthesizeInterfaceStubsResultSchema,
  ScoreAnomalyRequestSchema,
  DescribeCapabilitiesRequestSchema,
  DescribeCapabilitiesResultSchema,
  DescribeProjectRequestSchema,
  DescribeProjectResultSchema,
  PredictViolationRiskRequestSchema,
  ReadSemanticSearchPayloadSchema,
  ReadStructuralCompressionPayloadSchema,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
  SessionError,
  VerificationSemanticGapSidecarSchema,
  ViolationPredictionSchema,
  WritePreviewAdvisoryIntelligenceSchema,
  createBaseRateViolationPredictor,
  createSampleBackedAdvisoryEvidenceState,
  createHoplonGrpcServer,
  createHoplonEditSession,
  createHoplonHttpServer,
  createHoplonMcpServer,
  createMockFullscopeProvider,
  createMockPatternDlpAdapter,
  createNoopAnomalyDetector,
  createNoopDlpAdapter,
  createNoopViolationPredictor,
  createRemoteHoplonGrpcEngine,
  createRemoteHoplonEngine,
  createStatisticalAnomalyDetector,
  createFullscopeCodeIntelligence,
  createPostgresSnapshotStore,
  parseCli,
  parseQueryCommand,
  resolveLauncherWorkspace,
  runCli,
  runHttpServe,
  runMcpServe,
  runQuery,
  runStatus,
} from '../../src/index.js';

describe('public surface exports', () => {
  it('exports createHoplonHttpServer', () => {
    expect(typeof createHoplonHttpServer).toBe('function');
  });

  it('exports createHoplonGrpcServer', () => {
    expect(typeof createHoplonGrpcServer).toBe('function');
  });

  it('exports createHoplonMcpServer', () => {
    expect(typeof createHoplonMcpServer).toBe('function');
  });

  it('exports createRemoteHoplonEngine', () => {
    expect(typeof createRemoteHoplonEngine).toBe('function');
  });

  it('exports createRemoteHoplonGrpcEngine', () => {
    expect(typeof createRemoteHoplonGrpcEngine).toBe('function');
  });

  it('exports createPostgresSnapshotStore', () => {
    expect(typeof createPostgresSnapshotStore).toBe('function');
  });

  it('exports createFullscopeCodeIntelligence', () => {
    expect(typeof createFullscopeCodeIntelligence).toBe('function');
  });

  it('exports createMockFullscopeProvider', () => {
    expect(typeof createMockFullscopeProvider).toBe('function');
  });

  it('exports FullscopeProviderUnavailableError', () => {
    expect(typeof FullscopeProviderUnavailableError).toBe('function');
    expect(
      new FullscopeProviderUnavailableError('x').code,
    ).toBe('provider_unavailable');
  });

  it('exports runStatus', () => {
    expect(typeof runStatus).toBe('function');
  });

  it('exports runMcpServe', () => {
    expect(typeof runMcpServe).toBe('function');
  });

  it('exports runHttpServe', () => {
    expect(typeof runHttpServe).toBe('function');
  });

  it('exports runCli', () => {
    expect(typeof runCli).toBe('function');
  });

  it('exports parseCli', () => {
    expect(typeof parseCli).toBe('function');
  });

  it('exports runQuery', () => {
    expect(typeof runQuery).toBe('function');
  });

  it('exports parseQueryCommand', () => {
    expect(typeof parseQueryCommand).toBe('function');
  });

  it('exports resolveLauncherWorkspace', () => {
    expect(typeof resolveLauncherWorkspace).toBe('function');
  });

  it('exports createHoplonEditSession', () => {
    expect(typeof createHoplonEditSession).toBe('function');
  });

  it('exports SessionError', () => {
    expect(typeof SessionError).toBe('function');
  });

  it('exports DescribeCapabilitiesRequestSchema', () => {
    expect(DescribeCapabilitiesRequestSchema).toBeDefined();
  });

  it('exports DescribeCapabilitiesResultSchema', () => {
    expect(DescribeCapabilitiesResultSchema).toBeDefined();
  });

  it('exports SearchSymbolsRequestSchema', () => {
    expect(SearchSymbolsRequestSchema).toBeDefined();
  });

  it('exports SearchSymbolsResultSchema', () => {
    expect(SearchSymbolsResultSchema).toBeDefined();
  });

  it('exports DescribeProjectRequestSchema', () => {
    expect(DescribeProjectRequestSchema).toBeDefined();
  });

  it('exports DescribeProjectResultSchema', () => {
    expect(DescribeProjectResultSchema).toBeDefined();
  });

  it('exports ScoreAnomalyRequestSchema', () => {
    expect(ScoreAnomalyRequestSchema).toBeDefined();
  });

  it('exports AnomalyScoreSchema', () => {
    expect(AnomalyScoreSchema).toBeDefined();
  });

  it('exports createNoopAnomalyDetector', () => {
    expect(typeof createNoopAnomalyDetector).toBe('function');
  });

  it('exports createStatisticalAnomalyDetector', () => {
    expect(typeof createStatisticalAnomalyDetector).toBe('function');
  });

  it('exports PredictViolationRiskRequestSchema', () => {
    expect(PredictViolationRiskRequestSchema).toBeDefined();
  });

  it('exports ViolationPredictionSchema', () => {
    expect(ViolationPredictionSchema).toBeDefined();
  });

  it('exports createNoopViolationPredictor', () => {
    expect(typeof createNoopViolationPredictor).toBe('function');
  });

  it('exports createBaseRateViolationPredictor', () => {
    expect(typeof createBaseRateViolationPredictor).toBe('function');
  });

  it('exports AnalyzeBlastRadiusRequestSchema', () => {
    expect(AnalyzeBlastRadiusRequestSchema).toBeDefined();
  });

  it('exports AnalyzeBlastRadiusResultSchema', () => {
    expect(AnalyzeBlastRadiusResultSchema).toBeDefined();
  });

  it('exports DEFAULT_BLAST_RADIUS_WARN_THRESHOLD', () => {
    expect(DEFAULT_BLAST_RADIUS_WARN_THRESHOLD).toBe(10);
  });

  it('exports SynthesizeInterfaceStubsRequestSchema', () => {
    expect(SynthesizeInterfaceStubsRequestSchema).toBeDefined();
  });

  it('exports SynthesizeInterfaceStubsResultSchema', () => {
    expect(SynthesizeInterfaceStubsResultSchema).toBeDefined();
  });

  it('exports InterfaceStubSchema', () => {
    expect(InterfaceStubSchema).toBeDefined();
  });

  it('exports DlpFindingSchema', () => {
    expect(DlpFindingSchema).toBeDefined();
  });

  it('exports AdvisoryIntelligenceSidecarEnvelopeSchema', () => {
    expect(AdvisoryIntelligenceSidecarEnvelopeSchema).toBeDefined();
  });

  it('exports AdvisoryEvidenceStateSchema', () => {
    expect(AdvisoryEvidenceStateSchema).toBeDefined();
  });

  it('exports createSampleBackedAdvisoryEvidenceState', () => {
    expect(typeof createSampleBackedAdvisoryEvidenceState).toBe('function');
  });

  it('exports read advisory intelligence schemas', () => {
    expect(ReadStructuralCompressionPayloadSchema).toBeDefined();
    expect(ReadSemanticSearchPayloadSchema).toBeDefined();
  });

  it('exports write-preview advisory intelligence schema', () => {
    expect(WritePreviewAdvisoryIntelligenceSchema).toBeDefined();
  });

  it('exports verification semantic-gap intelligence schema', () => {
    expect(VerificationSemanticGapSidecarSchema).toBeDefined();
  });

  it('exports DlpPolicyModeSchema', () => {
    expect(DlpPolicyModeSchema).toBeDefined();
  });

  it('exports DEFAULT_DLP_POLICY_MODE as "warn"', () => {
    expect(DEFAULT_DLP_POLICY_MODE).toBe('warn');
  });

  it('exports createNoopDlpAdapter', () => {
    expect(typeof createNoopDlpAdapter).toBe('function');
  });

  it('exports createMockPatternDlpAdapter', () => {
    expect(typeof createMockPatternDlpAdapter).toBe('function');
  });
});
