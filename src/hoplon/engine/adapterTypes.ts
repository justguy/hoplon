/**
 * engine/types.ts — HoplonEngine interface, HoplonAdapters, HoplonEngineConfig.
 *
 * All public methods return Promise<T> (invariant H3 — no callbacks, no event emitters).
 * Every async method accepts an optional AbortSignal (H12).
 * The engine never owns retry or escalation policy (invariant H4).
 *
 * EXCEPTIONS (synchronous methods):
 *   compressRetryContext — pure data transform over AuditViolation arrays (recs §15.9, LC9).
 *   computeMinimalPatch  — pure byte-range arithmetic over violation data (recs §15.5, LC5).
 * Both are no-I/O, no-async functions that return values directly (not Promises).
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { LockProvider } from '../adapters/lock.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { SecretScannerAdapter } from '../adapters/secretScanner.js';
import type { StaticAnalysisAdapter } from '../adapters/staticAnalysis.js';
import type { EmbeddingAdapter } from '../adapters/embedding.js';
import type { VectorStoreAdapter } from '../adapters/vectorStore.js';
import type { EmbeddingCacheAdapter } from '../adapters/embeddingCache.js';
import type { LexicalIndexAdapter } from '../adapters/lexicalIndex.js';
import type { SemanticDocumentBuilderAdapter } from '../adapters/semanticDocumentBuilder.js';
import type { SemanticIndexStoreAdapter } from '../adapters/semanticIndexStore.js';
import type { SemanticStorageProfileAdapter } from '../adapters/semanticStorageProfile.js';
import type { VectorIndexAdapter } from '../adapters/vectorIndex.js';
import type { AnomalyDetectorAdapter } from '../adapters/anomalyDetector.js';
import type { ViolationPredictorAdapter } from '../adapters/violationPredictor.js';
import type { SummarizerAdapter } from '../adapters/summarizer.js';
import type { DlpAdapter } from '../adapters/dlp.js';

// ---------------------------------------------------------------------------

// HoplonAdapters — all 12 capability slots (7 mandatory + 5 optional)
// ---------------------------------------------------------------------------

/**
 * The full set of adapter dependencies for HoplonEngine.
 * Mandatory adapters are required at construction; missing → EngineError({ kind: 'missing_adapter' }).
 * staticAnalysis is optional — defaults to a noop when absent.
 * ML adapter slots (embedding, vectorStore, anomalyDetector) are optional —
 * each defaults to a no-op when absent. Implementations are Phase 3.
 *
 * ## Deprecated alias: gitAdapter (ALIGN-2, H18)
 * `gitAdapter` is accepted as a backward-compatible alias for `versioning`.
 * Callers should migrate to `versioning`. Rules enforced at factory construction:
 *   - Exactly one of `versioning` or `gitAdapter` must be provided.
 *   - If both are provided → ValidationError({ kind: 'conflicting_adapters' }).
 *   - If `gitAdapter` is provided without `versioning` → deprecation warning emitted
 *     via the injected `emitter` (op: 'factory', phase: 'error',
 *     errorKind: 'deprecated_adapter_gitAdapter'), then normalized to `versioning`.
 * Internal engine code always uses `versioning` — the alias is resolved at factory time.
 */
export interface HoplonAdaptersDefinition {
  // Mandatory — engine cannot operate without these
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  lockProvider: LockProvider;
  emitter: HoplonEmitter;
  codeIntelligence: CodeIntelligenceAdapter;
  secretScanner: SecretScannerAdapter;

  /**
   * @deprecated Use `versioning` instead. Accepted as a backward-compatible alias
   * per recs §22.1 (ALIGN-2, H18). If provided alongside `versioning`, the factory
   * throws ValidationError({ kind: 'conflicting_adapters' }). If provided alone,
   * a deprecation warning is emitted via the injected emitter and the adapter is
   * normalized to `versioning` before engine construction proceeds.
   */
  gitAdapter?: VersioningAdapter;

  /**
   * @deprecated Use `HoplonEngineConfig.engineId` instead. Accepted as a backward-
   * compatible alias per recs §22.1 (ALIGN-4, H18). `engineId` moved from
   * `HoplonAdapters` to `HoplonEngineConfig` in A3.1.
   *
   * Rules enforced at factory construction:
   *   - `adapters.engineId` only (no `config.engineId`) → deprecation warning emitted
   *     via the injected emitter (op: 'factory', phase: 'error',
   *     errorKind: 'deprecated_adapter_engineId'), then copied to effective engineId.
   *   - `config.engineId` only → normal path, no warning.
   *   - Both present and identical → no warning; proceed normally.
   *   - Both present and different → ValidationError({ kind: 'conflicting_adapters' }).
   *
   * Internal engine code always reads from config — the deprecated field is resolved
   * at factory time and does not propagate past the factory boundary.
   */
  engineId?: string;

  // Optional — defaults to createNoopAnalyzer() when absent (Phase 4 plugin)
  staticAnalysis?: StaticAnalysisAdapter;

  // ML adapter slots — all optional; no-op defaults substituted by factory (Phase 2 ML1).
  // Implementations are Phase 3. These slots exist so Phase 3 can inject real
  // implementations without any engine interface change.
  /** Semantic embedding adapter. No-op default: createNoopEmbedding(). */
  embedding?: EmbeddingAdapter;
  /** Vector store adapter. No-op default: createNoopVectorStore(). */
  vectorStore?: VectorStoreAdapter;
  /** Embedding cache adapter. No-op default reports UNAVAILABLE. */
  embeddingCache?: EmbeddingCacheAdapter;
  /** Durable semantic index store. No-op default reports UNAVAILABLE. */
  semanticIndexStore?: SemanticIndexStoreAdapter;
  /** Lexical index adapter. No-op default reports UNAVAILABLE. */
  lexicalIndex?: LexicalIndexAdapter;
  /** Split vector index adapter. No-op default reports UNAVAILABLE. */
  vectorIndex?: VectorIndexAdapter;
  /** Parser/document-builder adapter. No-op default reports UNAVAILABLE. */
  semanticDocumentBuilder?: SemanticDocumentBuilderAdapter;
  /** Storage-profile adapter. No-op default reports UNAVAILABLE. */
  semanticStorageProfile?: SemanticStorageProfileAdapter;
  /** Statistical anomaly detector. No-op default: createNoopAnomalyDetector(). */
  anomalyDetector?: AnomalyDetectorAdapter;
  /**
   * Advisory violation-risk predictor (t-036).
   *
   * Consumed exclusively by `engine.predictViolationRisk`, which is advisory-only
   * and never participates in the structural audit PASS/BLOCK decision.
   * No-op default: createNoopViolationPredictor(). A deterministic reference
   * implementation is shipped as `createBaseRateViolationPredictor()`; the
   * factory never binds it by default — hosts wire it explicitly when they
   * want real scoring.
   */
  violationPredictor?: ViolationPredictorAdapter;
  /**
   * LLM-based summarizer for Hoplon operation outputs (recs §4.1 + §16.5).
   *
   * The host owns the LLM / model choice. Hoplon ships only the seam.
   * No Hoplon operation calls this adapter internally — it is an injection
   * slot for host-side orchestration that wants to summarize AuditViolation[],
   * CompressedRetryContext, or diff payloads into natural language.
   *
   * H2: LLM I/O is behind this adapter; engine core never imports model SDKs.
   * H4: Hoplon never owns retry or escalation for LLM calls.
   * H13: Hoplon emits no events when/if the host calls this adapter.
   *
   * No-op default: createNoopSummarizer() → { summary: '', tokenEstimate: 0, truncated: false }.
   */
  summarizer?: SummarizerAdapter;
  /**
   * t-026 — semantic-DLP provider seam.
   *
   * Additive beside the shipped `secretScanner`. When omitted, the engine
   * factory binds `createNoopDlpAdapter()` so existing callers see zero
   * behavior change. Policy mode is controlled by `HoplonEngineConfig.dlpPolicyMode`
   * (defaulting to `'warn'`). Findings flow to createSnapshot warnings only;
   * the DLP seam never feeds `auditDiff`.
   */
  dlp?: DlpAdapter;
}

// ---------------------------------------------------------------------------
