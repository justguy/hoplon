/**
 * tests/selfhost/t048-allowed-edit.proof.test.ts — T-048 allowed-edit proof.
 *
 * Proves that one allowed edit to a Hoplon-shaped workspace can be supervised
 * end-to-end through the shipped surfaces:
 *
 *   launcher (resolveLauncherWorkspace + launcher-equivalent engine bootstrap)
 *     → session (createHoplonEditSession)
 *       → preflight → createSnapshot → dryRun → markEdited → audit → close
 *
 * Scope:
 *   - one allowed edit
 *   - uses a real Hoplon source file (session/errors.ts) copied into a temp
 *     workspace so the proof exercises actual Hoplon code, not synthetic
 *     placeholder TypeScript
 *   - drives the live launcher engine-bootstrap path via the same calls
 *     runStatus / runHttpServe / runMcpServe use internally
 *   - ends in audited_pass (clean audited state)
 *
 * Out of scope (separate slices):
 *   - violating-edit + revert + extractRollbackTemplate proof (t-049)
 *   - retry context extraction proof
 *   - full capability-contract sweep
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
const REAL_HOPLON_FILE = path.resolve(REPO_ROOT, 'src/hoplon/session/errors.ts');

const CONTRACTED_PATH = 'src/hoplon/session/errors.ts';

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-t048-allowed-'));
  fs.mkdirSync(path.join(root, path.dirname(CONTRACTED_PATH)), { recursive: true });
  return root;
}

function seedRealHoplonFile(root: string): string {
  const baseline = fs.readFileSync(REAL_HOPLON_FILE, 'utf8');
  fs.writeFileSync(path.join(root, CONTRACTED_PATH), baseline);
  return baseline;
}

/**
 * Apply an allowed in-scope edit: append a trailing block comment documenting
 * the allowed-edit proof. whole_file scope contracts the entire file, so any
 * parse-preserving edit is in-scope.
 */
function applyAllowedEdit(baseline: string): string {
  const marker = '\n// t-048 allowed-edit proof: touched 2026-04-14.\n';
  return baseline.endsWith('\n') ? `${baseline}${marker.slice(1)}` : `${baseline}${marker}`;
}

function manifestFor(file: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 't048-allowed-edit',
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: `corr-t048-${Date.now()}`,
    entries: [{ path: file, scope: { kind: 'whole_file' } }],
  };
}

describe('T-048 — allowed-edit proof (Hoplon-on-Hoplon)', () => {
  it('supervises one allowed edit end-to-end and ends in audited_pass', async () => {
    const root = makeTempWorkspace();
    const baseline = seedRealHoplonFile(root);

    try {
      // ----------------------------------------------------------------------
      // Launcher surface — resolve workspace and prove launcher reachability.
      // runStatus is the exact handler runStatus exposes; calling it here
      // ensures the launcher's engine bootstrap path actually returns a real
      // engine against the Hoplon-shaped workspace.
      // ----------------------------------------------------------------------
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't048-engine',
      });
      ensureWorkspaceLayout(workspace);

      const status = await runStatus({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't048-engine',
      });
      expect(status.engineId).toBe('t048-engine');
      expect(status.workspace).toEqual(workspace);
      expect(status.grammarsPresent).toBe(true);
      for (const cap of status.capabilities) {
        expect(cap.status).toBe('available');
      }

      // ----------------------------------------------------------------------
      // Engine — same factory invocation the launcher uses (single source of
      // truth for Phase 1 defaults). The launcher's http/mcp serve entry
      // points call this exact factory.
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
      expect(session.state).toBe('created');

      // 1. preflight → PASS
      const preflight = await session.preflight();
      expect(preflight.status).toBe('PASS');
      expect(session.state).toBe('preflighted_pass');

      // 2. createSnapshot → real content-addressable ref
      const snapshotRef = await session.createSnapshot();
      expect(snapshotRef.id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(session.state).toBe('snapshotted');

      // 3. dryRun (optional step in the loop) with the proposed allowed edit.
      const edited = applyAllowedEdit(baseline);
      expect(edited).not.toBe(baseline);
      const dry = await session.dryRun([
        { file: CONTRACTED_PATH, content: edited },
      ]);
      expect(dry.status).toBe('PASS');
      expect(dry).not.toHaveProperty('violations');
      expect(dry.checked).toBe(1);
      // dryRun does NOT advance state — still snapshotted.
      expect(session.state).toBe('snapshotted');

      // 4. External editor applies the edit to disk.
      fs.writeFileSync(path.join(root, CONTRACTED_PATH), edited);
      const onDisk = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
      expect(onDisk).toBe(edited);

      // 5. Host declares the change through markEdited.
      await session.markEdited([CONTRACTED_PATH]);
      expect(session.state).toBe('edited');
      expect(session.snapshot.changedFiles).toEqual([CONTRACTED_PATH]);

      // 6. audit → PASS (clean audited state).
      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(audit).not.toHaveProperty('violations');
      expect(audit.checked).toBe(1);
      expect(session.state).toBe('audited_pass');

      // 7. close.
      session.close();
      expect(session.state).toBe('closed');

      // Ordered-loop proof: the history records every transition in order.
      const ops = session.snapshot.history.map((h) => h.op);
      expect(ops).toEqual([
        'created',
        'preflight',
        'createSnapshot',
        'dryRun',
        'markEdited',
        'audit',
        'close',
      ]);
      expect(session.snapshot.history.find((h) => h.op === 'dryRun')).toMatchObject({
        fromState: 'snapshotted',
        toState: 'snapshotted',
      });

      // Snapshot ref threaded through the session (not re-generated downstream).
      expect(session.snapshot.snapshotRef?.id).toBe(snapshotRef.id);

      // lastDryRunResult + lastAuditResult were captured by the session.
      expect(session.snapshot.lastDryRunResult?.status).toBe('PASS');
      expect(session.snapshot.lastAuditResult?.status).toBe('PASS');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
