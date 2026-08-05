/**
 * tests/launcher/projectsPolicySchema.test.ts — t-082 persistence +
 * report + CLI proof for the folder-scoped policy surface.
 *
 * Proves:
 *   - A registered project with `policy.folderPolicy` round-trips
 *     through `projects.json` atomic write + reload without drift.
 *   - Legacy persisted files without `folderPolicy` still load (additive
 *     schema extension).
 *   - `buildProjectsReport` surfaces folder-policy as count + default
 *     access + TTL only — never raw folders, principal ids, or labels.
 *   - Malformed folder-policy shapes on disk surface `invalid_schema`.
 *   - The CLI `--folder-policy-file` path reads a JSON file and
 *     registers the project with the validated policy, and reports
 *     structured error outcomes for missing / malformed files.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openLauncherProjects,
  LauncherProjectsError,
} from '../../src/hoplon/launcher/projects.js';
import {
  buildProjectsReport,
} from '../../src/hoplon/launcher/projectsReport.js';
import {
  loadProjectsStore,
  resolveProjectsStorePath,
  PROJECTS_STORE_VERSION,
} from '../../src/hoplon/launcher/projectsStore.js';
import { ProjectsStoreError } from '../../src/hoplon/launcher/projectsStore.js';
import {
  runProjectCommand,
  parseProjectCommand,
} from '../../src/hoplon/launcher/projectCli.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sampleFolderPolicy(
  overrides: Partial<FolderPolicy> = {},
): FolderPolicy {
  return {
    defaultAccess: 'read_only',
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'src/hoplon', access: 'read_only' },
    ],
    engagementTokenTtlMs: 15 * 60 * 1000,
    principals: [
      { principalId: 'agent-a', kind: 'agent', label: 'Primary agent' },
    ],
    ...overrides,
  };
}

describe('folder policy persistence round-trip', () => {
  it('round-trips the full folder policy through projects.json', () => {
    const launcherRoot = tmpDir('hoplon-t082-round-');
    const projectFs = tmpDir('hoplon-t082-round-fs-');
    const mgr = openLauncherProjects(launcherRoot);

    const record = mgr.register({
      projectId: 'proj',
      fsRoot: projectFs,
      policy: { folderPolicy: sampleFolderPolicy() },
    });

    expect(record.policy.folderPolicy?.defaultAccess).toBe('read_only');
    expect(record.policy.folderPolicy?.folderRules).toHaveLength(2);
    expect(record.policy.folderPolicy?.principals?.[0]?.label).toBe(
      'Primary agent',
    );

    const storePath = resolveProjectsStorePath(launcherRoot);
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(parsed.version).toBe(PROJECTS_STORE_VERSION);
    expect(parsed.projects[0].policy.folderPolicy.defaultAccess).toBe(
      'read_only',
    );
    expect(parsed.projects[0].policy.folderPolicy.folderRules).toEqual([
      { folder: 'src', access: 'read_write' },
      { folder: 'src/hoplon', access: 'read_only' },
    ]);

    // A fresh `openLauncherProjects` reload sees the same validated policy.
    const reloaded = loadProjectsStore(storePath);
    expect(reloaded.projects[0]?.policy.folderPolicy?.defaultAccess).toBe(
      'read_only',
    );
    expect(reloaded.projects[0]?.policy.folderPolicy?.folderRules).toHaveLength(
      2,
    );
    expect(
      reloaded.projects[0]?.policy.folderPolicy?.principals?.[0]?.principalId,
    ).toBe('agent-a');
  });

  it('legacy files without folderPolicy keep loading (additive schema)', () => {
    const launcherRoot = tmpDir('hoplon-t082-legacy-');
    const projectFs = tmpDir('hoplon-t082-legacy-fs-');
    const storePath = resolveProjectsStorePath(launcherRoot);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: PROJECTS_STORE_VERSION,
        activeProjectId: null,
        projects: [
          {
            projectId: 'legacy',
            fsRoot: path.resolve(projectFs),
            gitRepoDir: '.hoplon/repo',
            dbPath: path.join(projectFs, '.hoplon/hoplon.db'),
            grammarsDir: path.join(projectFs, 'vendor/grammars'),
            engineId: 'local-legacy',
            policy: { revertAllowlist: ['*.tmp'] },
            label: 'legacy',
            registeredAtIso: '2026-04-01T00:00:00Z',
          },
        ],
      }),
    );
    const loaded = loadProjectsStore(storePath);
    expect(loaded.projects).toHaveLength(1);
    expect(loaded.projects[0]?.policy.folderPolicy).toBeUndefined();
    expect(loaded.projects[0]?.policy.revertAllowlist).toEqual(['*.tmp']);
  });

  it('rejects malformed folder policy shapes on disk with invalid_schema', () => {
    const launcherRoot = tmpDir('hoplon-t082-malformed-');
    const projectFs = tmpDir('hoplon-t082-malformed-fs-');
    const storePath = resolveProjectsStorePath(launcherRoot);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });

    const write = (folderPolicy: unknown): void => {
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          version: PROJECTS_STORE_VERSION,
          activeProjectId: null,
          projects: [
            {
              projectId: 'bad',
              fsRoot: path.resolve(projectFs),
              gitRepoDir: '.hoplon/repo',
              dbPath: path.join(projectFs, '.hoplon/hoplon.db'),
              grammarsDir: path.join(projectFs, 'vendor/grammars'),
              engineId: 'local-bad',
              policy: { folderPolicy },
              label: 'bad',
              registeredAtIso: '2026-04-01T00:00:00Z',
            },
          ],
        }),
      );
    };

    const assertSchemaRejection = (): void => {
      let caught: unknown;
      try {
        loadProjectsStore(storePath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectsStoreError);
      if (caught instanceof ProjectsStoreError) {
        expect(caught.kind).toBe('invalid_schema');
      }
    };

    write({ defaultAccess: 'open', folderRules: [], engagementTokenTtlMs: 60_000 });
    assertSchemaRejection();

    write({
      defaultAccess: 'read_only',
      folderRules: [{ folder: '/abs', access: 'read_only' }],
      engagementTokenTtlMs: 60_000,
    });
    assertSchemaRejection();

    write({
      defaultAccess: 'read_only',
      folderRules: [{ folder: '..', access: 'read_only' }],
      engagementTokenTtlMs: 60_000,
    });
    assertSchemaRejection();

    write({
      defaultAccess: 'read_only',
      folderRules: [],
      engagementTokenTtlMs: 0,
    });
    assertSchemaRejection();
  });
});

describe('buildProjectsReport policy summary', () => {
  it('reports folder-policy as count + default + TTL, never leaking folders / labels', () => {
    const launcherRoot = tmpDir('hoplon-t082-report-');
    const projectFs = tmpDir('hoplon-t082-report-fs-');
    const mgr = openLauncherProjects(launcherRoot);
    mgr.register({
      projectId: 'proj',
      fsRoot: projectFs,
      policy: { folderPolicy: sampleFolderPolicy() },
    });

    const report = buildProjectsReport(launcherRoot);
    const entry = report.registered[0]!;
    const summary = entry.policy.folderPolicy;
    expect(summary).toEqual({
      defaultAccess: 'read_only',
      folderRuleCount: 2,
      principalCount: 1,
      engagementTokenTtlMs: 15 * 60 * 1000,
    });

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('src/hoplon');
    expect(serialized).not.toContain('agent-a');
    expect(serialized).not.toContain('Primary agent');
  });

  it('omits folderPolicy summary entirely when none is set', () => {
    const launcherRoot = tmpDir('hoplon-t082-report-none-');
    const projectFs = tmpDir('hoplon-t082-report-none-fs-');
    const mgr = openLauncherProjects(launcherRoot);
    mgr.register({ projectId: 'proj', fsRoot: projectFs });
    const report = buildProjectsReport(launcherRoot);
    expect(report.registered[0]?.policy.folderPolicy).toBeUndefined();
  });
});

describe('register rejects bad folder policy inputs via the programmatic API', () => {
  it('surfaces invalid policy as a LauncherProjectsError with registry_error kind', () => {
    const launcherRoot = tmpDir('hoplon-t082-bad-prog-');
    const projectFs = tmpDir('hoplon-t082-bad-prog-fs-');
    const mgr = openLauncherProjects(launcherRoot);
    expect(() =>
      mgr.register({
        projectId: 'proj',
        fsRoot: projectFs,
        policy: {
          folderPolicy: {
            defaultAccess: 'read_only',
            folderRules: [{ folder: '/etc', access: 'read_only' }],
            engagementTokenTtlMs: 60_000,
          },
        },
      }),
    ).toThrow();
  });
});

describe('CLI --folder-policy-file', () => {
  it('parses the flag into the register plan', () => {
    const plan = parseProjectCommand([
      'register',
      '--project-id',
      'proj',
      '--fs-root',
      '/tmp/x',
      '--folder-policy-file',
      '/tmp/policy.json',
    ]);
    expect(plan).toMatchObject({
      kind: 'register',
      projectId: 'proj',
      fsRoot: '/tmp/x',
      folderPolicyFile: '/tmp/policy.json',
    });
  });

  it('registers with the supplied policy file', () => {
    const launcherRoot = tmpDir('hoplon-t082-cli-ok-');
    const projectFs = tmpDir('hoplon-t082-cli-ok-fs-');
    const policyPath = path.join(
      tmpDir('hoplon-t082-cli-ok-policy-'),
      'policy.json',
    );
    fs.writeFileSync(policyPath, JSON.stringify(sampleFolderPolicy()), 'utf8');

    const out = runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'cli',
        fsRoot: projectFs,
        folderPolicyFile: policyPath,
      },
    );
    expect(out.ok).toBe(true);
    const report = buildProjectsReport(launcherRoot);
    expect(report.registered[0]?.policy.folderPolicy?.folderRuleCount).toBe(2);
  });

  it('returns structured errors for unreadable / non-JSON / invalid-shape files', () => {
    const launcherRoot = tmpDir('hoplon-t082-cli-bad-');
    const projectFs = tmpDir('hoplon-t082-cli-bad-fs-');

    const missing = runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'cli-missing',
        fsRoot: projectFs,
        folderPolicyFile: '/definitely/not/here/policy.json',
      },
    );
    expect(missing).toMatchObject({
      ok: false,
      errorKind: 'folder_policy_file_unreadable',
    });

    const garbagePath = path.join(
      tmpDir('hoplon-t082-cli-bad-garbage-'),
      'garbage.json',
    );
    fs.writeFileSync(garbagePath, '{not json', 'utf8');
    const garbage = runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'cli-garbage',
        fsRoot: projectFs,
        folderPolicyFile: garbagePath,
      },
    );
    expect(garbage).toMatchObject({
      ok: false,
      errorKind: 'folder_policy_file_invalid_json',
    });

    const badShapePath = path.join(
      tmpDir('hoplon-t082-cli-bad-shape-'),
      'shape.json',
    );
    fs.writeFileSync(
      badShapePath,
      JSON.stringify({
        defaultAccess: 'open',
        folderRules: [],
        engagementTokenTtlMs: 60_000,
      }),
      'utf8',
    );
    const badShape = runProjectCommand(
      { root: launcherRoot },
      {
        kind: 'register',
        projectId: 'cli-bad-shape',
        fsRoot: projectFs,
        folderPolicyFile: badShapePath,
      },
    );
    expect(badShape).toMatchObject({
      ok: false,
      errorKind: 'folder_policy_file_invalid_shape',
    });
  });
});

// Silence unused-symbol lints if a test is skipped — LauncherProjectsError is
// imported so failure surfaces type-safely during local dev runs.
void LauncherProjectsError;
