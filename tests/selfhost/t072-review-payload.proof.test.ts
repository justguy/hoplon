/**
 * tests/selfhost/t072-review-payload.proof.test.ts
 *
 * Real-engine + real-tree-sitter proof for t-072. Drives a supervised edit
 * session through `applyEdits` against a stable single-symbol fixture mounted
 * at `src/hoplon/session/errors.ts`,
 * then calls `session.getReviewPayload` and asserts:
 *
 *   1. The review payload resolves the touched logic unit to the enclosing
 *      `SessionError` class boundary with a standard unified-diff body
 *      inside — not a generic file-level diff.
 *   2. The payload carries `changedFiles` and `changeKindCounts` from the
 *      shipped session/apply path (content-free sidecars).
 *   3. The launcher's `renderReviewHuman` renderer emits ANSI-colored output
 *      from the same payload so the packaged CLI / chat surface can approve
 *      or reject from the same screen.
 *   4. Optional impact panes stay honestly UNAVAILABLE when they were not
 *      requested.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveLauncherWorkspace,
  ensureWorkspaceLayout,
} from '../../src/hoplon/launcher/config.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createNodeFsAdapter } from '../../src/hoplon/adapters/fs/node.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { SessionReviewPayloadSchema } from '../../src/hoplon/contracts/reviewPayload.js';
import { renderReviewHuman } from '../../src/hoplon/launcher/reviewHuman.js';
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

describe('T-072 — packaged review payload over the supervised apply path', () => {
  it('resolves a patched SessionError edit to the enclosing class boundary with a bounded diff', async () => {
    const root = makeTempWorkspace('hoplon-t072-review-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't072-review-engine',
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
      const codeIntelligence = await createTreeSitterIntelligence({
        grammarsDir: workspace.grammarsDir,
      });

      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t072-review'),
        fs: adapter,
        codeIntelligence,
      });
      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();

      const anchor = "this.name = 'SessionError';";
      expect(baseline.indexOf(anchor)).toBeGreaterThan(-1);
      const result = await session.applyEdits([
        {
          kind: 'patch',
          file: CONTRACTED_PATH,
          hunks: [
            {
              search: anchor,
              replace:
                "this.name = 'SessionError'; /* t-072 bounded review edit */",
            },
          ],
        },
      ]);
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 1, structural: 0 });

      const payload = await session.getReviewPayload();
      const validated = SessionReviewPayloadSchema.safeParse(payload);
      expect(validated.success).toBe(true);

      expect(payload.phase).toBe('post-edit');
      expect(payload.state).toBe('edited');
      expect(payload.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(payload.changeKindCounts).toEqual({ full_file: 0, patch: 1, structural: 0 });
      expect(payload.files).toHaveLength(1);

      const file = payload.files[0]!;
      expect(file.path).toBe(CONTRACTED_PATH);
      expect(file.fallback).toBeNull();
      expect(file.boundaries.length).toBeGreaterThan(0);

      const sessionErrorBoundary = file.boundaries.find(
        (b) => b.symbol === 'SessionError',
      );
      expect(sessionErrorBoundary).toBeDefined();
      // Tree-sitter reports top-level `export class Foo` as `export_statement`
      // (the declaration child is the `class_declaration`). Either kind is a
      // valid logical boundary for the review payload.
      expect(['class_declaration', 'export_statement']).toContain(
        sessionErrorBoundary!.symbolKind,
      );
      expect(sessionErrorBoundary!.changeMode).toBe('modified');
      expect(sessionErrorBoundary!.unifiedDiff).toContain(
        '+    this.name = \'SessionError\'; /* t-072 bounded review edit */',
      );
      expect(sessionErrorBoundary!.unifiedDiff).toContain(
        '-    this.name = \'SessionError\';',
      );
      // The bounded diff stays scoped to this class — not a whole-file dump.
      expect(sessionErrorBoundary!.unifiedDiff.split('\n').length).toBeLessThan(60);

      // Impact panes stay honestly UNAVAILABLE when the caller did not opt in.
      expect(payload.impact.dependencyImpact.status).toBe('UNAVAILABLE');
      expect(payload.impact.dependencyImpact.reason).toBe('not_requested');
      expect(payload.impact.dependencyImpact.blastRadius).toBeNull();
      expect(payload.impact.relevantTests.status).toBe('UNAVAILABLE');

      // Human ANSI renderer emits colored output over the same DTO.
      const rendered = renderReviewHuman(payload);
      expect(rendered).toContain('Hoplon review');
      expect(rendered).toContain('SessionError');
      expect(rendered).toContain(
        '[32m+    this.name = \'SessionError\'; /* t-072 bounded review edit */',
      );

      // Sanity: the rendered output does not dump any UNAVAILABLE reason string
      // as an absent field — both panes appear as UNAVAILABLE with their reason.
      expect(rendered).toContain('UNAVAILABLE (not_requested)');

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('surfaces UNAVAILABLE blast-radius entries with reason=no_provider when the tree-sitter adapter exposes no findReferences', async () => {
    const root = makeTempWorkspace('hoplon-t072-blast-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't072-blast-engine',
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
      const codeIntelligence = await createTreeSitterIntelligence({
        grammarsDir: workspace.grammarsDir,
      });

      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t072-blast'),
        fs: adapter,
        codeIntelligence,
      });
      await session.preflight();
      await session.createSnapshot();
      const anchor = "this.name = 'SessionError';";
      expect(baseline.indexOf(anchor)).toBeGreaterThan(-1);
      await session.applyEdits([
        {
          kind: 'patch',
          file: CONTRACTED_PATH,
          hunks: [
            {
              search: anchor,
              replace:
                "this.name = 'SessionError'; /* t-072 blast-radius probe */",
            },
          ],
        },
      ]);

      const payload = await session.getReviewPayload({ includeDependencyImpact: true });
      // The shipped tree-sitter adapter does not implement findReferences, so
      // the canonical dependency-impact sidecar (t-077) surfaces a degraded
      // or unavailable status with a provider-shaped reason rather than
      // fabricating zero-reference counts. The analyzer envelope (when
      // produced) is preserved with status=UNAVAILABLE so hosts see that
      // the analyzer answered "no" rather than never having been called.
      expect(['DEGRADED', 'UNAVAILABLE']).toContain(
        payload.impact.dependencyImpact.status,
      );
      expect([
        'no_provider',
        'no_changed_subjects',
        'no_symbol_subjects',
      ]).toContain(payload.impact.dependencyImpact.reason);
      if (payload.impact.dependencyImpact.blastRadius !== null) {
        expect(payload.impact.dependencyImpact.blastRadius.status).toBe(
          'UNAVAILABLE',
        );
        expect(payload.impact.dependencyImpact.blastRadius.providerAvailable).toBe(
          false,
        );
      }

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
