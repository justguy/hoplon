/**
 * tests/proof/phase1/fixtures/buildEngine.ts — Standalone proof-engine fixture builder.
 *
 * DO NOT import from tests/unit/ or tests/contracts/ — this builder is intentionally
 * duplicated so that a unit-test bug hiding in shared scaffolding cannot silently
 * pass the Phase 1 proof suite.
 *
 * Wiring:
 *   - createMemFsAdapter()             — in-memory filesystem (C2)
 *   - createIsomorphicGitVersioning()  — isomorphic-git on memfs (C4)
 *   - createIsolatedTestStore()        — per-WASM-heap isolated sql.js store (C1)
 *   - createAsyncMutexLockProvider()   — in-process mutex (C3)
 *   - createMemoryEmitter()            — event capture for H13 audit (C5)
 *   - createTreeSitterIntelligence()   — real WASM tree-sitter (D3)
 *   - createBuiltinRegexScanner()      — built-in regex patterns (C6)
 *   - createNoopAnalyzer()             — optional no-op static analysis
 *
 * Default config: { engineId: 'proof-engine', fsRoot: '/' }
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createHoplonEngine } from '../../../../src/hoplon/engine/factory.js';
import type { HoplonEngine, HoplonEngineConfig } from '../../../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../../src/hoplon/adapters/emitter/memory.js';
import type { MemoryEmitter } from '../../../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createBuiltinRegexScanner } from '../../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createNoopAnalyzer } from '../../../../src/hoplon/adapters/staticAnalysis/noop.js';
import type { SnapshotStore } from '../../../../src/hoplon/adapters/snapshotStore.js';

// ---------------------------------------------------------------------------
// Resolve grammars directory (relative to repo root, not this file's location)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const PROOF_GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

// ---------------------------------------------------------------------------
// ProofEngineBundle — everything returned by buildProofEngine
// ---------------------------------------------------------------------------

export interface ProofEngineBundle {
  engine: HoplonEngine;
  /** For seeding fixtures and inspecting state */
  fs: ReturnType<typeof createMemFsAdapter>;
  /** For introspecting events (H13 audit) */
  emitter: MemoryEmitter;
  /** For simulating crash scenarios (H10 atomicity tests) */
  snapshotStore: SnapshotStore;
  config: Required<Pick<HoplonEngineConfig, 'engineId' | 'fsRoot' | 'gitRepoDir'>>;
}

// ---------------------------------------------------------------------------
// buildProofEngine — the standalone fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory Hoplon engine wired with all Phase 1 default adapters.
 *
 * Every call returns an independent engine with its own:
 *   - memfs volume (no shared state)
 *   - sql.js WASM heap (per-heap isolation via createIsolatedTestStore)
 *   - AsyncMutex instance
 *   - MemoryEmitter event store
 *
 * The tree-sitter CodeIntelligenceAdapter is created fresh per call (shares
 * the grammar WASM binary file but has an independent parser state).
 *
 * @param overrides - Optional partial HoplonEngineConfig overrides applied
 *   on top of the proof-suite defaults.
 */
export async function buildProofEngine(overrides?: Partial<HoplonEngineConfig>): Promise<ProofEngineBundle> {
  // -------------------------------------------------------------------------
  // Build all adapters fresh — no shared state
  // -------------------------------------------------------------------------
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = createMemoryEmitter();
  const codeIntelligence = await createTreeSitterIntelligence({ grammarsDir: PROOF_GRAMMARS_DIR });
  const secretScanner = createBuiltinRegexScanner();
  const staticAnalysis = createNoopAnalyzer();

  // -------------------------------------------------------------------------
  // Apply proof-suite defaults then overrides
  // -------------------------------------------------------------------------
  const config: HoplonEngineConfig = {
    engineId: 'proof-engine',
    fsRoot: '/',
    gitRepoDir: '/.hoplon/repo',
    revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**'],
    maxFileBytes: 524288,
    parseTimeoutMs: 5000,
    manifestStorageMode: 'inline',
    ...overrides,
  };

  // -------------------------------------------------------------------------
  // Wire the engine — createHoplonEngine is async (awaits reconcile at startup)
  // -------------------------------------------------------------------------
  const engine = await createHoplonEngine(
    {
      fs,
      versioning,
      snapshotStore,
      lockProvider,
      emitter,
      codeIntelligence,
      secretScanner,
      staticAnalysis,
    },
    config,
  );

  return {
    engine,
    fs,
    emitter,
    snapshotStore,
    config: {
      engineId: config.engineId ?? 'proof-engine',
      fsRoot: config.fsRoot ?? '/',
      gitRepoDir: config.gitRepoDir ?? '/.hoplon/repo',
    },
  };
}
