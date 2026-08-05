/**
 * tests/selfhost/t067-verify-behavior.proof.test.ts
 *
 * Real-engine + real-tree-sitter + real-launcher proof for t-067. Exercises
 * `session.verifyBehavior` and the packaged `POST /session/verifyBehavior`
 * HTTP route over a genuine supervised-edit session so the contract is
 * proved on the shipped surface, not only on a composer unit test.
 *
 * Two paths:
 *   1. session-driven PASS over oracle-selected tests (runner injected)
 *   2. session-driven UNAVAILABLE / no_runner over the packaged HTTP route
 *
 * Test execution stays stubbed (the `BehaviorTestRunnerAdapter` is the
 * deterministic stub adapter). Hoplon's deterministic kernel is NOT a
 * test runner; this proof only confirms the wiring around it.
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
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createSessionTransportDispatcher } from '../../src/hoplon/session/transport.js';
import { createStubBehaviorTestRunner } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { BehaviorTestRunOutcome } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import { VerifyBehaviorResultSchema } from '../../src/hoplon/contracts/verifyBehavior.js';
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

function passOutcome(files: readonly string[]): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-host-runner',
    startedAt: '2026-04-21T12:00:00Z',
    completedAt: '2026-04-21T12:00:01Z',
    durationMs: 1_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 0, signal: null, reason: null },
    failingTests: [],
    passingTestCount: files.length,
    skippedTestCount: 0,
    stdout: `RUN ${files.join(',')} OK`,
    stderr: null,
    structured: { total: files.length, failed: 0 },
    truncated: false,
  };
}

describe('T-067 — packaged behavior verification over the safe-edit loop', () => {
  it('session.verifyBehavior runs the host runner over the shipped oracle selection', async () => {
    const root = makeTempWorkspace('hoplon-t067-inproc-');
    try {
      seedSessionErrorFixture(root);
      // Add a test fixture file that imports the edited module, so the shipped
      // `getRelevantTests` oracle resolves at least one relevant test
      // deterministically.
      const testRel = 'tests/session/errors.test.ts';
      fs.mkdirSync(path.join(root, path.dirname(testRel)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, testRel),
        "import { SessionError } from '../../src/hoplon/session/errors.js';\n" +
          "export const touched = SessionError;\n",
      );

      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't067-inproc-engine',
      });
      ensureWorkspaceLayout(workspace);

      const engine = await createDefaultHoplonEngine({
        root: workspace.root,
        dbPath: workspace.dbPath,
        gitRepoDir: workspace.gitRepoDir,
        grammarsDir: workspace.grammarsDir,
        engineId: workspace.engineId,
      });
      const nodeFs = createNodeFsAdapter({ root: workspace.root });
      const codeIntelligence = await createTreeSitterIntelligence({
        grammarsDir: workspace.grammarsDir,
      });

      const runner = createStubBehaviorTestRunner({
        id: 'stub-host-runner',
        fixtures: [
          {
            matches: { kind: 'testFiles', testFiles: [testRel] },
            outcome: passOutcome([testRel]),
          },
        ],
      });

      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t067-inproc'),
        fs: nodeFs,
        codeIntelligence,
        behaviorTestRunner: runner,
        projectRoot: workspace.root,
      });

      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();
      await session.applyEdits([
        {
          kind: 'patch',
          file: CONTRACTED_PATH,
          hunks: [
            {
              search: "this.name = 'SessionError';",
              replace:
                "this.name = 'SessionError'; /* t-067 verify-behavior probe */",
            },
          ],
        },
      ]);

      const result = await session.verifyBehavior();
      const validated = VerifyBehaviorResultSchema.safeParse(result);
      expect(validated.success).toBe(true);
      expect(result.status).toBe('AVAILABLE');
      expect(result.outcome).toBe('PASS');
      expect(result.selection.strategy).toBe('oracle');
      // The shipped oracle selected at least our test fixture; it may also
      // pull other tests that transitively import the edited module.
      expect(result.selection.testsExecuted.length).toBeGreaterThan(0);
      expect(result.selection.testsExecuted).toContain(testRel);
      expect(result.selection.coverageConfidence).toBe('exact');
      expect(result.selection.oracleResult).not.toBeNull();
      expect(result.linkage.sessionId).toBe(session.sessionId);
      expect(result.linkage.snapshotRefId).not.toBeNull();
      expect(result.linkage.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.execution.runnerId).toBe('stub-host-runner');
      expect(result.execution.exitStatus).toEqual({
        kind: 'exit_code',
        code: 0,
        signal: null,
        reason: null,
      });
      // The shipped oracle may fall back to 'conservative' if it detects a
      // dynamic require() inside the copied test workspace — the composer
      // MUST surface that honestly if so.
      // For this clean fixture, 'exact' is the expected answer.

      // Verifying again from `audited_pass` must still work — verifyBehavior
      // does not couple to audit PASS/BLOCK.
      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      const postAudit = await session.verifyBehavior();
      expect(postAudit.status).toBe('AVAILABLE');
      expect(postAudit.linkage.attemptNumber).not.toBeNull();

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('packaged transport returns UNAVAILABLE/no_runner when no runner is wired', async () => {
    const root = makeTempWorkspace('hoplon-t067-transport-');
    try {
      seedSessionErrorFixture(root);
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't067-transport-engine',
      });
      ensureWorkspaceLayout(workspace);

      const engine = await createDefaultHoplonEngine({
        root: workspace.root,
        dbPath: workspace.dbPath,
        gitRepoDir: workspace.gitRepoDir,
        grammarsDir: workspace.grammarsDir,
        engineId: workspace.engineId,
      });
      const nodeFs = createNodeFsAdapter({ root: workspace.root });
      const codeIntelligence = await createTreeSitterIntelligence({
        grammarsDir: workspace.grammarsDir,
      });

      const registry = createSessionRegistry({
        engine,
        fs: nodeFs,
        codeIntelligence,
        projectRoot: workspace.root,
        // No behaviorTestRunner — the transport must surface UNAVAILABLE.
      });
      const dispatcher = createSessionTransportDispatcher({ registry });

      const started = await dispatcher.start({
        manifest: sessionErrorSymbolsManifest('t067-transport'),
      });
      const sessionId = started.session.sessionId;

      await dispatcher.preflight({ sessionId });
      await dispatcher.createSnapshot({ sessionId });
      await dispatcher.applyEdits({
        sessionId,
        proposedChanges: [
          {
            kind: 'patch',
            file: CONTRACTED_PATH,
            hunks: [
              {
                search: "this.name = 'SessionError';",
                replace:
                  "this.name = 'SessionError'; /* t-067 transport probe */",
              },
            ],
          },
        ],
      });

      const response = await dispatcher.verifyBehavior({ sessionId });
      expect(response.session.sessionId).toBe(sessionId);
      const verification = response.data.verification;
      const validated = VerifyBehaviorResultSchema.safeParse(verification);
      expect(validated.success).toBe(true);
      expect(verification.status).toBe('UNAVAILABLE');
      expect(verification.outcome).toBe('NOT_RUN');
      expect(verification.unavailabilityReason).toBe('no_runner');
      expect(verification.execution.runnerId).toBeNull();
      expect(verification.notes).toContain('runner_not_injected');

      dispatcher.close({ sessionId });
      registry.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
