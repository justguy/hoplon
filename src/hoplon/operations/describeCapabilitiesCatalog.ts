/**
 * describeCapabilitiesCatalog.ts — capability inventory for T-046.
 *
 * Keeps the introspection catalog data out of the operation wrapper so the
 * operation file stays under the repo line-cap and the inventory stays easy to
 * audit against the actual adapter surface.
 */

import type {
  CapabilityContractReport,
  CapabilityDefaultBinding,
  CapabilityRuntimeState,
} from '../contracts/capabilities.js';
import type { EngineHealth } from '../contracts/health.js';
import type { SemanticCapabilityClass, SemanticHealth } from '../contracts/semanticHealth.js';
import {
  descriptor,
  withHealth,
  withoutHealth,
} from './describeCapabilitiesCatalogHelpers.js';
import { buildContractOnlyCapabilityReports } from './describeCapabilitiesContractOnly.js';

/**
 * Provider-availability booleans captured by the factory at construction time.
 *
 * The catalog builder uses these to flip the `embedding`, `vectorStore`, and
 * `semanticSearch` entries between seam-only and shipped states. They are
 * required as a distinct object (rather than pulled off `HealthDeps`) so the
 * builder stays pure and unit-testable without touching engine internals.
 */
export interface CapabilityCatalogBindings {
  embeddingProvided: boolean;
  vectorStoreProvided: boolean;
  semanticHealth?: SemanticHealth;
}

export function buildCapabilityCatalog(
  health: EngineHealth,
  bindings: CapabilityCatalogBindings = {
    embeddingProvided: false,
    vectorStoreProvided: false,
  },
): CapabilityContractReport[] {
  const embeddingLive = bindings.embeddingProvided;
  const vectorStoreLive = bindings.vectorStoreProvided;
  const semanticSearchLive = embeddingLive && vectorStoreLive;
  const semantic = bindings.semanticHealth ?? health.semantic;
  const semanticClass = semantic?.capabilityClass ??
    (semanticSearchLive ? 'advisory_ready' : 'seam_only');
  const liveState: CapabilityRuntimeState = 'shipped';
  const seamState: CapabilityRuntimeState = 'seam_only';
  const noopBinding: CapabilityDefaultBinding = 'noop';
  const semanticDefaultBinding: CapabilityDefaultBinding =
    semanticClass === 'advisory_ready' || semanticClass === 'degraded'
      ? 'builtin'
      : noopBinding;
  return [
    withHealth(
      descriptor({
        capabilityId: 'codeIntelligence',
        name: 'Code Intelligence',
        integrationPoint: 'core_adapter',
        runtimeState: 'shipped',
        defaultBinding: 'builtin',
        sideEffectPosture: 'none',
        failureIsolation: 'core_operation',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'workspace_metadata', access: 'read_only' },
        ],
        notes:
          'Tree-sitter is the shipped default and the live seam behind packContext, queryStructure, and structural templates. Optional LSP-, SCIP-, and Fullscope-backed providers can bind through the same seam without displacing the default runtime.',
      }),
      health.adapters.codeIntelligence,
    ),
    withHealth(
      descriptor({
        capabilityId: 'secretScanner',
        name: 'Secret Scanning',
        integrationPoint: 'core_adapter',
        runtimeState: 'shipped',
        defaultBinding: 'builtin',
        sideEffectPosture: 'warning_only',
        failureIsolation: 'core_operation',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
        notes:
          'The built-in regex scanner ships today on createSnapshot. Optional providers bind through the same seam later.',
      }),
      health.adapters.secretScanner,
    ),
    withHealth(
      descriptor({
        capabilityId: 'staticAnalysis',
        name: 'Static Analysis',
        integrationPoint: 'plugin_contract',
        runtimeState: 'seam_only',
        defaultBinding: 'noop',
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'explicit_extension_call',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
        notes:
          'The contract and plugin path exist, but the default runtime still binds createNoopAnalyzer(). No core PASS/BLOCK path depends on this capability.',
      }),
      health.adapters.staticAnalysis,
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'summarizer',
        name: 'Summarizer',
        integrationPoint: 'host_composition',
        runtimeState: 'seam_only',
        defaultBinding: 'noop',
        sideEffectPosture: 'none',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'host_invoked',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'audit_evidence', access: 'read_only' },
          { dataClass: 'host_objective', access: 'read_only' },
        ],
        notes:
          'The adapter slot and noop default are shipped, but Hoplon never invokes this seam internally. The host owns any LLM-backed summarization call path.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'embedding',
        name: 'Embedding',
        integrationPoint: 'core_adapter',
        runtimeState: embeddingLive ? liveState : seamState,
        defaultBinding: noopBinding,
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
        notes: embeddingLive
          ? 't-034: a host-supplied embedding adapter is bound. The typed engine.semanticSearch and engine.indexSemanticCorpus consumers invoke it on the advisory retrieval path only; no PASS/BLOCK path consults embeddings.'
          : 't-034: the optional adapter slot and noop default are shipped. Engine.semanticSearch / engine.indexSemanticCorpus consume this slot on the advisory retrieval path, but return status=UNAVAILABLE until the host wires a real embedding adapter.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'vectorStore',
        name: 'Vector Store',
        integrationPoint: 'core_adapter',
        runtimeState: vectorStoreLive ? liveState : seamState,
        defaultBinding: noopBinding,
        sideEffectPosture: 'export_only',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'provider_metadata', access: 'read_only' },
        ],
        notes: vectorStoreLive
          ? 't-034: a host-supplied vector store is bound. The typed engine.semanticSearch and engine.indexSemanticCorpus consumers upsert and retrieve against it on the advisory retrieval path only; no PASS/BLOCK path consults vector results.'
          : 't-034: the adapter slot and noop default are shipped. Engine.semanticSearch / engine.indexSemanticCorpus consume this slot on the advisory retrieval path, but return status=UNAVAILABLE until the host wires a real vector store.',
      }),
    ),
    {
      descriptor: descriptor({
        capabilityId: 'semanticSearch',
        name: 'Semantic Search',
        integrationPoint: 'core_adapter',
        runtimeState: semanticRuntimeState(semanticClass),
        defaultBinding: semanticDefaultBinding,
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'provider_metadata', access: 'read_only' },
        ],
        notes: semanticCapabilityNotes(semanticClass),
      }),
      healthStatus: semanticHealthStatus(semantic),
    },
    withoutHealth(
      descriptor({
        capabilityId: 'anomalyDetector',
        name: 'Anomaly Detector',
        integrationPoint: 'core_adapter',
        runtimeState: 'seam_only',
        defaultBinding: 'noop',
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'workspace_metadata', access: 'read_only' },
          { dataClass: 'audit_evidence', access: 'read_only' },
        ],
        notes:
          "t-037: adapter slot, noop default, and a typed engine seam (engine.scoreAnomaly) are shipped. Output is strictly advisory — the schema pins advisory=true — and no core PASS/BLOCK path consults it. A host-wired statistical detector is available via createStatisticalAnomalyDetector(); promoting score output to any blocking role is a separate, out-of-scope slice.",
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'violationPredictor',
        name: 'Violation Predictor',
        integrationPoint: 'core_adapter',
        runtimeState: 'seam_only',
        defaultBinding: 'noop',
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
        ],
        dataAccess: [{ dataClass: 'audit_evidence', access: 'read_only' }],
        notes:
          "t-036: adapter slot, noop default, and a typed engine seam (engine.predictViolationRisk) are shipped. Output is strictly advisory — the schema pins advisory=true — and no core PASS/BLOCK path consults it. A host-wired base-rate predictor is available via createBaseRateViolationPredictor(); promoting predictor output to any blocking role is a separate, out-of-scope slice.",
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'dlp',
        name: 'Semantic Data-Loss Prevention',
        integrationPoint: 'core_adapter',
        runtimeState: 'seam_only',
        defaultBinding: 'noop',
        sideEffectPosture: 'warning_only',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
        notes:
          "t-026: adapter slot, noop default, and createSnapshot seam ship. Policy mode defaults to 'warn' — findings surface as content-free possible_dlp_finding warnings. 'block' is opt-in only and rejects the commit with ValidationError({dlp_policy_block}) before Phase B git commit. Adapter output never feeds auditDiff or any other PASS/BLOCK path. Real providers are not in scope for this slice.",
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'blastRadius',
        name: 'Advisory Blast-Radius Analysis',
        integrationPoint: 'core_adapter',
        runtimeState: 'seam_only',
        defaultBinding: 'builtin',
        sideEffectPosture: 'none',
        failureIsolation: 'advisory_only',
        invocationMode: 'typed_engine_method',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
        ],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'workspace_metadata', access: 'read_only' },
        ],
        notes:
          "t-027: engine.analyzeBlastRadius ships as a typed advisory consumer over the existing CodeIntelligenceAdapter.findReferences seam. Tree-sitter remains the shipped default intelligence path; findReferences is an optional Layer 2 method, so with the default adapter the operation returns status='UNAVAILABLE' with every entry classified 'missing_provider' and never fabricates cross-file data. The output carries advisory=true as a schema invariant. No auditDiff / createSnapshot / dryRun / preflight PASS/BLOCK path consults this report, and the warn threshold is always echoed on the result so no default can silently retune callers.",
      }),
    ),
    ...buildContractOnlyCapabilityReports(),
  ];
}

function semanticRuntimeState(
  capabilityClass: SemanticCapabilityClass,
): CapabilityRuntimeState {
  if (capabilityClass === 'advisory_ready') return 'advisory_ready';
  if (capabilityClass === 'degraded') return 'degraded';
  if (capabilityClass === 'contract_only') return 'contract_only';
  return 'seam_only';
}

function semanticHealthStatus(
  health: SemanticHealth | undefined,
): CapabilityContractReport['healthStatus'] {
  if (health?.status === 'AVAILABLE') return 'available';
  if (health?.status === 'DEGRADED') return 'degraded';
  return 'unavailable';
}

function semanticCapabilityNotes(capabilityClass: SemanticCapabilityClass): string {
  if (capabilityClass === 'advisory_ready') {
    return 'sem-search-021: semantic search is advisory-ready with bound providers, unified baseline/branch/overlay retrieval, typed recovery guidance, and health-visible runtime/persistence metadata. The schema remains advisory-only; deterministic exact reads/searches stay on seeCodebase, and no PASS/BLOCK path consults semantic retrieval.';
  }
  if (capabilityClass === 'degraded') {
    return 'sem-search-021: semantic search is available only in degraded advisory mode, such as lexical-only or partial provider coverage. It may warn, suggest recovery, or return stale/empty retrieval, but it never gates deterministic review.';
  }
  if (capabilityClass === 'contract_only') {
    return 'sem-search-021: part of the semantic contract is bound, but the runtime is not advisory-ready. Calls surface typed UNAVAILABLE/DEGRADED status and recovery metadata instead of exposing provider internals.';
  }
  if (capabilityClass === 'disabled') {
    return 'sem-search-011: semantic indexing/search is disabled by privacy mode such as hash-only manifest storage. The capability remains visible as disabled advisory infrastructure, not a deterministic gate.';
  }
  return 'sem-search-021: the typed semanticSearch and indexSemanticCorpus seams are shipped, but default noop providers keep them seam-only and UNAVAILABLE until a host wires real semantic providers.';
}
