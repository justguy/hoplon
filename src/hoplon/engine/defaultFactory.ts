/** Packaged default engine construction. */

import type { HoplonAdapters, HoplonEngine } from './types.js';
import { createHoplonEngine } from './createHoplonEngine.js';
import { createNoopAnalyzer } from '../adapters/staticAnalysis/noop.js';
import { assertGrammarsDirPresent, resolvePackagedGrammarsDir } from './grammarsDir.js';
import { DEFAULT_ENGINE_ID, DEFAULT_GIT_REPO_DIR } from './factoryConstants.js';

export type SemanticRuntimeAdapters = Partial<
  Pick<
    HoplonAdapters,
    | 'embedding'
    | 'vectorStore'
    | 'embeddingCache'
    | 'semanticIndexStore'
    | 'lexicalIndex'
    | 'vectorIndex'
    | 'semanticDocumentBuilder'
    | 'semanticStorageProfile'
  >
>;

export async function createDefaultHoplonEngine(opts: {
  /** Project filesystem root — all file paths are relative to this. */
  root: string;
  /** SQLite snapshot registry path. */
  dbPath: string;
  /** Hoplon internal git repo dir. Default: '.hoplon/repo'. */
  gitRepoDir?: string;
  /**
   * tree-sitter grammars directory. Default: the grammars bundled with the
   * installed hoplon package (resolved relative to the package on disk, NOT the
   * working directory). Validated up front — a missing/incomplete directory
   * throws EngineError({ kind: 'grammars_dir_missing' }) at construction.
   */
  grammarsDir?: string;
  /** Engine identity. Default: 'local-0'. */
  engineId?: string;
  /** Optional host-supplied structure-only event emitter. Default: noop. */
  emitter?: HoplonAdapters['emitter'];
  /**
   * Explicit host-supplied semantic runtime adapters.
   *
   * Omitted by default, so semantic search remains UNAVAILABLE until a host
   * injects a real runtime. Optional packages such as sqlite-vec bind through
   * this slot; core never imports native semantic dependencies.
   */
  semanticRuntime?: SemanticRuntimeAdapters;
}): Promise<HoplonEngine> {
  const [
    { createNodeFsAdapter },
    { createIsomorphicGitVersioning },
    { createSqliteSnapshotStore },
    { createAsyncMutexLockProvider },
    { createNoopEmitter },
    { createTreeSitterIntelligence },
    { createBuiltinRegexScanner },
  ] = await Promise.all([
    import('../adapters/fs/node.js'),
    import('../adapters/versioning/isomorphicGit.js'),
    import('../adapters/snapshot-store-sqlite.js'),
    import('../adapters/lock-async-mutex.js'),
    import('../adapters/emitter/noop.js'),
    import('../adapters/codeIntelligence/treeSitter.js'),
    import('../adapters/secretScanner/builtin.js'),
  ]);

  const fs = createNodeFsAdapter({ root: opts.root });
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createSqliteSnapshotStore({ dbPath: opts.dbPath });
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = opts.emitter ?? createNoopEmitter();
  // F1: prefer an explicit grammarsDir; otherwise fall back to the grammars
  // packaged with the installed hoplon package (never the working directory).
  // Validate presence up front with a typed, actionable error instead of a
  // deferred parser-init failure deep inside the tree-sitter adapter.
  const grammarsDir = opts.grammarsDir ?? resolvePackagedGrammarsDir();
  assertGrammarsDirPresent(grammarsDir, {
    engineId: opts.engineId ?? DEFAULT_ENGINE_ID,
    correlationId: 'factory',
  });
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir,
  });
  const secretScanner = createBuiltinRegexScanner();
  const staticAnalysis = createNoopAnalyzer();

  return createHoplonEngine(
    {
      fs,
      versioning,
      snapshotStore,
      lockProvider,
      emitter,
      codeIntelligence,
      secretScanner,
      staticAnalysis,
      ...(opts.semanticRuntime ?? {}),
    },
    {
      engineId: opts.engineId ?? DEFAULT_ENGINE_ID,
      gitRepoDir: opts.gitRepoDir ?? DEFAULT_GIT_REPO_DIR,
      fsRoot: opts.root,
    },
  );
}
