/**
 * tests/session/integration.test.ts — real engine end-to-end proof for
 * HoplonEditSession.
 *
 * Drives the session against `createDefaultHoplonEngine` in a temporary
 * workspace with the repo's real tree-sitter grammars. Proves:
 *
 *  1. The session can construct against a real engine and traverse the
 *     happy path through `audited_pass`.
 *  2. createSnapshot returns a real content-addressable snapshot that the
 *     session captures and threads into subsequent calls.
 *  3. Session-local prerequisite failures are rejected before the engine is
 *     called.
 *  4. Engine validation failures propagate unchanged through the session —
 *     the session does NOT swallow or rewrite engine failures.
 *
 * Out of scope (covered by t-048 + t-049):
 *  - allowed-edit + audit PASS proof against a written-to file
 *  - violating-edit + revert + extractRollbackTemplate proof
 *
 * This test exercises the contract surface against real engine boundaries;
 * it is not the allowed-edit success proof yet. The PASS audit path here
 * runs against an empty changedFiles list, which is the minimal valid
 * audit input — it proves the seam, not the edit-loop correctness.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-session-int-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hoplon'), { recursive: true });
  return dir;
}

function manifestFor(file: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'session-int-proj',
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: `corr-${Date.now()}`,
    entries: [{ path: file, scope: { kind: 'whole_file' } }],
  };
}

describe('HoplonEditSession — real engine integration', () => {
  it('traverses the ordered loop against a real engine and returns a real snapshotRef', async () => {
    const root = makeTempWorkspace();
    const filePath = 'src/foo.ts';
    fs.writeFileSync(
      path.join(root, filePath),
      'export function foo(): string { return "hello"; }\n',
    );

    try {
      const engine = await createDefaultHoplonEngine({
        root,
        dbPath: path.join(root, '.hoplon/hoplon.db'),
        grammarsDir: GRAMMARS_DIR,
        engineId: 'session-int-0',
      });
      const session = createHoplonEditSession({
        engine,
        manifest: manifestFor(filePath),
      });

      const preflight = await session.preflight();
      expect(preflight.status).toBe('PASS');
      expect(session.state).toBe('preflighted_pass');

      const ref = await session.createSnapshot();
      expect(ref.id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(session.state).toBe('snapshotted');
      expect(session.snapshot.snapshotRef?.id).toBe(ref.id);

      // No edit applied — markEdited([]) declares "no files changed", which
      // is the cheapest valid markEdited→audit transition for this seam test.
      // hcr-005: caller-declared coverage is no longer trusted as full
      // coverage. This session wires no fs/snapshotStore seams, so the audit
      // falls back to declared-only coverage and MARKS it partial on the
      // result instead of silently passing as fully covered.
      await session.markEdited([]);
      expect(session.state).toBe('edited');

      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(session.state).toBe('audited_pass');
      expect(audit.coverage).toEqual({
        mode: 'declared_only',
        declaredFileCount: 0,
        discoveredPostSnapshotFiles: [],
        partialReason: 'fs_not_wired',
      });

      session.close();
      expect(session.state).toBe('closed');

      // history records every transition with consistent edges.
      const ops = session.snapshot.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'markEdited',
        'audit',
        'close',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('propagates engine validation failures through the session unchanged', async () => {
    const root = makeTempWorkspace();
    fs.writeFileSync(path.join(root, 'src/foo.ts'), 'export const x = 1;\n');

    try {
      const engine = await createDefaultHoplonEngine({
        root,
        dbPath: path.join(root, '.hoplon/hoplon.db'),
        grammarsDir: GRAMMARS_DIR,
        engineId: 'session-int-2',
      });
      const session = createHoplonEditSession({
        engine,
        manifest: manifestFor('src/foo.ts'),
      });
      await session.preflight();
      await session.createSnapshot();

      const historyLengthBefore = session.snapshot.history.length;

      await expect(
        session.dryRun([{ file: '../escape.ts', content: 'export const y = 2;\n' }]),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(session.state).toBe('snapshotted');
      expect(session.snapshot.history).toHaveLength(historyLengthBefore);
      expect(session.snapshot.history.at(-1)?.op).toBe('createSnapshot');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects missing proposedChanges before delegating to the engine', async () => {
    const root = makeTempWorkspace();
    fs.writeFileSync(path.join(root, 'src/foo.ts'), 'export const x = 1;\n');

    try {
      const engine = await createDefaultHoplonEngine({
        root,
        dbPath: path.join(root, '.hoplon/hoplon.db'),
        grammarsDir: GRAMMARS_DIR,
        engineId: 'session-int-1',
      });
      const session = createHoplonEditSession({
        engine,
        manifest: manifestFor('src/foo.ts'),
      });
      await session.preflight();
      await session.createSnapshot();

      // dryRun with empty proposedChanges → SessionError (prerequisite),
      // NOT an engine error — proves the session validates inputs locally
      // before delegating. State must remain snapshotted.
      const err = await session.dryRun([]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).kind).toBe('missing_prerequisite');
      expect(session.state).toBe('snapshotted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
