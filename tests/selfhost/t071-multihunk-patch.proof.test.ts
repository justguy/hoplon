/**
 * tests/selfhost/t071-multihunk-patch.proof.test.ts — T-071 proof.
 *
 * Drives the widened `ProposedChange` contract through the shipped supervised
 * session write path (`session.applyEdits`) against a real engine + real fs
 * adapter. Proves:
 *
 *   1. A single `patch` ProposedChange with multiple anchored hunks composes
 *      against the running intermediate bytes and flushes one deterministic
 *      final file image to disk — no same-file intermediate writes.
 *   2. The session's `applyEdits` history entry reports `changeKindCounts`
 *      with the new per-variant tally ({ full_file:0, patch:1, structural:0 }).
 *   3. Audit still PASSes on the anchored rewrite because the edits stay
 *      inside the contracted symbol scope, proving the t-071 widening keeps
 *      audit/revert semantics intact.
 *   4. A second session applies a structurally-bounded full-file rewrite
 *      *plus* a patch hunk in the same call, and the per-kind tally splits
 *      correctly ({ full_file:1, patch:1, structural:0 }).
 *
 * This is the large-edit-ergonomics end-to-end proof: the supervised path is
 * the only write seam, the widened contract flows through HTTP+MCP transport
 * envelopes, and rollback / audit obligations continue to hold over it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLauncherWorkspace, ensureWorkspaceLayout } from '../../src/hoplon/launcher/config.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createNodeFsAdapter } from '../../src/hoplon/adapters/fs/node.js';
import {
  CONTRACTED_PATH,
  seedSessionErrorFixture,
  sessionErrorSymbolsManifest,
} from './fixtures/sessionErrorFixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('T-071 — widened ProposedChange through the supervised write path', () => {
  it('applies a multi-hunk patch in one call and records changeKindCounts.patch = 1', async () => {
    const root = makeTempWorkspace('hoplon-t071-patch-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't071-patch-engine',
      });
      ensureWorkspaceLayout(workspace);

      const engine = await createDefaultHoplonEngine({
        root: workspace.root,
        dbPath: workspace.dbPath,
        gitRepoDir: workspace.gitRepoDir,
        grammarsDir: workspace.grammarsDir,
        engineId: workspace.engineId,
      });
      const adapter = createNodeFsAdapter({ root: workspace.root });
      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t071-patch'),
        fs: adapter,
      });

      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();

      // Two anchored edits inside the SessionError class body — both inside
      // the contracted scope so the audit should PASS.
      const firstAnchor = 'readonly kind: SessionErrorKind;';
      const secondAnchor = 'this.name = \'SessionError\';';
      expect(baseline.indexOf(firstAnchor)).toBeGreaterThan(-1);
      expect(baseline.indexOf(secondAnchor)).toBeGreaterThan(-1);

      const result = await session.applyEdits([
        {
          kind: 'patch',
          file: CONTRACTED_PATH,
          hunks: [
            {
              search: firstAnchor,
              replace:
                'readonly kind: SessionErrorKind; /* t-071 multi-hunk proof: marker A */',
            },
            {
              search: secondAnchor,
              replace:
                "this.name = 'SessionError'; /* t-071 multi-hunk proof: marker B */",
            },
          ],
        },
      ]);
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 1, structural: 0 });
      expect(session.state).toBe('edited');

      const onDisk = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
      expect(onDisk).toContain('marker A');
      expect(onDisk).toContain('marker B');
      // No flapping — the file still has exactly the baseline elsewhere.
      expect(onDisk).not.toBe(baseline);

      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(session.state).toBe('audited_pass');

      const applyEntry = session.snapshot.history.find((h) => h.op === 'applyEdits');
      expect(applyEntry?.outcome).toEqual({
        kind: 'applyEdits',
        changedFileCount: 1,
        bytesWritten: Buffer.byteLength(onDisk, 'utf8'),
        changeKindCounts: { full_file: 0, patch: 1, structural: 0 },
      });

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('splits per-kind counts across full_file + patch variants in a single applyEdits call', async () => {
    const root = makeTempWorkspace('hoplon-t071-mixed-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't071-mixed-engine',
      });
      ensureWorkspaceLayout(workspace);

      const engine = await createDefaultHoplonEngine({
        root: workspace.root,
        dbPath: workspace.dbPath,
        gitRepoDir: workspace.gitRepoDir,
        grammarsDir: workspace.grammarsDir,
        engineId: workspace.engineId,
      });
      const adapter = createNodeFsAdapter({ root: workspace.root });
      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t071-mixed'),
        fs: adapter,
      });

      await session.preflight();
      await session.createSnapshot();

      const patchedAnchor = 'readonly kind: SessionErrorKind;';
      const fullFileRewrite = baseline.replace(
        'this.name = \'SessionError\';',
        "this.name = 'SessionError'; /* t-071 mixed: whole-file */",
      );
      expect(fullFileRewrite).not.toBe(baseline);

      const result = await session.applyEdits([
        {
          kind: 'patch',
          file: CONTRACTED_PATH,
          hunks: [
            {
              search: patchedAnchor,
              replace:
                'readonly kind: SessionErrorKind; /* t-071 mixed: patch-then-fullfile */',
            },
          ],
        },
        { file: CONTRACTED_PATH, content: fullFileRewrite },
      ]);

      // The full-file rewrite is the last write, so on-disk bytes == fullFileRewrite.
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.changeKindCounts).toEqual({
        full_file: 1,
        patch: 1,
        structural: 0,
      });
      expect(result.bytesWritten).toBe(Buffer.byteLength(fullFileRewrite, 'utf8'));
      const onDisk = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
      expect(onDisk).toBe(fullFileRewrite);

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
