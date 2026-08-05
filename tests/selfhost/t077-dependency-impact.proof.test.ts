/**
 * tests/selfhost/t077-dependency-impact.proof.test.ts
 *
 * T-077 end-to-end proof. Drives the real launcher + engine + tree-sitter
 * adapter so the canonical advisory `dependencyImpact` sidecar is attached
 * to both packaged review-payload and packaged repair-context surfaces:
 *
 *   1. Review path (post-edit) with a stubbed findReferences provider:
 *      - `session.getReviewPayload({ includeDependencyImpact: true })` derives
 *        at least one symbol subject from the edited boundary and wraps the
 *        stubbed provider's output into an AVAILABLE sidecar with the
 *        expected affected-file evidence — no fabricated reference counts,
 *        `advisory: true` pinned.
 *   2. Review path with the shipped tree-sitter default (no findReferences):
 *      - the sidecar degrades honestly to DEGRADED with reason=no_provider
 *        (or UNAVAILABLE when the adapter reports UNAVAILABLE), retains the
 *        derived subjects, and never fabricates counts.
 *   3. Repair-context path with a stubbed provider:
 *      - after BLOCK → revert → extractRollbackTemplate,
 *        `session.getRepairContext({ includeDependencyImpact: true })`
 *        carries an AVAILABLE sidecar with subjects derived from both the
 *        manifest scope and the failed audit's violations.
 *
 * The repair path uses a no-fs mock session path so the helper does not need
 * to re-provision a temp workspace for every proof.
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
import type { Reference } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type {
  AnalyzeBlastRadiusRequest,
  AnalyzeBlastRadiusResult,
} from '../../src/hoplon/contracts/blastRadius.js';
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

/**
 * Wrap a real `HoplonEngine` instance with a stubbed `analyzeBlastRadius`
 * implementation so the dependency-impact sidecar composer receives a
 * deterministic, provider-backed result without requiring a real LSP/SCIP
 * adapter on this branch.
 */
function withStubbedBlastRadius(
  engine: HoplonEngine,
  referencesPerSymbol: (
    name: string,
  ) => Reference[],
): HoplonEngine {
  const stub: HoplonEngine = {
    ...engine,
    async analyzeBlastRadius(
      req: AnalyzeBlastRadiusRequest,
    ): Promise<AnalyzeBlastRadiusResult> {
      return {
        correlationId: req.correlationId,
        advisory: true,
        status: 'SAFE',
        providerAvailable: true,
        warnThreshold: req.warnThreshold ?? 10,
        entries: req.symbols.map((s) => {
          const refs = referencesPerSymbol(s.name);
          return {
            symbol: s,
            classification: 'safe',
            referenceCount: refs.length,
            affectedFileCount: new Set(refs.map((r) => r.path)).size,
            affectedFiles: Array.from(new Set(refs.map((r) => r.path))).sort(),
            thresholdUsed: req.warnThreshold ?? 10,
          };
        }),
      };
    },
  };
  return stub;
}

describe('T-077 — dependency-impact sidecars over review and repair context', () => {
  it(
    'attaches an AVAILABLE dependencyImpact sidecar to the review payload when a provider is available',
    async () => {
      const root = makeTempWorkspace('hoplon-t077-review-ok-');
      const baseline = seedSessionErrorFixture(root);
      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't077-review-ok-engine',
        });
        ensureWorkspaceLayout(workspace);

        const realEngine = await createDefaultHoplonEngine({
          root: workspace.root,
          dbPath: workspace.dbPath,
          gitRepoDir: workspace.gitRepoDir,
          grammarsDir: workspace.grammarsDir,
          engineId: workspace.engineId,
        });
        const engine = withStubbedBlastRadius(realEngine, (name) => {
          if (name !== 'SessionError') return [];
          return [
            {
              path: 'src/hoplon/session/session.ts',
              byteRange: [100, 120],
            } as unknown as Reference,
            {
              path: 'src/hoplon/session/registry.ts',
              byteRange: [10, 30],
            } as unknown as Reference,
          ];
        });
        const adapter = createNodeFsAdapter({ root: workspace.root });
        const codeIntelligence = await createTreeSitterIntelligence({
          grammarsDir: workspace.grammarsDir,
        });

        const session = createHoplonEditSession({
          engine,
          manifest: sessionErrorSymbolsManifest('t077-review-ok'),
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
                  "this.name = 'SessionError'; /* t-077 dependency impact probe */",
              },
            ],
          },
        ]);

        const payload = await session.getReviewPayload({
          includeDependencyImpact: true,
          dependencyImpactWarnThreshold: 3,
        });

        const di = payload.impact.dependencyImpact;
        expect(di.version).toBe(1);
        expect(di.advisory).toBe(true);
        expect(di.status).toBe('AVAILABLE');
        expect(di.reason).toBeNull();
        expect(di.subjectCounts.symbol).toBeGreaterThan(0);
        expect(di.subjectCounts.file).toBe(0);
        expect(di.blastRadius).not.toBeNull();
        expect(di.blastRadius?.status).toBe('SAFE');
        expect(di.warnThreshold).toBe(3);
        const affectedFiles = di.blastRadius?.entries.flatMap((e) => e.affectedFiles);
        expect(affectedFiles).toContain('src/hoplon/session/session.ts');

        // The sidecar carries the derived subjects verbatim so the host can
        // render them without re-parsing the review payload.
        expect(di.subjects.some((s) => s.kind === 'symbol' && s.origin === 'review_boundary')).toBe(
          true,
        );

        session.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    'degrades honestly to DEGRADED/UNAVAILABLE when the shipped tree-sitter default has no findReferences',
    async () => {
      const root = makeTempWorkspace('hoplon-t077-review-noprov-');
      const baseline = seedSessionErrorFixture(root);
      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't077-review-noprov-engine',
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
          manifest: sessionErrorSymbolsManifest('t077-review-noprov'),
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
                  "this.name = 'SessionError'; /* t-077 dependency impact noprov */",
              },
            ],
          },
        ]);

        const payload = await session.getReviewPayload({
          includeDependencyImpact: true,
        });
        const di = payload.impact.dependencyImpact;
        expect(di.advisory).toBe(true);
        expect(['DEGRADED', 'UNAVAILABLE']).toContain(di.status);
        expect([
          'no_provider',
          'no_changed_subjects',
          'no_symbol_subjects',
        ]).toContain(di.reason);
        // When the shipped tree-sitter adapter has no findReferences the
        // analyzer still returns a structured UNAVAILABLE envelope — we
        // surface that verbatim so hosts see "provider answered no" vs
        // "analyzer never ran"; never fabricate reference counts.
        if (di.blastRadius !== null) {
          expect(di.blastRadius.status).toBe('UNAVAILABLE');
          expect(di.blastRadius.providerAvailable).toBe(false);
        }

        session.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    'packages an AVAILABLE dependencyImpact sidecar on the repair context when a provider is available',
    async () => {
      const root = makeTempWorkspace('hoplon-t077-repair-ok-');
      const baseline = seedSessionErrorFixture(root);
      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't077-repair-ok-engine',
        });
        ensureWorkspaceLayout(workspace);

        const realEngine = await createDefaultHoplonEngine({
          root: workspace.root,
          dbPath: workspace.dbPath,
          gitRepoDir: workspace.gitRepoDir,
          grammarsDir: workspace.grammarsDir,
          engineId: workspace.engineId,
        });
        // Stub findReferences to return evidence for both the declared manifest
        // scope (`SessionError`) and the out-of-scope violation (`T077_SENTINEL`).
        const engine = withStubbedBlastRadius(realEngine, (name) => {
          if (name === 'SessionError') {
            return [
              {
                path: 'src/hoplon/session/session.ts',
                byteRange: [100, 120],
              } as unknown as Reference,
            ];
          }
          if (name === 'T077_SENTINEL') {
            return [
              {
                path: 'src/hoplon/session/registry.ts',
                byteRange: [10, 30],
              } as unknown as Reference,
            ];
          }
          return [];
        });

        // Drive a BLOCK session over the shared fixture path.
        const manifest = sessionErrorSymbolsManifest('t077-repair-ok');
        const session = createHoplonEditSession({ engine, manifest });
        await session.preflight();
        await session.createSnapshot();

        // Write an out-of-scope symbol outside the contracted scope.
        const outOfScope =
          baseline +
          `\n// t-077 repair-ctx proof: new top-level symbol, not in contracted scope.\n` +
          `export const T077_SENTINEL = 'blocker';\n`;
        fs.writeFileSync(path.join(root, CONTRACTED_PATH), outOfScope);
        await session.markEdited([CONTRACTED_PATH]);
        const auditBlock = await session.audit();
        expect(auditBlock.status).toBe('BLOCK');

        await session.revert();
        await session.extractRollbackTemplate({
          files: [CONTRACTED_PATH],
          contractedChangesMap: {
            [CONTRACTED_PATH]:
              'Only internal modifications to SessionError class body are permitted.',
          },
        });

        const repair = await session.getRepairContext({
          includeDependencyImpact: true,
          warnThreshold: 3,
        });
        expect(repair.dependencyImpact).toBeDefined();
        const di = repair.dependencyImpact!;
        expect(di.advisory).toBe(true);
        expect(di.status).toBe('AVAILABLE');
        expect(di.reason).toBeNull();
        expect(di.warnThreshold).toBe(3);

        // The sidecar carries subjects from BOTH the manifest scope
        // (`SessionError`, declared intent) AND the failed audit violation
        // (`T077_SENTINEL`, what actually went wrong) — each tagged with its
        // origin so the host can render them truthfully.
        const symbolSubjects = di.subjects.filter((s) => s.kind === 'symbol');
        expect(
          symbolSubjects.some(
            (s) =>
              s.kind === 'symbol' && s.symbolName === 'SessionError' && s.origin === 'manifest_scope',
          ),
        ).toBe(true);
        expect(
          symbolSubjects.some(
            (s) =>
              s.kind === 'symbol' &&
              s.symbolName === 'T077_SENTINEL' &&
              s.origin === 'audit_violation',
          ),
        ).toBe(true);

        expect(di.blastRadius).not.toBeNull();
        const affected = di.blastRadius?.entries.flatMap((e) => e.affectedFiles);
        expect(affected).toContain('src/hoplon/session/session.ts');
        expect(affected).toContain('src/hoplon/session/registry.ts');

        session.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    'returns an UNAVAILABLE dependencyImpact sidecar on the repair context when the caller did not opt in',
    async () => {
      const root = makeTempWorkspace('hoplon-t077-repair-optout-');
      const baseline = seedSessionErrorFixture(root);
      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't077-repair-optout-engine',
        });
        ensureWorkspaceLayout(workspace);

        const engine = await createDefaultHoplonEngine({
          root: workspace.root,
          dbPath: workspace.dbPath,
          gitRepoDir: workspace.gitRepoDir,
          grammarsDir: workspace.grammarsDir,
          engineId: workspace.engineId,
        });

        const manifest = sessionErrorSymbolsManifest('t077-repair-optout');
        const session = createHoplonEditSession({ engine, manifest });
        await session.preflight();
        await session.createSnapshot();

        const outOfScope =
          baseline +
          `\nexport const T077_OPTOUT_SENTINEL = 'blocker';\n`;
        fs.writeFileSync(path.join(root, CONTRACTED_PATH), outOfScope);
        await session.markEdited([CONTRACTED_PATH]);
        expect((await session.audit()).status).toBe('BLOCK');
        await session.revert();
        await session.extractRollbackTemplate({
          files: [CONTRACTED_PATH],
          contractedChangesMap: {
            [CONTRACTED_PATH]:
              'Only internal modifications to SessionError class body are permitted.',
          },
        });

        // No options → opt-out path should emit an explicit UNAVAILABLE
        // sidecar rather than silently omit the field.
        const repair = await session.getRepairContext();
        expect(repair.dependencyImpact).toBeDefined();
        const di = repair.dependencyImpact!;
        expect(di.status).toBe('UNAVAILABLE');
        expect(di.reason).toBe('not_requested');
        expect(di.blastRadius).toBeNull();
        expect(di.advisory).toBe(true);

        session.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
