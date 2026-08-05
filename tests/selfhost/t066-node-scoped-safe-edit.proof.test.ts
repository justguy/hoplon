/**
 * tests/selfhost/t066-node-scoped-safe-edit.proof.test.ts — t-066 selfhost
 * proof.
 *
 * Runs the packaged supervised session over the real default engine and
 * the real tree-sitter adapter to show:
 *
 *   1. A `{ symbolPath: ['SessionError', 'constructor'] }` selector
 *      resolves to the class constructor via the shipped RefinedSyntaxTree
 *      structure and replaces only that method's bytes, leaving the rest
 *      of the contracted class intact.
 *   2. Two concurrent same-file structural sessions both land on the real
 *      write path when the first edit shifts the second target's byte
 *      range.
 *   3. `runStatus().safeEdit` now reports `nodeScopedLocks === true` and
 *      `structuralScope.targeting === 'top_level_symbol_or_symbol_path'`
 *      so downstream docs/tests see the honest flip.
 */

import { describe, expect, it } from 'vitest';
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
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { runStatus } from '../../src/hoplon/launcher/status.js';
import {
  CONTRACTED_PATH,
  seedSessionErrorFixture,
  sessionErrorSymbolsManifest,
} from './fixtures/sessionErrorFixture.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sameFileStructuralManifest(projectId: string, file: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: `corr-${projectId}-${Date.now()}`,
    entries: [{ path: file, scope: { kind: 'symbols', symbols: ['MyClass'] } }],
  };
}

describe('T-066 — node-scoped safe edit', () => {
  it('resolves a nested symbolPath via real tree-sitter and replaces only the targeted method', async () => {
    const root = makeTempWorkspace('hoplon-t066-symbolpath-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't066-symbolpath-engine',
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
      const lockProvider = createAsyncMutexLockProvider();

      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t066-symbolpath'),
        fs: adapter,
        codeIntelligence,
        lockProvider,
      });

      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();

      // The nested selector replaces just the constructor body so the
      // class SessionError remains recognizable to the contracted-symbol
      // audit. The resolver walks through `class_body` transparently.
      const newConstructor = `constructor(kind: SessionErrorKind) {\n    super(\`Hoplon session: \${kind} (t066 proof)\`);\n    this.name = 'SessionError';\n    this.kind = kind;\n  }`;

      const result = await session.applyEdits([
        {
          kind: 'structural',
          file: CONTRACTED_PATH,
          target: { symbolPath: ['SessionError', 'constructor'] },
          content: newConstructor,
        },
      ]);
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.changeKindCounts).toEqual({
        full_file: 0,
        patch: 0,
        structural: 1,
      });

      const onDisk = fs.readFileSync(
        path.join(root, CONTRACTED_PATH),
        'utf8',
      );
      expect(onDisk).toContain('(t066 proof)');
      // The enclosing class declaration is still present — the nested
      // replacement did NOT clobber the rest of the class body.
      expect(onDisk).toContain('export class SessionError extends Error');
      expect(onDisk).toContain('readonly kind: SessionErrorKind');
      // And the original baseline text (outside the targeted method) is
      // still byte-for-byte present where it was not targeted.
      expect(onDisk.startsWith(
        baseline.slice(0, baseline.indexOf('constructor(kind: SessionErrorKind)')),
      )).toBe(true);

      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(session.state).toBe('audited_pass');

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('lands two disjoint same-file structural sessions on the real path when the first edit shifts the second target', async () => {
    const root = makeTempWorkspace('hoplon-t066-concurrency-');
    const file = 'src/t066.ts';
    const baseline = `export class MyClass {
  foo() {
    return 1;
  }

  bar() {
    return 2;
  }
}
`;
    try {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), baseline);

      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't066-concurrency-engine',
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
      const lockProvider = createAsyncMutexLockProvider();

      const sessionA = createHoplonEditSession({
        engine,
        manifest: sameFileStructuralManifest('t066-concurrency', file),
        fs: adapter,
        codeIntelligence,
        lockProvider,
      });
      const sessionB = createHoplonEditSession({
        engine,
        manifest: sameFileStructuralManifest('t066-concurrency', file),
        fs: adapter,
        codeIntelligence,
        lockProvider,
      });
      expect((await sessionA.preflight()).status).toBe('PASS');
      expect((await sessionB.preflight()).status).toBe('PASS');
      await sessionA.createSnapshot();
      await sessionB.createSnapshot();

      await Promise.all([
        sessionA.applyEdits([
          {
            kind: 'structural',
            file,
            target: { symbolPath: ['MyClass', 'foo'] },
            content: `foo() {
    return 1000;
  }`,
          },
        ]),
        sessionB.applyEdits([
          {
            kind: 'structural',
            file,
            target: { symbolPath: ['MyClass', 'bar'] },
            content: `bar() {
    return 20;
  }`,
          },
        ]),
      ]);

      const onDisk = fs.readFileSync(path.join(root, file), 'utf8');
      expect(onDisk).toContain('return 1000;');
      expect(onDisk).toContain('return 20;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('runStatus().safeEdit reports nodeScopedLocks=true while reporting the widened targeting', async () => {
    const root = makeTempWorkspace('hoplon-t066-status-');
    try {
      const report = await runStatus({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't066-status-engine',
      });
      expect(report.safeEdit.unsupported.nodeScopedLocks).toBe(true);
      expect(report.safeEdit.structuralScope.targeting).toBe(
        'top_level_symbol_or_symbol_path',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
