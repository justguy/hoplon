/**
 * tests/launcher/projects.regression.test.ts — focused regressions for the
 * t-080 multi-project launcher surface.
 *
 * Covers concrete failure modes found in post-landing review:
 *   - repeated `openLauncherProjects(root)` calls in one process must share
 *     the same live registry so mutations cannot clobber each other
 *   - two projectIds may not silently point at the same fsRoot
 *   - unregistering a project must evict its cached engine routing truth
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openLauncherProjects, LauncherProjectsError } from '../../src/hoplon/launcher/projects.js';
import { createProjectRegistry, createHoplonEngineRouter, EngineRouterError } from '../../src/hoplon/concurrency/index.js';
import type { EngineHealth, HoplonEngine } from '../../src/hoplon/engine/types.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeEngine(id: string): HoplonEngine {
  const health: EngineHealth = {
    engineId: id,
    uptimeMs: 0,
    adapters: {
      fs: 'ok',
      versioning: 'ok',
      snapshotStore: 'ok',
      lockProvider: 'ok',
      emitter: 'ok',
      codeIntelligence: 'ok',
      secretScanner: 'ok',
      staticAnalysis: 'ok',
    },
    semantic: semanticHealth(),
  };
  const notImpl = (): never => {
    throw new Error('fake engine does not implement this op');
  };
  return {
    packContext: notImpl,
    createSnapshot: notImpl,
    auditDiff: notImpl,
    revertUncontracted: notImpl,
    dryRun: notImpl,
    preflight: notImpl,
    queryStructure: notImpl,
    extractStructuralTemplate: notImpl,
    extractRollbackTemplate: notImpl,
    getRelevantTests: notImpl,
    searchSymbols: notImpl,
    describeProject: notImpl,
    seeCodebase: notImpl,
    predictViolationRisk: notImpl,
    scoreAnomaly: notImpl,
    analyzeBlastRadius: notImpl,
    synthesizeInterfaceStubs: notImpl,
    ephemeralStructuralSandbox: notImpl,
    describeCapabilities: notImpl,
    semanticSearch: notImpl,
    indexSemanticCorpus: notImpl,
    health: async () => health,
    reconcile: async () => ({
      engineId: id,
      recoveredCount: 0,
      deletedOrphans: 0,
      remainingPending: 0,
    }),
    gc: async () => ({ deletedCount: 0 }),
    computeMinimalPatch: notImpl,
    compressRetryContext: notImpl,
  };
}

function semanticHealth(): EngineHealth['semantic'] {
  return {
    status: 'UNAVAILABLE',
    capabilityClass: 'seam_only',
    runtimeProfile: 'noop',
    persistenceMode: 'process_local_overlay',
    adapters: {
      embedding: 'noop',
      vectorStore: 'noop',
      embeddingCache: 'noop',
      semanticIndexStore: 'noop',
      lexicalIndex: 'noop',
      vectorIndex: 'noop',
      semanticStorageProfile: 'noop',
    },
    embedding: { modelStatus: 'missing', artifactStatus: 'missing' },
    runtimeArtifacts: { nativeExtensionStatus: 'unavailable' },
    cache: { reachable: false },
    index: { reachable: false },
    overlays: {
      activeOverlayCount: 0,
      reapedOverlayCount: 0,
      documentCount: 0,
      vectorCount: 0,
      maskCount: 0,
    },
    tombstones: { reachable: false },
    degradationReasons: [],
  };
}

describe('t-080 launcher regressions', () => {
  it('shares one live manager per launcher root so repeated opens cannot clobber prior mutations', () => {
    const launcherRoot = tmpDir('hoplon-projects-cache-');
    const alphaRoot = tmpDir('hoplon-projects-cache-alpha-');
    const betaRoot = tmpDir('hoplon-projects-cache-beta-');

    const first = openLauncherProjects(launcherRoot);
    const second = openLauncherProjects(launcherRoot);

    expect(first).toBe(second);
    first.register({ projectId: 'alpha', fsRoot: alphaRoot });
    second.register({ projectId: 'beta', fsRoot: betaRoot });

    expect(openLauncherProjects(launcherRoot).list().map((p) => p.projectId).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('rejects registering the same fsRoot under two projectIds', () => {
    const launcherRoot = tmpDir('hoplon-projects-dup-root-');
    const projectRoot = tmpDir('hoplon-projects-dup-root-target-');

    const manager = openLauncherProjects(launcherRoot);
    manager.register({ projectId: 'alpha', fsRoot: projectRoot });

    expect(() =>
      manager.register({ projectId: 'beta', fsRoot: projectRoot }),
    ).toThrow(LauncherProjectsError);
  });

  it('refuses stale cached engines after a project is unregistered', async () => {
    const registry = createProjectRegistry();
    registry.register({ projectId: 'alpha', fsRoot: '/tmp/hoplon-alpha' });

    const router = createHoplonEngineRouter({
      registry,
      buildEngine: async (project) => fakeEngine(project.projectId),
    });

    await router.acquire('alpha');
    expect(router.cachedProjectIds()).toEqual(['alpha']);

    registry.unregister('alpha');

    await expect(router.acquire('alpha')).rejects.toBeInstanceOf(EngineRouterError);
    expect(router.cachedProjectIds()).toEqual([]);
  });
});
