/** Async engine construction orchestration; phase details live in focused modules. */

import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { HoplonAdapters, HoplonEngine, HoplonEngineConfig } from './types.js';
import { reconcile as reconcileOp } from '../operations/reconcile.js';
import type { ReconcileDeps } from '../operations/reconcile.js';
import { resolveFactoryAdapters } from './factoryAdapterResolution.js';
import { resolveFactoryRuntimeConfig } from './factoryRuntimeConfig.js';
import { buildFactoryCoreDeps } from './factoryCoreDeps.js';
import { buildFactoryIntelligenceDeps } from './factoryIntelligenceDeps.js';
import { createFactoryFacade } from './factoryFacade.js';
import { DEFAULT_PENDING_ORPHAN_THRESHOLD_MS } from './factoryConstants.js';

const ENGINE_SNAPSHOT_STORE = Symbol('hoplon.engine.snapshotStore');
type SnapshotStoreBoundEngine = HoplonEngine & {
  readonly [ENGINE_SNAPSHOT_STORE]?: SnapshotStore;
};

export function getHoplonEngineSnapshotStore(
  engine: HoplonEngine,
): SnapshotStore | null {
  return (engine as SnapshotStoreBoundEngine)[ENGINE_SNAPSHOT_STORE] ?? null;
}

export async function createHoplonEngine(
  adapters: HoplonAdapters,
  config?: HoplonEngineConfig,
): Promise<HoplonEngine> {
  const resolution = resolveFactoryAdapters(adapters, config);
  const runtime = resolveFactoryRuntimeConfig(resolution, config);
  const { resolvedAdapters, engineId, gitRepoDir } = runtime;
  const reconcileDeps: ReconcileDeps = {
    snapshotStore: resolvedAdapters.snapshotStore,
    versioning: resolvedAdapters.versioning,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: {
      pendingOrphanThresholdMs: DEFAULT_PENDING_ORPHAN_THRESHOLD_MS,
      gitRepoDir,
    },
  };
  await reconcileOp(reconcileDeps);
  const core = buildFactoryCoreDeps(runtime);
  const intelligence = buildFactoryIntelligenceDeps(runtime, core);
  const engine = createFactoryFacade(core, intelligence, reconcileDeps);
  Object.defineProperty(engine, ENGINE_SNAPSHOT_STORE, {
    value: resolvedAdapters.snapshotStore,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return engine;
}
