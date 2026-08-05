/**
 * tests/launcher/projectPolicyShowCli.test.ts — t-086 proof for the
 * `hoplon project policy show` CLI subcommand.
 *
 * Covers parser + runner via `parseProjectCommand` /
 * `runProjectCommand` so the same dispatcher tests in
 * `tests/launcher/cli.test.ts` already exercise share their fixtures.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseProjectCommand,
  runProjectCommand,
  type ProjectPolicySummaryReport,
} from '../../src/hoplon/launcher/projectCli.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};
const FUTURE_EXPIRY_ISO = '2999-01-01T00:00:00.000Z';

describe('hoplon project policy show (t-086)', () => {
  it('parses `policy show --project-id p1` into a policy-show plan', () => {
    const parsed = parseProjectCommand(['policy', 'show', '--project-id', 'p1']);
    expect(parsed).toEqual({ kind: 'policy-show', projectId: 'p1' });
  });

  it('rejects unknown policy subcommands with a typed error', () => {
    const parsed = parseProjectCommand(['policy', 'wat', '--project-id', 'p1']);
    expect(parsed).toEqual({
      kind: 'error',
      message: 'Unknown policy subcommand: wat',
    });
  });

  it('rejects missing --project-id', () => {
    const parsed = parseProjectCommand(['policy', 'show']);
    expect(parsed).toEqual({
      kind: 'error',
      message: 'policy show requires --project-id',
    });
  });

  it('returns a content-safe summary with policy + engagement state', () => {
    const launcherRoot = tmpDir('hoplon-t086-cli-show-');
    const fsRoot = tmpDir('hoplon-t086-cli-show-fs-');
    const mgr = openLauncherProjects(launcherRoot);
    mgr.register({
      projectId: 'p1',
      fsRoot,
      policy: { folderPolicy: policy },
    });

    const engagementStore = createInMemoryEngagementStore();
    engagementStore.put('tok-x', {
      projectId: 'p1',
      folder: 'src',
      access: 'read_write',
      principalId: null,
      issuedAtIso: '2026-04-23T00:00:00.000Z',
      expiresAtIso: FUTURE_EXPIRY_ISO,
      nonce: 'nonce-x',
    });

    const outcome = runProjectCommand(
      { root: launcherRoot },
      { kind: 'policy-show', projectId: 'p1' },
      { engagementStore },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const body = outcome.body as ProjectPolicySummaryReport;
    expect(body.projectId).toBe('p1');
    expect(body.policy.folderPolicy).toEqual({
      defaultAccess: 'read_only',
      folderRuleCount: 2,
      principalCount: 0,
      engagementTokenTtlMs: 60_000,
    });
    expect(body.engagementState.active).toBe(1);
    expect(body.engagementState.activeReadWrite).toBe(1);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('tok-x');
    expect(serialized).not.toContain('nonce-x');
    expect(serialized).not.toContain('"folder":"src"');
  });

  it('returns a typed unknown_project failure for an unregistered project', () => {
    const launcherRoot = tmpDir('hoplon-t086-cli-unknown-');
    const outcome = runProjectCommand(
      { root: launcherRoot },
      { kind: 'policy-show', projectId: 'missing' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorKind).toBe('unknown_project');
    expect(outcome.message).toContain('missing');
  });
});
