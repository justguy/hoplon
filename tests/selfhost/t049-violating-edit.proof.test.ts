/**
 * tests/selfhost/t049-violating-edit.proof.test.ts — T-049 violating-edit proof.
 *
 * Proves that one violating edit to a Hoplon-shaped workspace is supervised
 * end-to-end through the shipped surfaces, reaches BLOCK, is actually reverted
 * on disk, and produces non-empty rollback-template retry context:
 *
 *   launcher (resolveLauncherWorkspace + launcher-equivalent engine bootstrap)
 *     → session (createHoplonEditSession)
 *       → preflight → createSnapshot → markEdited → audit (BLOCK)
 *       → revert → extractRollbackTemplate → close
 *
 * Scope:
 *   - ONE violating edit: an uncontracted post-snapshot file is created on
 *     disk alongside a legitimate whole_file edit on a contracted file.
 *   - uses real Hoplon source files copied into a temp workspace so the proof
 *     exercises actual Hoplon code, not synthetic placeholder TypeScript.
 *   - drives the live launcher engine-bootstrap path via the same factory
 *     runStatus / runHttpServe / runMcpServe call internally.
 *   - audit returns BLOCK with a real uncontracted_file violation.
 *   - revertUncontracted is verified on the filesystem, not from the return
 *     payload alone:
 *       * the contracted file (fileA) is restored on disk to the snapshotted
 *         baseline bytes,
 *       * the uncontracted post-snapshot file (fileB) is deleted from disk.
 *   - extractRollbackTemplate returns non-empty retry context for the
 *     reverted file set.
 *
 * Out of scope (separate slices):
 *   - full violating-edit scenario matrix (symbol-scope violations,
 *     structural corruption, signature mismatches, etc).
 *   - retry prompt assembly / retry loop execution.
 *   - capability-contract sweep.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLauncherWorkspace, ensureWorkspaceLayout } from '../../src/hoplon/launcher/config.js';
import { runStatus } from '../../src/hoplon/launcher/status.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

const REAL_HOPLON_FILE_A = path.resolve(REPO_ROOT, 'src/hoplon/session/errors.ts');
const REAL_HOPLON_FILE_B = path.resolve(REPO_ROOT, 'src/hoplon/session/types.ts');

const CONTRACTED_PATH = 'src/hoplon/session/errors.ts';
const UNCONTRACTED_PATH = 'src/hoplon/session/types.ts';

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-t049-violating-'));
  fs.mkdirSync(path.join(root, path.dirname(CONTRACTED_PATH)), { recursive: true });
  return root;
}

function seedRealHoplonFile(root: string, rel: string, realAbs: string): string {
  const baseline = fs.readFileSync(realAbs, 'utf8');
  fs.writeFileSync(path.join(root, rel), baseline);
  return baseline;
}

function applyLegitimateEdit(baseline: string): string {
  const marker = '\n// t-049 violating-edit proof: touched 2026-04-15 (contracted file).\n';
  return baseline.endsWith('\n') ? `${baseline}${marker.slice(1)}` : `${baseline}${marker}`;
}

function manifestFor(file: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 't049-violating-edit',
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: `corr-t049-${Date.now()}`,
    entries: [{ path: file, scope: { kind: 'whole_file' } }],
  };
}

describe('T-049 — violating-edit proof (Hoplon-on-Hoplon)', () => {
  it('supervises one violating edit end-to-end, blocks, reverts on disk, and yields retry context', async () => {
    const root = makeTempWorkspace();
    const baselineA = seedRealHoplonFile(root, CONTRACTED_PATH, REAL_HOPLON_FILE_A);
    // fileB is seeded locally only so we have a real Hoplon file we can copy
    // in as the uncontracted "violating" creation post-snapshot. We do NOT
    // seed it before snapshotting — it must not exist at snapshot time so the
    // revert decision matrix classifies it as "delete".
    const violatingContentB = fs.readFileSync(REAL_HOPLON_FILE_B, 'utf8');

    try {
      // ----------------------------------------------------------------------
      // Launcher surface — resolve workspace and prove launcher reachability.
      // ----------------------------------------------------------------------
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't049-engine',
      });
      ensureWorkspaceLayout(workspace);

      const status = await runStatus({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't049-engine',
      });
      expect(status.engineId).toBe('t049-engine');
      expect(status.workspace).toEqual(workspace);
      expect(status.grammarsPresent).toBe(true);
      for (const cap of status.capabilities) {
        expect(cap.status).toBe('available');
      }

      // ----------------------------------------------------------------------
      // Engine — same factory invocation the launcher uses.
      // ----------------------------------------------------------------------
      const engine = await createDefaultHoplonEngine({
        root: workspace.root,
        dbPath: workspace.dbPath,
        gitRepoDir: workspace.gitRepoDir,
        grammarsDir: workspace.grammarsDir,
        engineId: workspace.engineId,
      });

      // ----------------------------------------------------------------------
      // Session — the host-owned edit loop contract.
      // ----------------------------------------------------------------------
      const manifest = manifestFor(CONTRACTED_PATH);
      const session = createHoplonEditSession({ engine, manifest });

      // 1. preflight → PASS
      const preflight = await session.preflight();
      expect(preflight.status).toBe('PASS');
      expect(session.state).toBe('preflighted_pass');

      // 2. createSnapshot → real content-addressable ref.
      //    Only fileA is staged (it is the only manifest entry).
      //    fileB does not yet exist on disk — it is not at snapshot.
      const snapshotRef = await session.createSnapshot();
      expect(snapshotRef.id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(session.state).toBe('snapshotted');

      // 3. Apply the violating edit:
      //    - Legitimate in-scope change: append a comment to fileA (whole_file
      //      scope permits any parse-preserving edit).
      //    - Violating change: create a brand-new uncontracted file fileB that
      //      was not at snapshot and is not in the manifest.
      const editedA = applyLegitimateEdit(baselineA);
      fs.writeFileSync(path.join(root, CONTRACTED_PATH), editedA);
      fs.writeFileSync(path.join(root, UNCONTRACTED_PATH), violatingContentB);
      expect(fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8')).toBe(editedA);
      expect(fs.existsSync(path.join(root, UNCONTRACTED_PATH))).toBe(true);

      // 4. Host declares both changed files through markEdited so audit sees
      //    them. Audit walks req.files; files not in the manifest produce
      //    uncontracted_file violations.
      await session.markEdited([CONTRACTED_PATH, UNCONTRACTED_PATH]);
      expect(session.state).toBe('edited');
      expect(session.snapshot.changedFiles).toEqual([CONTRACTED_PATH, UNCONTRACTED_PATH]);

      // 5. audit → BLOCK with a real uncontracted_file violation on fileB.
      const audit = await session.audit();
      expect(audit.status).toBe('BLOCK');
      if (audit.status !== 'BLOCK') {
        throw new Error('unreachable — narrowed by previous assertion');
      }
      expect(audit.violations.length).toBeGreaterThan(0);
      const uncontracted = audit.violations.find(
        (v) => v.kind === 'uncontracted_file' && v.path === UNCONTRACTED_PATH,
      );
      expect(uncontracted).toBeDefined();
      expect(uncontracted?.message).toMatch(/not in the contracted manifest/);
      expect(uncontracted?.correction).toMatch(/Revert/);
      expect(session.state).toBe('audited_block');

      // 6. revertUncontracted — filesystem-level revert.
      const revert = await session.revert();
      expect(session.state).toBe('reverted');

      // Return payload claims:
      //   - fileA in manifest + at snapshot → reverted
      //   - fileB not in manifest + not at snapshot → deleted
      expect(revert.reverted).toContain(CONTRACTED_PATH);
      expect(revert.deleted).toContain(UNCONTRACTED_PATH);

      // Disk-level proof: the claim is honored on the real filesystem.
      //   - fileA's bytes match the snapshotted baseline, not the edited form.
      //   - fileB no longer exists.
      const postRevertA = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
      expect(postRevertA).toBe(baselineA);
      expect(postRevertA).not.toBe(editedA);
      expect(fs.existsSync(path.join(root, UNCONTRACTED_PATH))).toBe(false);

      // 7. extractRollbackTemplate — non-empty retry context for the reverted
      //    contracted file. fileB was deleted and is not in the snapshot, so
      //    we request the template for fileA (the file the retry must revise).
      const template = await session.extractRollbackTemplate({
        files: [CONTRACTED_PATH],
      });
      expect(session.state).toBe('rollback_extracted');
      expect(template.files.length).toBeGreaterThan(0);
      expect(template.snapshotRef).toBe(snapshotRef.id);
      const entry = template.files.find((f) => f.path === CONTRACTED_PATH);
      expect(entry).toBeDefined();
      expect(entry?.injectionHint.length).toBeGreaterThan(0);
      expect(entry?.contractedChanges.length).toBeGreaterThan(0);
      // structuralSkeleton is read from the snapshot blob of fileA, which is
      // a real TypeScript source file with at least one export. The skeleton
      // string must therefore be non-empty.
      expect(entry?.structuralSkeleton.length).toBeGreaterThan(0);

      // 8. close.
      session.close();
      expect(session.state).toBe('closed');

      // Ordered-loop proof: the history records the full BLOCK → revert →
      // rollback_extracted → closed sequence.
      const ops = session.snapshot.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'markEdited',
        'audit',
        'revert',
        'extractRollbackTemplate',
        'close',
      ]);
      // The snapshot ref was threaded through the session, not re-derived
      // downstream.
      expect(session.snapshot.snapshotRef?.id).toBe(snapshotRef.id);
      expect(session.snapshot.lastAuditResult?.status).toBe('BLOCK');
      expect(session.snapshot.lastRevertResult?.reverted).toContain(CONTRACTED_PATH);
      expect(session.snapshot.lastRollbackTemplate?.files.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
