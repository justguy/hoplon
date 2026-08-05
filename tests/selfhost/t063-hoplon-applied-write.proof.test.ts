/**
 * tests/selfhost/t063-hoplon-applied-write.proof.test.ts — T-063 proof.
 *
 * Drives the full ordered-loop through `createHoplonEditSession` where the
 * session itself writes the edited bytes via `applyEdits` (through an
 * injected HoplonFsAdapter) — no direct `node:fs` write on the claimed live
 * path. Proves:
 *
 *   1. PASS path — Hoplon writes the corrected in-scope edit through the
 *      adapter, audit returns PASS, history records `applyEdits` with the
 *      right bytesWritten/changedFileCount outcome.
 *
 *   2. BLOCK path — Hoplon writes an out-of-scope edit through the adapter,
 *      audit returns BLOCK, revert restores the baseline on disk, and
 *      extractRollbackTemplate still produces non-empty retry context.
 *
 * The seed write that installs baseline bytes is the only host fs write,
 * and it predates the session — it is the "initial project bytes" step.
 * Every subsequent write on the live path flows through `session.applyEdits`.
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

function applyInScopeEdit(baseline: string): string {
  const marker = '\n  // t-063 hoplon-applied-write proof: in-scope edit.';
  return baseline.replace(
    'export class SessionError extends Error {',
    `export class SessionError extends Error {${marker}`,
  );
}

function applyOutOfScopeEdit(baseline: string): string {
  const tail = [
    '',
    '// t-063 proof: out-of-scope top-level symbol appended by Hoplon-applied write.',
    "export const T063_MARKER = 'out-of-scope';",
    '',
  ].join('\n');
  return baseline.endsWith('\n') ? `${baseline}${tail.slice(1)}` : `${baseline}${tail}`;
}

describe('T-063 — Hoplon-applied write path through session.applyEdits', () => {
  it('applies an in-scope edit through the adapter and audits PASS', async () => {
    const root = makeTempWorkspace('hoplon-t063-pass-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't063-pass-engine',
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
        manifest: sessionErrorSymbolsManifest('t063-pass'),
        fs: adapter,
      });

      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();

      const edited = applyInScopeEdit(baseline);
      expect(edited).not.toBe(baseline);
      const result = await session.applyEdits([
        { file: CONTRACTED_PATH, content: edited },
      ]);
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.bytesWritten).toBe(Buffer.byteLength(edited, 'utf8'));
      expect(session.state).toBe('edited');

      // Bytes on disk must match what the adapter wrote.
      expect(fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8')).toBe(edited);

      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(session.state).toBe('audited_pass');

      const ops = session.snapshot.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'applyEdits',
        'audit',
      ]);
      const applyEntry = session.snapshot.history.find((h) => h.op === 'applyEdits');
      expect(applyEntry?.outcome).toEqual({
        kind: 'applyEdits',
        changedFileCount: 1,
        bytesWritten: Buffer.byteLength(edited, 'utf8'),
        changeKindCounts: { full_file: 1, patch: 0, structural: 0 },
      });

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('BLOCKs an out-of-scope edit written by Hoplon, revert restores the baseline, and rollback-template is emitted', async () => {
    const root = makeTempWorkspace('hoplon-t063-block-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't063-block-engine',
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
        manifest: sessionErrorSymbolsManifest('t063-block'),
        fs: adapter,
      });

      await session.preflight();
      const snapshotRef = await session.createSnapshot();

      const violating = applyOutOfScopeEdit(baseline);
      await session.applyEdits([{ file: CONTRACTED_PATH, content: violating }]);
      expect(fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8')).toBe(violating);

      const audit = await session.audit();
      expect(audit.status).toBe('BLOCK');
      if (audit.status !== 'BLOCK') throw new Error('unreachable');
      expect(
        audit.violations.some(
          (v) => v.kind === 'out_of_scope_symbol' && v.path === CONTRACTED_PATH,
        ),
      ).toBe(true);
      expect(session.state).toBe('audited_block');

      await session.revert();
      expect(session.state).toBe('reverted');
      expect(fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8')).toBe(baseline);

      const template = await session.extractRollbackTemplate();
      expect(session.state).toBe('rollback_extracted');
      expect(template.snapshotRef).toBe(snapshotRef.id);
      expect(template.files.length).toBeGreaterThan(0);
      const entry = template.files.find((f) => f.path === CONTRACTED_PATH);
      expect(entry?.structuralSkeleton).toContain('SessionError');
      expect(entry?.contractedChanges).toContain('Change only symbol(s): SessionError');

      session.close();

      const ops = session.snapshot.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'applyEdits',
        'audit',
        'revert',
        'extractRollbackTemplate',
        'close',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
