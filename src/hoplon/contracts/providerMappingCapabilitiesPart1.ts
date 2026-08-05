import type { ProviderMappingEntry } from './providerMapping.js';
import { capabilityEntry } from './providerMappingCapabilityEntry.js';

export const PROVIDER_MAPPING_CAPABILITIES_PART_1: ProviderMappingEntry[] = [
  capabilityEntry({
    ecosystem: 'language_reference',
    ecosystemName: 'Language and reference intelligence',
    candidateTools: [
      'tree-sitter (shipped default)',
      'LSP servers',
      'SCIP indexes',
      'Fullscope / tpf-mcp',
    ],
    capabilityId: 'codeIntelligence',
    runtimeState: 'shipped',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'core_operation',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'workspace_metadata', access: 'read_only' },
    ],
    notes:
      'Tree-sitter is the shipped default. LSP, SCIP, and Fullscope bind through the same CodeIntelligence adapter seam. Adopting any of them is an adapter swap, not a new core dependency, and offline SCIP indices must surface revision/freshness explicitly rather than being treated as ambient truth.',
  }),
  capabilityEntry({
    ecosystem: 'secret_scanning',
    ecosystemName: 'Secret scanning',
    candidateTools: [
      'built-in regex scanner (shipped default)',
      'Gitleaks',
      'TruffleHog',
      'detect-secrets',
    ],
    capabilityId: 'secretScanner',
    runtimeState: 'shipped',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'warning_only',
    failureIsolation: 'core_operation',
    dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
    notes:
      'Built-in regex scanner ships on createSnapshot. Gitleaks, TruffleHog, and detect-secrets bind through the same adapter seam; none of them are hard dependencies of core.',
  }),
  capabilityEntry({
    ecosystem: 'static_analysis',
    ecosystemName: 'Static analysis',
    candidateTools: ['Semgrep', 'ESLint', 'CodeQL', 'SonarQube'],
    capabilityId: 'staticAnalysis',
    runtimeState: 'seam_only',
    invocationMode: 'explicit_extension_call',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
    notes:
      'Default binding is the noop analyzer. Semgrep, ESLint, CodeQL, and SonarQube integrate through the existing plugin_contract seam as advisory findings. No core PASS/BLOCK semantics change.',
  }),
  capabilityEntry({
    ecosystem: 'compliance_export',
    ecosystemName: 'Compliance export / SIEM / reporting',
    candidateTools: [
      'SARIF export',
      'Splunk',
      'Elastic SIEM',
      'Chronicle',
      'custom audit-log pipelines',
    ],
    capabilityId: 'complianceExports',
    runtimeState: 'contract_only',
    invocationMode: 'host_invoked',
    sideEffectPosture: 'export_only',
    failureIsolation: 'host_invoked_only',
    dataAccess: [
      { dataClass: 'snapshot_metadata', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
    ],
    notes:
      'Evidence export stays outside the deterministic gate path. Hosts own any push to Splunk, Elastic, or Chronicle; the Hoplon surface remains a read-only metadata seam.',
  }),
  capabilityEntry({
    ecosystem: 'embedding',
    ecosystemName: 'Embedding providers',
    candidateTools: [
      'createHashingTextEmbedding (shipped reference — deterministic, zero-dependency)',
      'OpenAI embeddings',
      'Voyage',
      'Cohere',
      'local sentence-transformers',
    ],
    capabilityId: 'embedding',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [{ dataClass: 'workspace_content', access: 'read_only' }],
    notes:
      't-034: the embedding adapter slot is consumed by engine.semanticSearch and engine.indexSemanticCorpus on the advisory retrieval path. createHashingTextEmbedding ships as a host-wired reference implementation; real hosts swap it for OpenAI / Voyage / Cohere / local sentence-transformers through the same seam. No PASS/BLOCK path consults embeddings.',
  }),
  capabilityEntry({
    ecosystem: 'vector_search',
    ecosystemName: 'Vector search',
    candidateTools: [
      'createInMemoryVectorStore (shipped reference — in-process, zero-dependency)',
      'pgvector',
      'Pinecone',
      'Weaviate',
      'Milvus',
      'Qdrant',
    ],
    capabilityId: 'vectorStore',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'export_only',
    failureIsolation: 'advisory_only',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'provider_metadata', access: 'read_only' },
    ],
    notes:
      't-034: the vectorStore adapter slot is consumed by engine.semanticSearch and engine.indexSemanticCorpus on the advisory retrieval path. createInMemoryVectorStore ships as a host-wired reference implementation; real hosts swap it for pgvector / Pinecone / Weaviate / Milvus / Qdrant through the same seam. No PASS/BLOCK path consults retrieval.',
  }),
  capabilityEntry({
    ecosystem: 'semantic_search',
    ecosystemName: 'Semantic search (Layer 1 retrieval)',
    candidateTools: [
      'createHashingTextEmbedding + createInMemoryVectorStore (shipped reference pair)',
      'OpenAI embeddings + pgvector',
      'Voyage + Qdrant',
      'local sentence-transformers + SQLite-vec',
      'managed embedding/vector services (Pinecone, Weaviate)',
    ],
    capabilityId: 'semanticSearch',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [
      { dataClass: 'workspace_content', access: 'read_only' },
      { dataClass: 'provider_metadata', access: 'read_only' },
    ],
    notes:
      't-034: first real Layer 1 semantic-search retrieval seam. engine.semanticSearch and engine.indexSemanticCorpus compose the shipped embedding + vectorStore adapter slots. Project-scoped top-K retrieval with advisory=true pinned by schema; returns status=UNAVAILABLE with no matches when either slot is still bound to the noop default. Real hosts wire any embedding provider + any vector store through the same pair of slots without changing the engine surface.',
  }),
  capabilityEntry({
    ecosystem: 'anomaly',
    ecosystemName: 'Anomaly detection',
    candidateTools: [
      'statistical baselines (shipped reference — createStatisticalAnomalyDetector)',
      'isolation forests',
      'behavioral anomaly services',
    ],
    capabilityId: 'anomalyDetector',
    runtimeState: 'seam_only',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'advisory_only',
    dataAccess: [
      { dataClass: 'workspace_metadata', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
    ],
    notes:
      't-037: the adapter slot, noop default, and typed engine.scoreAnomaly consumer ship as an advisory-only seam over the already-landed ML2 audit-log columns. A host-wired statistical detector is provided as a reference implementation. Output is pinned to advisory=true by schema; promoting it to blocking behavior is a separate slice.',
  }),
];
