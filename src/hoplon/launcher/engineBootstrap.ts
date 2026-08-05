/**
 * launcher/engineBootstrap.ts — shared engine-construction helper for the
 * launcher surface.
 *
 * `runStatus`, `runMcpServe`, `runHttpServe`, and the query subcommands all
 * need to resolve a workspace config and construct a default engine against
 * it. This helper centralizes that wiring so the launcher never forks core
 * engine construction — it only delegates to `createDefaultHoplonEngine`.
 *
 * Honest reporting discipline: every caller receives the same `engineId`
 * and resolved `workspace` paths the engine was actually built with, so
 * downstream envelopes cannot drift from the engine's identity (H5).
 */

import { resolveLauncherWorkspace, ensureWorkspaceLayout } from './config.js';
import type { LauncherWorkspaceConfig, LauncherWorkspaceInput } from './config.js';
import { createDefaultHoplonEngine, createHoplonEngine } from '../engine/factory.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import { assertGrammarsDirPresent } from '../engine/grammarsDir.js';
import type { HoplonEngine } from '../engine/types.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { RegisteredProject } from '../concurrency/projectRegistry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BootstrappedEngine {
  engine: HoplonEngine;
  workspace: LauncherWorkspaceConfig;
  engineId: string;
}

export interface EngineBootstrapInput extends LauncherWorkspaceInput {
  /**
   * Optional host-supplied semantic runtime binding. This is the launcher
   * injection path for optional packages; core launcher code never imports
   * native semantic dependencies directly.
   */
  semanticRuntime?: SemanticRuntimeAdapters;
  emitter?: HoplonEmitter;
}

/**
 * Resolve the launcher workspace for `input`, ensure the on-disk layout
 * exists, and construct a default Hoplon engine against it. Returns the
 * engine plus the resolved workspace for the caller to render truthfully.
 */
export async function bootstrapEngineForWorkspace(
  input: EngineBootstrapInput = {},
): Promise<BootstrappedEngine> {
  const workspace = resolveLauncherWorkspace(input);
  ensureWorkspaceLayout(workspace);

  const engine = await createDefaultHoplonEngine({
    root: workspace.root,
    dbPath: workspace.dbPath,
    gitRepoDir: workspace.gitRepoDir,
    grammarsDir: workspace.grammarsDir,
    engineId: workspace.engineId,
    ...(input.semanticRuntime !== undefined
      ? { semanticRuntime: input.semanticRuntime }
      : {}),
    ...(input.emitter !== undefined ? { emitter: input.emitter } : {}),
  });

  return { engine, workspace, engineId: workspace.engineId };
}

/**
 * Build a HoplonEngine against a registered project record (t-080).
 *
 * Used by the engine router to construct per-project engines keyed by
 * projectId. Each engine owns its own fsRoot, gitRepoDir, dbPath,
 * grammarsDir, and engineId — so cross-project snapshot / lock / audit
 * bleed is structurally impossible (no shared adapter state between
 * per-project engines).
 *
 * Per-project policy (revertAllowlist, secretPatterns, maxFileBytes,
 * parseTimeoutMs) is threaded through the engine config so the
 * live engine sees only this project's policy surface.
 */
export async function buildEngineForRegisteredProject(
  project: RegisteredProject,
  semanticRuntime?: SemanticRuntimeAdapters,
  emitterOverride?: HoplonEmitter,
): Promise<HoplonEngine> {
  // F1: fail fast with a typed, actionable error if this project's grammars
  // directory is missing/incomplete, instead of a deferred parser-init failure
  // deep inside the tree-sitter adapter. Covers both the policy and non-policy
  // build paths below.
  assertGrammarsDirPresent(project.grammarsDir, {
    engineId: project.engineId,
    correlationId: 'bootstrap',
  });

  // Materialize the project's internal directories (.hoplon, repo) so
  // the default adapters can open their backing files without surprise.
  try {
    fs.mkdirSync(path.dirname(project.dbPath), { recursive: true });
  } catch {
    // Real errors surface later via the typed HoplonError from the adapter.
  }
  try {
    const repoDir = path.isAbsolute(project.gitRepoDir)
      ? project.gitRepoDir
      : path.join(project.fsRoot, project.gitRepoDir);
    fs.mkdirSync(repoDir, { recursive: true });
  } catch {
    // Same as above.
  }

  // The default factory wires Phase 1 adapters; policy knobs still
  // need to flow through the per-engine config. createDefaultHoplonEngine
  // doesn't yet accept policy knobs, so compose the bundle manually
  // when any are set.
  if (registeredProjectHasPolicy(project)) {
    return buildEngineWithPolicy(project, semanticRuntime, emitterOverride);
  }

  return createDefaultHoplonEngine({
    root: project.fsRoot,
    dbPath: project.dbPath,
    gitRepoDir: project.gitRepoDir,
    grammarsDir: project.grammarsDir,
    engineId: project.engineId,
    ...(semanticRuntime !== undefined ? { semanticRuntime } : {}),
    ...(emitterOverride !== undefined ? { emitter: emitterOverride } : {}),
  });
}

function registeredProjectHasPolicy(project: RegisteredProject): boolean {
  const p = project.policy;
  return (
    (p.revertAllowlist !== undefined && p.revertAllowlist.length > 0) ||
    (p.secretPatterns !== undefined && p.secretPatterns.length > 0) ||
    p.maxFileBytes !== undefined ||
    p.parseTimeoutMs !== undefined
  );
}

async function buildEngineWithPolicy(
  project: RegisteredProject,
  semanticRuntime?: SemanticRuntimeAdapters,
  emitterOverride?: HoplonEmitter,
): Promise<HoplonEngine> {
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

  const nodeFs = createNodeFsAdapter({ root: project.fsRoot });
  const versioning = createIsomorphicGitVersioning({ fs: nodeFs });
  const snapshotStore = await createSqliteSnapshotStore({ dbPath: project.dbPath });
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = emitterOverride ?? createNoopEmitter();
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: project.grammarsDir,
  });
  // Per-project secret-scan patterns are turned into named BuiltinPattern
  // entries so the scanner reports them with a stable per-project prefix.
  const secretScanner = createBuiltinRegexScanner(
    project.policy.secretPatterns !== undefined
      ? {
          patterns: project.policy.secretPatterns.map((r, idx) => ({
            name: `PROJECT_${project.projectId.toUpperCase()}_PATTERN_${idx}`,
            regex: r.global ? r : new RegExp(r.source, `${r.flags}g`),
          })),
        }
      : undefined,
  );

  const engineConfig: Parameters<typeof createHoplonEngine>[1] = {
    engineId: project.engineId,
    gitRepoDir: project.gitRepoDir,
    fsRoot: project.fsRoot,
  };
  if (project.policy.revertAllowlist !== undefined) {
    engineConfig.revertAllowlist = [...project.policy.revertAllowlist];
  }
  if (project.policy.maxFileBytes !== undefined) {
    engineConfig.maxFileBytes = project.policy.maxFileBytes;
  }
  if (project.policy.parseTimeoutMs !== undefined) {
    engineConfig.parseTimeoutMs = project.policy.parseTimeoutMs;
  }

  return createHoplonEngine(
    {
      fs: nodeFs,
      versioning,
      snapshotStore,
      lockProvider,
      emitter,
      codeIntelligence,
      secretScanner,
      ...(semanticRuntime ?? {}),
    },
    engineConfig,
  );
}

/**
 * Resolve a launcher workspace and construct a read-only engine for the
 * bounded `hoplon query ...` surface.
 *
 * This path intentionally avoids ensureWorkspaceLayout() and the file-backed
 * SQLite snapshot store used by the mutable launcher surfaces. The first
 * query slice is live-workspace-only, so an in-memory snapshot store keeps
 * the query surface from creating `.hoplon` state just to answer a read.
 */
export async function bootstrapReadOnlyQueryEngine(
  input: EngineBootstrapInput = {},
): Promise<BootstrappedEngine> {
  const workspace = resolveLauncherWorkspace(input);

  const [
    { createNodeFsAdapter },
    { createIsomorphicGitVersioning },
    { createIsolatedTestStore },
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

  const fs = createNodeFsAdapter({ root: workspace.root });
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = input.emitter ?? createNoopEmitter();
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: workspace.grammarsDir,
  });
  const secretScanner = createBuiltinRegexScanner();

  const engine = await createHoplonEngine(
    {
      fs,
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

  return { engine, workspace, engineId: workspace.engineId };
}
