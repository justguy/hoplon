/**
 * launcher/snapshotStoreBootstrap.ts — launcher engine bootstrap with
 * access to the backing SnapshotStore.
 *
 * Used by HTTP/MCP launcher serve paths that need read-only retrieval
 * surfaces over the same audit database the engine writes to.
 */

import type { LauncherWorkspaceInput } from './config.js';
import { resolveLauncherWorkspace, ensureWorkspaceLayout } from './config.js';
import { createHoplonEngine } from '../engine/factory.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { BootstrappedEngine } from './engineBootstrap.js';

export interface BootstrappedEngineWithStore extends BootstrappedEngine {
  snapshotStore: SnapshotStore;
  emitter: HoplonEmitter;
}

export interface SnapshotStoreBootstrapInput extends LauncherWorkspaceInput {
  semanticRuntime?: SemanticRuntimeAdapters;
  emitter?: HoplonEmitter;
}

export async function bootstrapEngineWithSnapshotStore(
  input: SnapshotStoreBootstrapInput = {},
): Promise<BootstrappedEngineWithStore> {
  const workspace = resolveLauncherWorkspace(input);
  ensureWorkspaceLayout(workspace);

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

  const nodeFs = createNodeFsAdapter({ root: workspace.root });
  const versioning = createIsomorphicGitVersioning({ fs: nodeFs });
  const snapshotStore = await createSqliteSnapshotStore({ dbPath: workspace.dbPath });
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = input.emitter ?? createNoopEmitter();
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: workspace.grammarsDir,
  });
  const secretScanner = createBuiltinRegexScanner();

  const engine = await createHoplonEngine(
    {
      fs: nodeFs,
      versioning,
      snapshotStore,
      lockProvider,
      emitter,
      codeIntelligence,
      secretScanner,
      ...(input.semanticRuntime ?? {}),
    },
    {
      engineId: workspace.engineId,
      gitRepoDir: workspace.gitRepoDir,
      fsRoot: workspace.root,
    },
  );

  return { engine, snapshotStore, emitter, workspace, engineId: workspace.engineId };
}
