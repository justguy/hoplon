# Hoplon Provider Mapping

> Design-time reference. Maps external tool ecosystems to one intended Hoplon
> seam each. This document does not describe runtime behavior; no provider
> registry, loader, or execution path is implied by anything below.
>
> Machine-readable source of truth: `src/hoplon/contracts/providerMapping.ts`
> (+ `providerMappingCapabilities.ts`, `providerMappingCoreAdapters.ts`).
> Consistency against the capability catalog is enforced by
> `tests/contracts/providerMapping.test.ts`.

## Purpose

The capability catalog (`t-046`) recorded the shipped, seam-only, and
contract-only state of each capability honestly. This document is the next
step: for each major external-tool ecosystem the rewrite cares about, it names
one intended Hoplon seam and preserves the strict boundary facts:

- intended runtime state
- invocation mode
- side-effect posture
- failure-isolation story
- data-access class

A mapping entry is only a claim about where an ecosystem belongs, not a claim
that it is shipped. Every capability-backed entry has its boundary fields
checked against the descriptor in the capability catalog so the two cannot
drift silently.

## Seam vocabulary

Two seam kinds:

- **capability** — binds through one `CapabilityId` in the t-046 catalog
  (`codeIntelligence`, `secretScanner`, `staticAnalysis`, `summarizer`,
  `embedding`, `vectorStore`, `anomalyDetector`, `versionSyncedIntelligence`,
  `semanticGapAnalysis`, `semanticTwins`, `mutationTesting`,
  `complianceExports`).
- **core_adapter** — binds through one of the long-established core adapter
  seams that predate the capability catalog: `emitter`, `lockProvider`,
  `snapshotStore`, `versioning`, `filesystem`.

Core adapters are not re-classified as capabilities by this mapping.

## Language and reference-intelligence ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Language / reference intelligence | capability `codeIntelligence` | shipped | tree-sitter (shipped default), LSP, SCIP, Fullscope / tpf-mcp |

Tree-sitter is the shipped default. LSP / SCIP / Fullscope integrations would
bind through the same CodeIntelligence adapter. Adopting any of them is an
adapter swap, not a new core dependency. Failure isolation stays
`core_operation` because packContext and queryStructure depend on this
adapter.

Strict exclusive agent mode keeps this narrower than default-profile host
composition: Fullscope, LSP, and similar providers do not appear as peer
agent-visible code-read tools. The `t-099` decision leaves runtime activation
deferred; a future strict-mode provider must be intentionally wired by the
host and mediated by Hoplon through `CodeIntelligenceAdapter` / Track P with
audit binding. The default runtime remains local tree-sitter.

## Secret-scanning and static-analysis ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Secret scanning | capability `secretScanner` | shipped | built-in regex scanner (shipped default), Gitleaks, TruffleHog, detect-secrets |
| Static analysis | capability `staticAnalysis` | seam_only | Semgrep, ESLint, CodeQL, SonarQube |

Built-in regex scanning runs on `createSnapshot` today. Gitleaks / TruffleHog
/ detect-secrets would bind through the same adapter contract.

Static analysis remains `seam_only`: the default binding is the noop analyzer
and no core PASS/BLOCK path depends on this capability. Adopting Semgrep /
ESLint / CodeQL / SonarQube would continue to flow findings as advisory
(`failureIsolation: advisory_only`); upgrading them to blocking is a separate
design decision, not implied by this mapping.

## Observability and compliance/export ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Observability / telemetry | core adapter `emitter` | seam_only | OpenTelemetry, Prometheus, Datadog, Honeycomb |
| Compliance export / SIEM / reporting | capability `complianceExports` | contract_only | SARIF export, Splunk, Elastic SIEM, Chronicle, custom audit-log pipelines |

Observability backends bind through the Emitter adapter. Default bindings
today are the noop, console, and memory emitters. The Emitter is classified
`seam_only` because no shipped default emits real telemetry; backends like
OpenTelemetry are a host-side bind at engine construction. Emitter failures
are strictly `advisory_only` and must not fail core operations.

Compliance exports stay contract-only. Evidence export never runs inside the
deterministic gate path. Hosts own any push to Splunk / Elastic / Chronicle
and any SARIF generation; the Hoplon surface remains a read-only metadata
seam with `sideEffectPosture: export_only` and
`failureIsolation: host_invoked_only`.

## Lock/coordination and distributed-support ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Lock / coordination | core adapter `lockProvider` | shipped | async-mutex (shipped default), Redlock (Redis), Postgres advisory locks, ZooKeeper / etcd |
| Snapshot registry / audit storage | core adapter `snapshotStore` | shipped | SQLite (shipped default), Postgres snapshot store (shipped provider package), MySQL / MariaDB, CockroachDB |

Lock acquisition failure fails the current operation by design
(`failureIsolation: core_operation`). Multi-process self-hosting requires a
distributed lock provider; the existing LockProvider contract is the one
intended seam.

Snapshot registry / audit storage uses the SnapshotStore adapter. SQLite is
the shipped default and Postgres ships as a provider package. The contract
stores snapshot metadata and append-only audit history; contracted workspace
bytes remain behind the Versioning adapter via `gitRef`. Additional
relational implementations can bind through the same adapter contract; no
second storage boundary is introduced.

## Embedding, vector-search, anomaly, and summarization ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Embedding | capability `embedding` | seam_only | OpenAI embeddings, Voyage, Cohere, local sentence-transformers |
| Vector search | capability `vectorStore` | seam_only | pgvector, Pinecone, Weaviate, Milvus, Qdrant |
| Anomaly detection | capability `anomalyDetector` | seam_only | statistical baselines, isolation forests, behavioral anomaly services |
| Summarization | capability `summarizer` | seam_only | LLM-backed summarizers (host-owned), extractive summarizers |

All four capabilities are classified `seam_only`: the adapter slot and the
noop default ship today, but Hoplon core never invokes any of them. All
invocation is `host_invoked` with
`failureIsolation: host_invoked_only`. Adopting a provider in any of these
ecosystems does not add a hot-path dependency to the Hoplon core loop.

## Target-state contract-only ecosystems

| Ecosystem | Seam | Runtime state | Candidates |
| --- | --- | --- | --- |
| Version-synced intelligence metadata | capability `versionSyncedIntelligence` | contract_only | SCIP snapshots, LSP index servers, repo-relative semantic indices |
| Semantic gap analysis | capability `semanticGapAnalysis` | contract_only | manifest-diff analyzers, contract-test generators, custom host evaluators |
| Semantic twins / fix propagation | capability `semanticTwins` | contract_only | cross-repo semantic linkers, host-owned fix propagation services |
| Mutation testing | capability `mutationTesting` | contract_only | Stryker, PIT, mull, mutmut |

These capabilities have no default binding. The mapping preserves them as
intended future seams so future slices do not silently conflate them with
shipped behavior.

## Invariants this mapping preserves

- One intended seam per ecosystem. No ecosystem maps to two seams.
- One explicit runtime state per ecosystem. An entry cannot mark an ecosystem
  `shipped` when the underlying capability descriptor says `seam_only` or
  `contract_only`; the test fails if it tries.
- One invocation mode, one side-effect posture, one failure-isolation story
  per entry, each matching the descriptor for capability-backed entries.
- One explicit data-access class list per entry. Capability-backed entries
  must match the descriptor set.
- No provider is named as integrated, enabled, or live. The
  `candidateTools` list is illustrative, not a manifest.

## What this mapping is not

- not a plugin registry
- not a provider loader or execution path
- not a runtime configuration surface
- not a hard-gate change
- not a substitute for any broader self-host proof follow-on

If any of those land in a later slice they must be their own roadmap item
with their own proof, not a quiet extension of this mapping.
