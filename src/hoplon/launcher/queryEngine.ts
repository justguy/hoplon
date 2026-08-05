/**
 * launcher/queryEngine.ts — read-only engine bootstrap for `hoplon query`.
 *
 * Query commands must not create workspace layout or persist a SQLite file just
 * to answer a structural read. This factory keeps the existing engine contract
 * but swaps the snapshot store to an isolated in-memory instance so the query
 * surface stays read-only on disk.
 */

import { createHoplonEngine } from '../engine/factory.js';
import type { HoplonEngine } from '../engine/types.js';
import type { LauncherWorkspaceConfig } from './config.js';

export async function createReadOnlyQueryEngine(
  workspace: LauncherWorkspaceConfig,
): Promise<HoplonEngine> {
  const [
    { createNodeFsAdapter },
    { createIsomorphicGitVersioning },
    { createIsolatedTestStore },
    { createAsyncMutexLockProvider },
    { createNoopEmitter },
    { createTreeSitterIntelligence },
    { createBuiltinRegexScanner },
    { createNoopAnalyzer },
  ] = await Promise.all([
    import('../adapters/fs/node.js'),
    import('../adapters/versioning/isomorphicGit.js'),
    import('../adapters/snapshot-store-sqlite.js'),
    import('../adapters/lock-async-mutex.js'),
    import('../adapters/emitter/noop.js'),
    import('../adapters/codeIntelligence/treeSitter.js'),
    import('../adapters/secretScanner/builtin.js'),
    import('../adapters/staticAnalysis/noop.js'),
  ]);

  const fs = createNodeFsAdapter({ root: workspace.root });

  return createHoplonEngine(
    {
      fs,
      versioning: createIsomorphicGitVersioning({ fs }),
      snapshotStore: await createIsolatedTestStore(),
      lockProvider: createAsyncMutexLockProvider(),
      emitter: createNoopEmitter(),
      codeIntelligence: await createTreeSitterIntelligence({
        grammarsDir: workspace.grammarsDir,
      }),
      secretScanner: createBuiltinRegexScanner(),
      staticAnalysis: createNoopAnalyzer(),
    },
    {
      engineId: workspace.engineId,
      gitRepoDir: workspace.gitRepoDir,
      fsRoot: workspace.root,
    },
  );
}
