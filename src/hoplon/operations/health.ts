/**
 * operations/health.ts — E1 health operation.
 *
 * Performs cheap per-adapter probes and returns engine + adapter health status.
 * Idempotent. Never throws — probe failures are captured as 'failed' status.
 *
 * ## Probe strategy per adapter
 *   - fs: stat('.') — stat the root; succeeds even on an empty root
 *   - versioning: resolveCurrentBranch(gitRepoDir) — a healthy adapter answers
 *     (branch resolution or null on an uninitialized repo) without throwing; a
 *     broken/unreachable adapter throws → 'failed'
 *   - snapshotStore: listPending(9999999999) — returns array; any response is healthy
 *   - lockProvider: acquire('health-probe') then release() — quick acquire/release
 *   - emitter: emit a test event — verify emit doesn't throw
 *   - codeIntelligence: parse a trivial in-memory snippet — verifies the parser
 *     runtime and grammars are actually loaded and responsive
 *   - secretScanner: scan({ path: '', content: new Uint8Array() }) — empty → empty result
 *   - staticAnalysis: analyze({ files: [] }) — noop returns PASS
 *
 * ## Emitter probe
 *   The health operation itself emits start/end events. If the emitter probe fails
 *   we still report the health result (emitter: 'failed') but suppress the
 *   health start/end events to avoid infinite-loop risk. Emitter errors from
 *   start/end events are always suppressed (fire-and-forget).
 *
 * ## AbortSignal (H12)
 *   Checked at entry. Probes run sequentially (serial); abort between probes is
 *   not strictly enforced in Phase 1 — signal is entry-checked only.
 *
 * ## Import wall
 *   Imports only from ../adapters/*, ../contracts/*, ../util/*.
 *   Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { LockProvider } from '../adapters/lock.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { SecretScannerAdapter } from '../adapters/secretScanner.js';
import type { StaticAnalysisAdapter } from '../adapters/staticAnalysis.js';
import type { SemanticStorageProfileAdapter } from '../adapters/semanticStorageProfile.js';
import type { EngineHealth, AdapterStatus } from '../contracts/health.js';
import {
  semanticHealth,
  type SemanticHealthDeps,
} from './semanticHealth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Trivial, side-effect-free snippet parsed by the codeIntelligence probe.
 * A single empty statement is valid in every supported grammar and forces the
 * parser runtime + grammars to actually load and run.
 */
const HEALTH_PROBE_SNIPPET: Uint8Array = new TextEncoder().encode(';\n');

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HealthDeps {
  /** Filesystem adapter (C2). */
  fs: HoplonFsAdapter;
  /** Versioning adapter (C4). */
  versioning: VersioningAdapter;
  /** SQLite snapshot store (C1). */
  snapshotStore: SnapshotStore;
  /** Project-keyed lock provider (C3). */
  lockProvider: LockProvider;
  /** Operational event emitter (C5). */
  emitter: HoplonEmitter;
  /** Code intelligence adapter (D3). */
  codeIntelligence: CodeIntelligenceAdapter;
  /** Secret scanner (C6). */
  secretScanner: SecretScannerAdapter;
  /** Static analysis adapter (optional, default noop). */
  staticAnalysis: StaticAnalysisAdapter;
  /** Semantic health composition inputs. */
  semanticStorageProfile: SemanticStorageProfileAdapter;
  embeddingProvided: boolean;
  vectorStoreProvided: boolean;
  embeddingCacheProvided?: boolean;
  semanticIndexStoreProvided?: boolean;
  lexicalIndexProvided?: boolean;
  vectorIndexProvided?: boolean;
  semanticStorageProfileProvided?: boolean;
  sessionOverlayStore?: SemanticHealthDeps['sessionOverlayStore'];
  manifestStorageMode?: 'inline' | 'hash_only';
  /** Engine identity (H5). */
  engineId: string;
  /**
   * Timestamp (Date.now()) captured at factory construction.
   * Used to compute uptimeMs.
   */
  startedAt: number;
  /**
   * The git repo dir used for the versioning probe.
   * Typically HoplonEngineConfig.gitRepoDir (default '.hoplon/repo').
   */
  gitRepoDir: string;
}

// ---------------------------------------------------------------------------
// health — main entry point
// ---------------------------------------------------------------------------

/**
 * Probe each adapter and return engine + adapter health status.
 *
 * Never throws. Probe failures are captured as 'failed' adapter status.
 * Always returns an EngineHealth object even if all adapters fail.
 *
 * @throws {DOMException} name 'AbortError' — signal aborted before any work
 */
export async function health(deps: HealthDeps, signal?: AbortSignal): Promise<EngineHealth> {
  const {
    fs,
    versioning,
    snapshotStore,
    lockProvider,
    emitter,
    codeIntelligence,
    secretScanner,
    staticAnalysis,
    semanticStorageProfile,
    engineId,
    startedAt,
    gitRepoDir,
  } = deps;

  // -------------------------------------------------------------------------
  // Step 1: Check abort before any work (H12)
  // -------------------------------------------------------------------------
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error
      ? reason
      : new DOMException(
          typeof reason === 'string' ? reason : 'Operation aborted',
          'AbortError',
        );
  }

  // -------------------------------------------------------------------------
  // Step 2: Run probes (each wrapped in try/catch — health never throws)
  // -------------------------------------------------------------------------

  // fs probe: stat('.') — root should always be stat-able
  const fsStatus = await _probe(async () => {
    await fs.stat('.');
  });

  // versioning probe: resolveCurrentBranch(gitRepoDir). A healthy adapter answers
  // — returning a branch resolution, or null on an uninitialized/detached repo —
  // without throwing (the engine initializes the repo on first createSnapshot, so
  // an uninitialized repo is NOT a degraded state). A genuinely broken or
  // unreachable versioning backend throws, which surfaces as 'failed'.
  const versioningStatus = await _probe(async () => {
    await versioning.resolveCurrentBranch(gitRepoDir);
  });

  // snapshotStore probe: listPending with large threshold → just verifies store works
  const snapshotStoreStatus = await _probe(async () => {
    await snapshotStore.listPending(9_999_999_999);
  });

  // lockProvider probe: acquire + immediate release
  const lockProviderStatus = await _probe(async () => {
    const release = await lockProvider.acquire('health-probe');
    release();
  });

  // emitter probe: emit a test event (suppresses in health start/end to avoid loop)
  const emitterStatus = await _probe(() => {
    emitter.emit({
      op: 'health',
      phase: 'start',
      engineId,
      correlationId: 'health-probe',
    });
    return Promise.resolve();
  });

  // codeIntelligence probe: parse a trivial in-memory snippet. This exercises
  // the real parser path (runtime + grammars loaded and responsive). A broken
  // adapter — grammars not loaded, runtime init failed — throws → 'failed'.
  const codeIntelligenceStatus = await _probe(async () => {
    await codeIntelligence.parse('health-probe.ts', HEALTH_PROBE_SNIPPET);
  });

  // secretScanner probe: scan empty content → should return empty findings
  const secretScannerStatus = await _probe(async () => {
    await secretScanner.scan({ path: '', content: new Uint8Array() });
  });

  // staticAnalysis probe: analyze empty file list → noop returns PASS
  const staticAnalysisStatus = await _probe(async () => {
    await staticAnalysis.analyze({ files: [] });
  });
  const semantic = await semanticHealth({
    embeddingProvided: deps.embeddingProvided,
    vectorStoreProvided: deps.vectorStoreProvided,
    semanticStorageProfile,
    ...(deps.embeddingCacheProvided !== undefined
      ? { embeddingCacheProvided: deps.embeddingCacheProvided }
      : {}),
    ...(deps.semanticIndexStoreProvided !== undefined
      ? { semanticIndexStoreProvided: deps.semanticIndexStoreProvided }
      : {}),
    ...(deps.lexicalIndexProvided !== undefined
      ? { lexicalIndexProvided: deps.lexicalIndexProvided }
      : {}),
    ...(deps.vectorIndexProvided !== undefined
      ? { vectorIndexProvided: deps.vectorIndexProvided }
      : {}),
    ...(deps.semanticStorageProfileProvided !== undefined
      ? { semanticStorageProfileProvided: deps.semanticStorageProfileProvided }
      : {}),
    ...(deps.sessionOverlayStore !== undefined
      ? { sessionOverlayStore: deps.sessionOverlayStore }
      : {}),
    ...(deps.manifestStorageMode !== undefined
      ? { manifestStorageMode: deps.manifestStorageMode }
      : {}),
  });

  // -------------------------------------------------------------------------
  // Step 3: Emit start/end events (only if emitter probe succeeded)
  // Emit after probes to avoid duplicating the emitter probe event.
  // -------------------------------------------------------------------------
  if (emitterStatus === 'ok') {
    try {
      emitter.emit({
        op: 'health',
        phase: 'end',
        engineId,
        correlationId: 'health-probe',
        durationMs: 0,
        classification: 'PASS',
      });
    } catch {
      // suppress
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Return EngineHealth
  // -------------------------------------------------------------------------
  return {
    engineId,
    adapters: {
      fs: fsStatus,
      versioning: versioningStatus,
      snapshotStore: snapshotStoreStatus,
      lockProvider: lockProviderStatus,
      emitter: emitterStatus,
      codeIntelligence: codeIntelligenceStatus,
      secretScanner: secretScannerStatus,
      staticAnalysis: staticAnalysisStatus,
    },
    semantic,
    uptimeMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal: probe wrapper
// ---------------------------------------------------------------------------

/**
 * Run an async probe and return 'ok' on success, 'failed' on any error.
 * Never throws.
 */
async function _probe(fn: () => Promise<void>): Promise<AdapterStatus> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'failed';
  }
}
