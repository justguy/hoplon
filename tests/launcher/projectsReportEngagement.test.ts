/**
 * tests/launcher/projectsReportEngagement.test.ts — t-086 proof that
 * `buildProjectsReport` derives the engagement-state summary from the
 * launcher-root engagement store without leaking folder paths,
 * principal labels, or token bytes.
 *
 * Drives the in-memory `EngagementStore` directly so the assertions
 * stay deterministic. The same store instance is the one HTTP/MCP/CLI
 * surfaces share in production via `openEngagementStore`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import { buildProjectsReport } from '../../src/hoplon/launcher/projectsReport.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { EngagementTokenBinding } from '../../src/hoplon/concurrency/projectPolicy.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'docs', access: 'read_only' },
  ],
};

function makeBinding(opts: {
  projectId: string;
  folder: string;
  access: 'read_only' | 'read_write';
  expiresAtIso: string;
  principalId?: string | null;
  nonce?: string;
}): EngagementTokenBinding {
  return Object.freeze({
    projectId: opts.projectId,
    folder: opts.folder,
    access: opts.access,
    principalId: opts.principalId ?? null,
    issuedAtIso: '2026-04-23T00:00:00.000Z',
    expiresAtIso: opts.expiresAtIso,
    nonce: opts.nonce ?? `nonce-${opts.folder}`,
  });
}

describe('t-086 buildProjectsReport engagement state', () => {
  it('reports zero counts when no bindings exist for a project', () => {
    const root = tmpDir('hoplon-t086-empty-');
    const fsRoot = tmpDir('hoplon-t086-empty-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'p1',
      fsRoot,
      policy: { folderPolicy: policy },
    });
    const store = createInMemoryEngagementStore();
    const report = buildProjectsReport(root, {
      engagementStore: store,
      now: new Date('2026-04-23T00:30:00.000Z'),
    });
    const entry = report.registered.find((p) => p.projectId === 'p1')!;
    expect(entry.engagementState).toEqual({
      active: 0,
      activeReadOnly: 0,
      activeReadWrite: 0,
      expiredOrMalformed: 0,
      soonestExpiryIso: null,
    });
  });

  it('aggregates active read_only / read_write bindings per project and reports the soonest expiry', () => {
    const root = tmpDir('hoplon-t086-counts-');
    const fsRootA = tmpDir('hoplon-t086-counts-a-');
    const fsRootB = tmpDir('hoplon-t086-counts-b-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'pA',
      fsRoot: fsRootA,
      policy: { folderPolicy: policy },
    });
    mgr.register({
      projectId: 'pB',
      fsRoot: fsRootB,
      policy: { folderPolicy: policy },
    });

    const store = createInMemoryEngagementStore();
    store.put(
      'tok-a-1',
      makeBinding({
        projectId: 'pA',
        folder: 'src',
        access: 'read_write',
        expiresAtIso: '2026-04-23T01:00:00.000Z',
      }),
    );
    store.put(
      'tok-a-2',
      makeBinding({
        projectId: 'pA',
        folder: 'docs',
        access: 'read_only',
        expiresAtIso: '2026-04-23T00:45:00.000Z',
      }),
    );
    store.put(
      'tok-b-1',
      makeBinding({
        projectId: 'pB',
        folder: 'src',
        access: 'read_write',
        expiresAtIso: '2026-04-23T02:00:00.000Z',
      }),
    );

    const report = buildProjectsReport(root, {
      engagementStore: store,
      now: new Date('2026-04-23T00:30:00.000Z'),
    });
    const a = report.registered.find((p) => p.projectId === 'pA')!;
    const b = report.registered.find((p) => p.projectId === 'pB')!;
    expect(a.engagementState).toEqual({
      active: 2,
      activeReadOnly: 1,
      activeReadWrite: 1,
      expiredOrMalformed: 0,
      soonestExpiryIso: '2026-04-23T00:45:00.000Z',
    });
    expect(b.engagementState).toEqual({
      active: 1,
      activeReadOnly: 0,
      activeReadWrite: 1,
      expiredOrMalformed: 0,
      soonestExpiryIso: '2026-04-23T02:00:00.000Z',
    });
  });

  it('reports expired bindings under expiredOrMalformed and excludes them from soonestExpiry', () => {
    const root = tmpDir('hoplon-t086-expired-');
    const fsRoot = tmpDir('hoplon-t086-expired-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'p1',
      fsRoot,
      policy: { folderPolicy: policy },
    });

    const store = createInMemoryEngagementStore();
    store.put(
      'tok-live',
      makeBinding({
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        expiresAtIso: '2026-04-23T01:30:00.000Z',
      }),
    );
    store.put(
      'tok-expired',
      makeBinding({
        projectId: 'p1',
        folder: 'docs',
        access: 'read_only',
        expiresAtIso: '2026-04-23T00:00:00.000Z',
      }),
    );
    store.put(
      'tok-malformed',
      makeBinding({
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        expiresAtIso: 'not-an-iso',
      }),
    );

    const report = buildProjectsReport(root, {
      engagementStore: store,
      now: new Date('2026-04-23T01:00:00.000Z'),
    });
    const entry = report.registered.find((p) => p.projectId === 'p1')!;
    expect(entry.engagementState.active).toBe(1);
    expect(entry.engagementState.activeReadWrite).toBe(1);
    expect(entry.engagementState.activeReadOnly).toBe(0);
    expect(entry.engagementState.expiredOrMalformed).toBe(2);
    expect(entry.engagementState.soonestExpiryIso).toBe(
      '2026-04-23T01:30:00.000Z',
    );
  });

  it('never leaks per-binding tokens, folder paths, or principal ids into the report', () => {
    const root = tmpDir('hoplon-t086-no-leak-');
    const fsRoot = tmpDir('hoplon-t086-no-leak-fs-');
    const mgr = openLauncherProjects(root);
    mgr.register({
      projectId: 'p1',
      fsRoot,
      policy: { folderPolicy: policy },
    });

    const store = createInMemoryEngagementStore();
    store.put(
      'TOKEN-DEADBEEF',
      makeBinding({
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        expiresAtIso: '2026-04-23T01:30:00.000Z',
        principalId: 'principal-secret',
        nonce: 'NONCE-SECRET',
      }),
    );

    const report = buildProjectsReport(root, {
      engagementStore: store,
      now: new Date('2026-04-23T01:00:00.000Z'),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('TOKEN-DEADBEEF');
    expect(serialized).not.toContain('NONCE-SECRET');
    expect(serialized).not.toContain('principal-secret');
    expect(serialized).not.toContain('"folder":"src"');
  });
});
