/**
 * tests/launcher/projects.test.ts — t-080 launcher projects surface.
 *
 * Proves:
 *   - register / list / select / unregister / clear-active persist to disk
 *     atomically and round-trip through a fresh launcher open
 *   - `runStatus().projects` reports the honest registered set, active
 *     pointer, and per-project policy summary
 *   - `hoplon project register / list / select / unregister` CLI paths
 *     return typed outcomes for happy path + unknown projectId + bad
 *     fsRoot + invalid projectId
 *   - Registrations survive process boundaries: one call writes, a
 *     second call reads the same file and sees the same entries
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  openLauncherProjects,
  LauncherProjectsError,
} from '../../src/hoplon/launcher/projects.js';
import {
  createProjectRegistry,
  ProjectRegistryError,
  createHoplonEngineRouter,
  EngineRouterError,
} from '../../src/hoplon/concurrency/index.js';
import type { HoplonEngine, EngineHealth } from '../../src/hoplon/engine/types.js';
import {
  loadProjectsStore,
  resolveProjectsStorePath,
  PROJECTS_STORE_VERSION,
} from '../../src/hoplon/launcher/projectsStore.js';
import { buildProjectsReport } from '../../src/hoplon/launcher/projectsReport.js';
import { runStatus } from '../../src/hoplon/launcher/status.js';
import {
  parseProjectCommand,
  runProjectCommand,
  PROJECT_HELP_TEXT,
} from '../../src/hoplon/launcher/projectCli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('openLauncherProjects', () => {
  it('returns an empty snapshot for a fresh launcher root', () => {
    const root = tmpDir('hoplon-projects-empty-');
    const mgr = openLauncherProjects(root);
    expect(mgr.list()).toEqual([]);
    expect(mgr.getActive()).toBeNull();
    expect(mgr.storePath).toBe(path.join(root, '.hoplon/projects.json'));
  });

  it('registers, persists, and re-loads the same entry', () => {
    const root = tmpDir('hoplon-projects-persist-');
    const projectFs = tmpDir('hoplon-projects-ent-');
    const mgr = openLauncherProjects(root);
    const record = mgr.register({
      projectId: 'dotfiles',
      fsRoot: projectFs,
      label: 'My dotfiles',
    });
    expect(record.projectId).toBe('dotfiles');
    expect(record.fsRoot).toBe(path.resolve(projectFs));
    expect(record.engineId).toBe('local-dotfiles');
    expect(record.dbPath.endsWith('.hoplon/hoplon.db')).toBe(true);
    expect(record.registeredAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const raw = fs.readFileSync(resolveProjectsStorePath(root), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(PROJECTS_STORE_VERSION);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].projectId).toBe('dotfiles');
    expect(parsed.activeProjectId).toBeNull();

    // A fresh open reads the same record back.
    const mgr2 = openLauncherProjects(root);
    expect(mgr2.list()).toHaveLength(1);
    expect(mgr2.list()[0]!.projectId).toBe('dotfiles');
    expect(mgr2.list()[0]!.fsRoot).toBe(path.resolve(projectFs));
  });

  it('rejects duplicate projectIds honestly', () => {
    const root = tmpDir('hoplon-projects-dup-');
    const project = tmpDir('hoplon-projects-dup-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({ projectId: 'proj', fsRoot: project });
    expect(() => mgr.register({ projectId: 'proj', fsRoot: project })).toThrow(
      LauncherProjectsError,
    );
  });

  it('rejects bad projectId characters', () => {
    const root = tmpDir('hoplon-projects-bad-id-');
    const project = tmpDir('hoplon-projects-bad-id-fs-');
    const mgr = openLauncherProjects(root);
    expect(() =>
      mgr.register({ projectId: 'bad/slash', fsRoot: project }),
    ).toThrow(LauncherProjectsError);
  });

  it('rejects fsRoot that does not exist', () => {
    const root = tmpDir('hoplon-projects-bad-root-');
    const mgr = openLauncherProjects(root);
    expect(() =>
      mgr.register({ projectId: 'ghost', fsRoot: '/definitely/not/here' }),
    ).toThrow(LauncherProjectsError);
  });

  it('supports setActive / getActive round-trip and clearing', () => {
    const root = tmpDir('hoplon-projects-active-');
    const a = tmpDir('hoplon-projects-active-a-');
    const b = tmpDir('hoplon-projects-active-b-');
    const mgr = openLauncherProjects(root);
    mgr.register({ projectId: 'alpha', fsRoot: a });
    mgr.register({ projectId: 'beta', fsRoot: b });
    mgr.setActive('beta');
    expect(mgr.getActive()?.projectId).toBe('beta');

    const reopened = openLauncherProjects(root);
    expect(reopened.getActive()?.projectId).toBe('beta');

    reopened.clearActive();
    expect(openLauncherProjects(root).getActive()).toBeNull();
  });

  it('unregistering the active project clears the active pointer', () => {
    const root = tmpDir('hoplon-projects-uad-');
    const a = tmpDir('hoplon-projects-uad-a-');
    const mgr = openLauncherProjects(root);
    mgr.register({ projectId: 'alpha', fsRoot: a });
    mgr.setActive('alpha');
    mgr.unregister('alpha');
    expect(mgr.list()).toEqual([]);
    expect(mgr.getActive()).toBeNull();
  });

  it('refuses to select an unknown project', () => {
    const root = tmpDir('hoplon-projects-unk-');
    const mgr = openLauncherProjects(root);
    expect(() => mgr.setActive('nope')).toThrow(LauncherProjectsError);
    expect(() => mgr.unregister('nope')).toThrow(LauncherProjectsError);
  });

  it('atomic write: no tmp file leaks after a successful register', () => {
    const root = tmpDir('hoplon-projects-atomic-');
    const project = tmpDir('hoplon-projects-atomic-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({ projectId: 'proj', fsRoot: project });
    const dir = path.join(root, '.hoplon');
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    expect(entries).toContain('projects.json');
  });

  it('loadProjectsStore silently drops stale activeProjectId on reload', () => {
    const root = tmpDir('hoplon-projects-stale-');
    const file = resolveProjectsStorePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: PROJECTS_STORE_VERSION,
        activeProjectId: 'ghost',
        projects: [],
      }),
    );
    const loaded = loadProjectsStore(file);
    expect(loaded.activeProjectId).toBeNull();
    expect(loaded.projects).toEqual([]);
  });
});

describe('project CLI parser', () => {
  it('parses list / clear-active / help without --project-id', () => {
    expect(parseProjectCommand(['list'])).toEqual({ kind: 'list' });
    expect(parseProjectCommand(['clear-active'])).toEqual({ kind: 'clear-active' });
    expect(parseProjectCommand(['--help'])).toEqual({ kind: 'help' });
    expect(parseProjectCommand([])).toEqual({ kind: 'help' });
  });

  it('documents host-owned registration in project help text', () => {
    expect(PROJECT_HELP_TEXT).toContain('MCP agents cannot mutate registration');
    expect(PROJECT_HELP_TEXT).toContain('trusted shell-capable agent');
    expect(PROJECT_HELP_TEXT).toContain('same launcher root');
    expect(PROJECT_HELP_TEXT).toContain('--folder-policy-file');
  });

  it('rejects register without --project-id or --fs-root', () => {
    expect(parseProjectCommand(['register'])).toMatchObject({ kind: 'error' });
    expect(
      parseProjectCommand(['register', '--project-id', 'x']),
    ).toMatchObject({ kind: 'error' });
    expect(
      parseProjectCommand(['register', '--fs-root', '/tmp/x']),
    ).toMatchObject({ kind: 'error' });
  });

  it('parses a full register command', () => {
    const plan = parseProjectCommand([
      'register',
      '--project-id',
      'dotfiles',
      '--fs-root',
      '/tmp/dots',
      '--label',
      'My dotfiles',
      '--engine-id',
      'local-dots',
    ]);
    expect(plan).toEqual({
      kind: 'register',
      projectId: 'dotfiles',
      fsRoot: '/tmp/dots',
      label: 'My dotfiles',
      engineId: 'local-dots',
    });
  });

  it('parses select / unregister / show with --project-id', () => {
    expect(
      parseProjectCommand(['select', '--project-id', 'alpha']),
    ).toEqual({ kind: 'select', projectId: 'alpha' });
    expect(
      parseProjectCommand(['unregister', '--project-id', 'alpha']),
    ).toEqual({ kind: 'unregister', projectId: 'alpha' });
    expect(
      parseProjectCommand(['show', '--project-id', 'alpha']),
    ).toEqual({ kind: 'show', projectId: 'alpha' });
  });

  it('errors on unknown subcommands', () => {
    expect(parseProjectCommand(['foo'])).toMatchObject({ kind: 'error' });
  });
});

describe('runProjectCommand', () => {
  it('runs list / register / select / unregister through the CLI entry', () => {
    const root = tmpDir('hoplon-projects-cli-');
    const projectA = tmpDir('hoplon-projects-cli-a-');
    const projectB = tmpDir('hoplon-projects-cli-b-');

    const list0 = runProjectCommand({ root }, { kind: 'list' });
    expect(list0.ok).toBe(true);

    const reg = runProjectCommand(
      { root },
      { kind: 'register', projectId: 'alpha', fsRoot: projectA },
    );
    expect(reg.ok).toBe(true);

    const sel = runProjectCommand(
      { root },
      { kind: 'select', projectId: 'alpha' },
    );
    expect(sel.ok).toBe(true);
    expect((sel as { ok: true; body: { active: string } }).body.active).toBe('alpha');

    const reg2 = runProjectCommand(
      { root },
      { kind: 'register', projectId: 'beta', fsRoot: projectB },
    );
    expect(reg2.ok).toBe(true);

    const list = runProjectCommand({ root }, { kind: 'list' });
    expect(list.ok).toBe(true);
    const body = (list as { ok: true; body: { registered: { projectId: string }[] } }).body;
    expect(body.registered.map((p) => p.projectId).sort()).toEqual(['alpha', 'beta']);

    const unreg = runProjectCommand(
      { root },
      { kind: 'unregister', projectId: 'alpha' },
    );
    expect(unreg.ok).toBe(true);
  });

  it('returns an honest typed outcome on unknown projectId', () => {
    const root = tmpDir('hoplon-projects-cli-ghost-');
    const out = runProjectCommand(
      { root },
      { kind: 'select', projectId: 'ghost' },
    );
    expect(out).toMatchObject({ ok: false, errorKind: 'registry_error' });
  });

  it('returns an honest typed outcome on a missing fsRoot', () => {
    const root = tmpDir('hoplon-projects-cli-badroot-');
    const out = runProjectCommand(
      { root },
      {
        kind: 'register',
        projectId: 'ghost',
        fsRoot: '/definitely/not/here/either',
      },
    );
    expect(out).toMatchObject({ ok: false, errorKind: 'invalid_fs_root' });
  });
});

describe('runStatus projects report', () => {
  it('reports the persisted registry + active pointer + policy summary', async () => {
    const root = tmpDir('hoplon-status-projects-');
    const projectA = tmpDir('hoplon-status-projects-a-');
    const projectB = tmpDir('hoplon-status-projects-b-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'alpha',
      fsRoot: projectA,
      policy: {
        revertAllowlist: ['*.log'],
        maxFileBytes: 65536,
      },
    });
    mgr.register({ projectId: 'beta', fsRoot: projectB });
    mgr.setActive('beta');

    const report = await runStatus({ root, grammarsDir: GRAMMARS_DIR });
    expect(report.projects.launcherRoot).toBe(path.resolve(root));
    expect(report.projects.active?.projectId).toBe('beta');
    expect(report.projects.registered.map((p) => p.projectId).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    const alpha = report.projects.registered.find((p) => p.projectId === 'alpha')!;
    expect(alpha.policy.revertAllowlistCount).toBe(1);
    expect(alpha.policy.maxFileBytes).toBe(65536);
    expect(alpha.policy.secretPatternsCount).toBe(0);
  });

  it('reports an empty registry honestly on a fresh launcher root', async () => {
    const root = tmpDir('hoplon-status-fresh-');
    const report = await runStatus({ root, grammarsDir: GRAMMARS_DIR });
    expect(report.projects.launcherRoot).toBe(path.resolve(root));
    expect(report.projects.registered).toEqual([]);
    expect(report.projects.active).toBeNull();
  });
});

describe('buildProjectsReport', () => {
  it('serializes regex secretPatterns as count, never leaking patterns', () => {
    const root = tmpDir('hoplon-projects-secretcount-');
    const project = tmpDir('hoplon-projects-secretcount-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'proj',
      fsRoot: project,
      policy: { secretPatterns: [/FOO-[A-Z]+/g, /BAR-[0-9]+/g] },
    });
    const report = buildProjectsReport(root);
    const entry = report.registered[0]!;
    expect(entry.policy.secretPatternsCount).toBe(2);
    expect((entry.policy as Record<string, unknown>)['secretPatterns']).toBeUndefined();
  });
});

// -----------------------------------------------------------------------
// Pure registry + router behavior. Kept here (not tests/concurrency/*)
// because t-080's allowed test paths are tests/launcher/ + tests/integration/.
// The engineRouter is exercised with a fake HoplonEngine so the test stays
// pure data + in-memory — real engine integration is in projectIsolation.
// -----------------------------------------------------------------------

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

describe('createProjectRegistry (pure)', () => {
  it('registers and enforces uniqueness', () => {
    const reg = createProjectRegistry();
    reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' });
    expect(reg.has('alpha')).toBe(true);
    expect(() =>
      reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' }),
    ).toThrow(ProjectRegistryError);
  });

  it('rejects non-absolute fsRoot and bad projectIds', () => {
    const reg = createProjectRegistry();
    expect(() =>
      reg.register({ projectId: 'alpha', fsRoot: 'relative/path' }),
    ).toThrow(ProjectRegistryError);
    for (const bad of ['has space', 'has/slash', 'has\\back', '..dots']) {
      expect(
        () => reg.register({ projectId: bad, fsRoot: '/tmp/x' }),
        bad,
      ).toThrow(ProjectRegistryError);
    }
  });

  it('seeds with activeProjectId validation', () => {
    expect(() =>
      createProjectRegistry({ seed: [], activeProjectId: 'ghost' }),
    ).toThrow(ProjectRegistryError);
  });

  it('lists projects sorted by id', () => {
    const reg = createProjectRegistry();
    reg.register({ projectId: 'zeta', fsRoot: '/tmp/zeta' });
    reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' });
    expect(reg.list().map((p) => p.projectId)).toEqual(['alpha', 'zeta']);
  });
});

describe('HoplonEngineRouter', () => {
  it('acquires distinct engines per registered project and caches them', async () => {
    const reg = createProjectRegistry();
    reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' });
    reg.register({ projectId: 'beta', fsRoot: '/tmp/beta' });
    let builds = 0;
    const router = createHoplonEngineRouter({
      registry: reg,
      buildEngine: async (p) => {
        builds++;
        return fakeEngine(p.projectId);
      },
    });
    const a = await router.acquire('alpha');
    const b = await router.acquire('beta');
    expect(a).not.toBe(b);
    await router.acquire('alpha');
    expect(builds).toBe(2);
    expect(router.cachedProjectIds().sort()).toEqual(['alpha', 'beta']);
  });

  it('throws typed EngineRouterError on unknown projectId', async () => {
    const reg = createProjectRegistry();
    const router = createHoplonEngineRouter({
      registry: reg,
      buildEngine: async (p) => fakeEngine(p.projectId),
    });
    await expect(router.acquire('ghost')).rejects.toBeInstanceOf(EngineRouterError);
  });

  it('resolve() prefers explicit projectId and falls back to active', async () => {
    const reg = createProjectRegistry();
    reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' });
    reg.register({ projectId: 'beta', fsRoot: '/tmp/beta' });
    reg.setActive('beta');
    const router = createHoplonEngineRouter({
      registry: reg,
      buildEngine: async (p) => fakeEngine(p.projectId),
    });
    const explicit = await router.resolve({ projectId: 'alpha' });
    expect(explicit.resolvedFrom).toBe('explicit');
    expect(explicit.project.projectId).toBe('alpha');
    const defaulted = await router.resolve({});
    expect(defaulted.resolvedFrom).toBe('active');
    expect(defaulted.project.projectId).toBe('beta');
  });

  it('coalesces concurrent acquires for the same projectId', async () => {
    const reg = createProjectRegistry();
    reg.register({ projectId: 'alpha', fsRoot: '/tmp/alpha' });
    let builds = 0;
    const router = createHoplonEngineRouter({
      registry: reg,
      buildEngine: async (p) => {
        builds++;
        await new Promise((r) => setTimeout(r, 10));
        return fakeEngine(p.projectId);
      },
    });
    const [a, b] = await Promise.all([
      router.acquire('alpha'),
      router.acquire('alpha'),
    ]);
    expect(a).toBe(b);
    expect(builds).toBe(1);
  });
});
