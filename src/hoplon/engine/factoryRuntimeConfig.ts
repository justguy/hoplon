/** Runtime configuration/default binding phase for createHoplonEngine. */

import { z } from 'zod';
import { EngineError } from '../contracts/errors.js';
import type { HoplonEngineConfig } from './types.js';
import type { ResolvedFactoryAdapters } from './factoryAdapterResolution.js';
import { createNoopAnalyzer } from '../adapters/staticAnalysis/noop.js';
import { createNoopEmbedding, isNoopEmbeddingAdapter } from '../adapters/embedding.js';
import { createNoopVectorStore, isNoopVectorStoreAdapter } from '../adapters/vectorStore.js';
import { createNoopEmbeddingCache, isNoopEmbeddingCacheAdapter } from '../adapters/embeddingCache.js';
import { createNoopLexicalIndex, isNoopLexicalIndexAdapter } from '../adapters/lexicalIndex.js';
import { createNoopSemanticDocumentBuilder } from '../adapters/semanticDocumentBuilder.js';
import { createNoopSemanticIndexStore, isNoopSemanticIndexStoreAdapter } from '../adapters/semanticIndexStore.js';
import { createNoopSemanticStorageProfile, isNoopSemanticStorageProfileAdapter } from '../adapters/semanticStorageProfile.js';
import { createNoopVectorIndex, isNoopVectorIndexAdapter } from '../adapters/vectorIndex.js';
import { createNoopAnomalyDetector } from '../adapters/anomalyDetector.js';
import { createNoopViolationPredictor } from '../adapters/violationPredictor.js';
import { createNoopSummarizer } from '../adapters/summarizer.js';
import { createNoopDlpAdapter } from '../adapters/dlp.js';
import { DEFAULT_DLP_POLICY_MODE } from '../contracts/dlp.js';
import { createBuiltinRegexScanner } from '../adapters/secretScanner/builtin.js';
import type { SecretScannerAdapter } from '../adapters/secretScanner.js';
import { createInMemorySemanticSessionOverlayStore } from '../operations/semanticSessionOverlay.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_PARSE_TIMEOUT_MS } from './defaults.js';
import {
  DEFAULT_GIT_REPO_DIR,
  DEFAULT_MANIFEST_STORAGE_MODE,
  DEFAULT_REVERT_ALLOWLIST,
  DEFAULT_TTL_RETENTION_MS,
} from './factoryConstants.js';

export function resolveFactoryRuntimeConfig(
  resolution: ResolvedFactoryAdapters,
  config?: HoplonEngineConfig,
) {
  const { engineId, resolvedAdapters } = resolution;
  // Step 3: Apply config defaults
  // -------------------------------------------------------------------------
  const fsRoot = config?.fsRoot ?? process.cwd();
  const gitRepoDir = config?.gitRepoDir ?? DEFAULT_GIT_REPO_DIR;
  const revertAllowlist = config?.revertAllowlist ?? DEFAULT_REVERT_ALLOWLIST;
  const maxFileBytes = config?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const parseTimeoutMs = config?.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  // F2: wire caller-supplied secretPatterns into the createSnapshot scanning path.
  // When config.secretPatterns is explicitly provided it OVERRIDES the pattern set
  // used for snapshot scanning (the documented HoplonEngineConfig.secretPatterns
  // contract). When absent, the injected secretScanner adapter is used unchanged,
  // so existing callers see zero behavior change.
  const snapshotSecretScanner: SecretScannerAdapter =
    config?.secretPatterns !== undefined
      ? createBuiltinRegexScanner({
          patterns: config.secretPatterns.map((r, idx) => ({
            name: `CONFIG_SECRET_PATTERN_${idx}`,
            // Snapshot scanning uses exec() in a loop, which requires the global
            // flag; add it when the caller's pattern omits it.
            regex: r.global ? r : new RegExp(r.source, `${r.flags}g`),
          })),
        })
      : resolvedAdapters.secretScanner;
  const manifestStorageMode = config?.manifestStorageMode ?? DEFAULT_MANIFEST_STORAGE_MODE;
  // W3: 0 means keep-forever; use resolved value (never falls back to default when explicitly set to 0).
  const ttlRetentionMs =
    config?.ttlRetentionMs !== undefined ? config.ttlRetentionMs : DEFAULT_TTL_RETENTION_MS;

  // DS1 — H23: replicaId is optional; if present it must be a non-empty string.
  // Zod enforces this so the runtime failure is a clean ValidationError, not a
  // silent empty-string reaching the store later.
  const ReplicaIdSchema = z.string().min(1, 'replicaId must be a non-empty string');
  if (config?.replicaId !== undefined) {
    const replicaIdResult = ReplicaIdSchema.safeParse(config.replicaId);
    if (!replicaIdResult.success) {
      throw new EngineError(
        {
          kind: 'config_invalid',
          engineId,
          correlationId: 'factory',
          cause: replicaIdResult.error,
        },
        `config.replicaId is invalid: ${replicaIdResult.error.message}`,
      );
    }
  }
  // Pass-through: replicaId is validated above but not consumed by the Phase 1/2
  // engine core. Phase 3 distributed adapters (PG1) read it directly from config
  // when they call setReplicaIds. The _replicaId binding keeps TypeScript from
  // flagging the variable as unused while documenting the pass-through intent.
  const _replicaId = config?.replicaId;

  // Provide noop staticAnalysis if not supplied (optional adapter)
  const staticAnalysis = resolvedAdapters.staticAnalysis ?? createNoopAnalyzer();

  // Provide noop ML adapters if not supplied (all optional — Phase 3 fills implementations).
  // t-034 tracks whether the host supplied a real embedding / vector store so the
  // semanticSearch + indexSemanticCorpus operations, and the describeCapabilities
  // catalog, can report `providerAvailable` and the health-derived runtime state
  // honestly instead of guessing by duck-typing the adapter.
  const embeddingProvided =
    resolvedAdapters.embedding !== undefined &&
    resolvedAdapters.embedding !== null &&
    !isNoopEmbeddingAdapter(resolvedAdapters.embedding);
  const vectorStoreProvided =
    resolvedAdapters.vectorStore !== undefined &&
    resolvedAdapters.vectorStore !== null &&
    !isNoopVectorStoreAdapter(resolvedAdapters.vectorStore);
  const embeddingCacheProvided =
    resolvedAdapters.embeddingCache !== undefined &&
    resolvedAdapters.embeddingCache !== null &&
    !isNoopEmbeddingCacheAdapter(resolvedAdapters.embeddingCache);
  const semanticIndexStoreProvided =
    resolvedAdapters.semanticIndexStore !== undefined &&
    resolvedAdapters.semanticIndexStore !== null &&
    !isNoopSemanticIndexStoreAdapter(resolvedAdapters.semanticIndexStore);
  const lexicalIndexProvided =
    resolvedAdapters.lexicalIndex !== undefined &&
    resolvedAdapters.lexicalIndex !== null &&
    !isNoopLexicalIndexAdapter(resolvedAdapters.lexicalIndex);
  const vectorIndexProvided =
    resolvedAdapters.vectorIndex !== undefined &&
    resolvedAdapters.vectorIndex !== null &&
    !isNoopVectorIndexAdapter(resolvedAdapters.vectorIndex);
  const semanticStorageProfileProvided =
    resolvedAdapters.semanticStorageProfile !== undefined &&
    resolvedAdapters.semanticStorageProfile !== null &&
    !isNoopSemanticStorageProfileAdapter(resolvedAdapters.semanticStorageProfile);
  const embedding = resolvedAdapters.embedding ?? createNoopEmbedding();
  const vectorStore = resolvedAdapters.vectorStore ?? createNoopVectorStore();
  const embeddingCache =
    resolvedAdapters.embeddingCache ?? createNoopEmbeddingCache();
  const semanticIndexStore =
    resolvedAdapters.semanticIndexStore ?? createNoopSemanticIndexStore();
  const lexicalIndex = resolvedAdapters.lexicalIndex ?? createNoopLexicalIndex();
  const vectorIndex = resolvedAdapters.vectorIndex ?? createNoopVectorIndex();
  const semanticDocumentBuilder =
    resolvedAdapters.semanticDocumentBuilder ?? createNoopSemanticDocumentBuilder();
  const semanticStorageProfile =
    resolvedAdapters.semanticStorageProfile ?? createNoopSemanticStorageProfile();
  const sessionOverlayStore = createInMemorySemanticSessionOverlayStore();
  // t-037: anomaly detector is advisory-only. Default binding is the noop
  // detector; a real statistical implementation is shipped as an opt-in
  // factory (createStatisticalAnomalyDetector). Engine core never consults
  // the score for gating.
  const anomalyDetector =
    resolvedAdapters.anomalyDetector ?? createNoopAnomalyDetector();
  // t-036: violation predictor is advisory-only. Default binding is the noop
  // predictor; a real base-rate predictor is shipped as an opt-in factory
  // (createBaseRateViolationPredictor). Engine core never consults the
  // result for gating.
  const violationPredictor =
    resolvedAdapters.violationPredictor ?? createNoopViolationPredictor();
  // Provide noop summarizer if not supplied. The host wires a real implementation here
  // when it wants LLM-based summarization. No Hoplon operation calls this internally
  // (H2 seam-only, H4 no-policy, H13 no content in events).
  const _summarizer = resolvedAdapters.summarizer ?? createNoopSummarizer();

  // t-026: DLP adapter is additive and defaults to a no-op, so existing
  // callers see zero behavior change. Policy mode defaults to 'warn' — never
  // the implicit 'block'. Both are caller-visible; neither silently escalates.
  const dlp = resolvedAdapters.dlp ?? createNoopDlpAdapter();
  const dlpPolicyMode = config?.dlpPolicyMode ?? DEFAULT_DLP_POLICY_MODE;

  // -------------------------------------------------------------------------
  // Step 4: Capture startedAt for uptime tracking
  // -------------------------------------------------------------------------
  const startedAt = Date.now();

  // -------------------------------------------------------------------------

  return {
    engineId,
    resolvedAdapters,
    fsRoot,
    gitRepoDir,
    revertAllowlist,
    maxFileBytes,
    parseTimeoutMs,
    snapshotSecretScanner,
    manifestStorageMode,
    ttlRetentionMs,
    staticAnalysis,
    embeddingProvided,
    vectorStoreProvided,
    embeddingCacheProvided,
    semanticIndexStoreProvided,
    lexicalIndexProvided,
    vectorIndexProvided,
    semanticStorageProfileProvided,
    embedding,
    vectorStore,
    embeddingCache,
    semanticIndexStore,
    lexicalIndex,
    vectorIndex,
    semanticDocumentBuilder,
    semanticStorageProfile,
    sessionOverlayStore,
    anomalyDetector,
    violationPredictor,
    dlp,
    dlpPolicyMode,
    startedAt,
  };
}

export type FactoryRuntime = ReturnType<typeof resolveFactoryRuntimeConfig>;
