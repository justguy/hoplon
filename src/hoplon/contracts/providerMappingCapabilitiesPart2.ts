import type { ProviderMappingEntry } from './providerMapping.js';
import { capabilityEntry } from './providerMappingCapabilityEntry.js';

export const PROVIDER_MAPPING_CAPABILITIES_PART_2: ProviderMappingEntry[] = [
  capabilityEntry({
    ecosystem: 'violation_prediction',
    ecosystemName: 'Violation risk prediction',
    candidateTools: [
      'base-rate statistical predictors (shipped reference — createBaseRateViolationPredictor)',
      'host-owned gradient-boosted classifiers',
      'ML-model-as-a-service risk scoring APIs',
    ],
    capabilityId: 'violationPredictor',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [{ dataClass: 'audit_evidence', access: 'read_only' }],
    notes:
      't-036: the adapter slot, noop default, and typed engine.predictViolationRisk consumer ship as an advisory-only seam over the already-landed ML2 audit-log columns. A host-wired base-rate predictor is provided as a reference implementation. Output is pinned to advisory=true by schema; promoting it to blocking behavior is a separate slice.',
  }),
  capabilityEntry({
    ecosystem: 'dlp',
    ecosystemName: 'Semantic data-loss prevention',
    candidateTools: [
      'regex/classification rule packs (mock provider ships for proof tests)',
      'host-owned semantic classifiers (PII / financial / healthcare / source code)',
      'managed DLP services (Google DLP, Microsoft Purview, AWS Macie)',
    ],
    capabilityId: 'dlp',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'warning_only',
    failureIsolation: 'advisory_only',
    dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
    notes:
      't-026: adapter slot, noop default, and the createSnapshot seam ship; the secret-scanner path is unchanged. Policy mode defaults to warn — findings surface as content-free possible_dlp_finding warnings. block mode is opt-in only and rejects the commit before Phase B git commit with ValidationError({dlp_policy_block}). Host-owned and managed DLP services bind through the same seam without any core PASS/BLOCK change to auditDiff.',
  }),
  capabilityEntry({
    ecosystem: 'blast_radius',
    ecosystemName: 'Advisory blast-radius reporting',
    candidateTools: [
      'tree-sitter (shipped default — no findReferences)',
      'LSP servers exposing textDocument/references',
      'SCIP indexes',
      'Fullscope / tpf-mcp',
    ],
    capabilityId: 'blastRadius',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'workspace_metadata', access: 'read_only' },
    ],
    notes:
      't-027: typed engine.analyzeBlastRadius consumer ships as an advisory-only seam over the existing CodeIntelligenceAdapter.findReferences slot. The shipped tree-sitter default does not implement findReferences, so the operation returns status=UNAVAILABLE with every entry classified missing_provider; it never throws and never fabricates counts. LSP / SCIP / Fullscope adapters enable the real report through the same seam. Output is pinned to advisory=true by schema; no PASS/BLOCK surface consults it.',
  }),
  capabilityEntry({
    ecosystem: 'summarization',
    ecosystemName: 'Summarization',
    candidateTools: [
      'LLM-backed summarizers (host-owned)',
      'extractive summarizers',
    ],
    capabilityId: 'summarizer',
    runtimeState: 'seam_only',
    invocationMode: 'host_invoked',
    sideEffectPosture: 'none',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'audit_evidence', access: 'read_only' },
      { dataClass: 'host_objective', access: 'read_only' },
    ],
    notes:
      'The Summarizer adapter slot and noop default are shipped. Any LLM-backed summary path is host-owned; Hoplon never invokes this seam internally.',
  }),
  capabilityEntry({
    ecosystem: 'version_synced_intelligence',
    ecosystemName: 'Version-synced intelligence metadata',
    candidateTools: [
      'SCIP snapshots',
      'LSP index servers',
      'repo-relative semantic indices',
    ],
    capabilityId: 'versionSyncedIntelligence',
    runtimeState: 'contract_only',
    invocationMode: 'host_invoked',
    sideEffectPosture: 'none',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'snapshot_metadata', access: 'read_only' },
      { dataClass: 'provider_metadata', access: 'read_only' },
    ],
    notes:
      'Revision-aware intelligence metadata is preserved as a contract-only seam. SCIP snapshots and similar offline indices can surface workspace-revision metadata here, but no default provider ships; hosts remain the integration boundary.',
  }),
  capabilityEntry({
    ecosystem: 'semantic_gap_analysis',
    ecosystemName: 'Semantic gap analysis',
    candidateTools: [
      'manifest-diff analyzers',
      'contract-test generators',
      'custom host evaluators',
    ],
    capabilityId: 'semanticGapAnalysis',
    runtimeState: 'contract_only',
    invocationMode: 'explicit_extension_call',
    sideEffectPosture: 'none',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
      { dataClass: 'host_objective', access: 'read_only' },
    ],
    notes:
      'Contract-only plugin seam. Any gap-analysis engine binds through the explicit extension call surface without upgrading advisory results into PASS/BLOCK.',
  }),
  capabilityEntry({
    ecosystem: 'semantic_twins',
    ecosystemName: 'Semantic twins / fix propagation',
    candidateTools: [
      'cross-repo semantic linkers',
      'host-owned fix propagation services',
    ],
    capabilityId: 'semanticTwins',
    runtimeState: 'contract_only',
    invocationMode: 'explicit_extension_call',
    sideEffectPosture: 'none',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'snapshot_metadata', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
    ],
    notes:
      'Contract-only plugin seam over snapshots and audit evidence. No core op invokes it today.',
  }),
  capabilityEntry({
    ecosystem: 'mutation_testing',
    ecosystemName: 'Mutation testing',
    candidateTools: ['Stryker', 'PIT', 'mull', 'mutmut'],
    capabilityId: 'mutationTesting',
    runtimeState: 'contract_only',
    invocationMode: 'explicit_extension_call',
    sideEffectPosture: 'none',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'snapshot_metadata', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
    ],
    notes:
      'Mutation execution stays host-owned and isolated from the deterministic workspace contract. Hoplon preserves the DTO seam only.',
  }),
];
