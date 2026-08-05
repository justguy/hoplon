import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLauncherWorkspace, ensureWorkspaceLayout } from '../../src/hoplon/launcher/config.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createNodeFsAdapter } from '../../src/hoplon/adapters/fs/node.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
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

describe('T-071 — structural symbol-targeted proof', () => {
  it('uses the real tree-sitter adapter to replace one contracted top-level symbol and still audits PASS', async () => {
    const root = makeTempWorkspace('hoplon-t071-structural-');
    const baseline = seedSessionErrorFixture(root);

    try {
      const workspace = resolveLauncherWorkspace({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 't071-structural-engine',
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

      const tree = await codeIntelligence.parse(
        CONTRACTED_PATH,
        new TextEncoder().encode(baseline),
      );
      const symbol = codeIntelligence
        .getTopLevelSymbols(tree)
        .find((candidate) => candidate.name === 'SessionError');
      expect(symbol).toBeDefined();
      const [start, end] = symbol!.byteRange;
      const originalClass = baseline.slice(start, end);
      const replacement = originalClass.replace(
        "this.name = 'SessionError';",
        "this.name = 'SessionError'; /* t-071 structural proof */",
      );
      expect(replacement).not.toBe(originalClass);

      const session = createHoplonEditSession({
        engine,
        manifest: sessionErrorSymbolsManifest('t071-structural'),
        fs: adapter,
        codeIntelligence,
      });

      expect((await session.preflight()).status).toBe('PASS');
      await session.createSnapshot();

      const result = await session.applyEdits([
        {
          kind: 'structural',
          file: CONTRACTED_PATH,
          target: { symbol: 'SessionError' },
          content: replacement,
        },
      ]);
      expect(result.changedFiles).toEqual([CONTRACTED_PATH]);
      expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 0, structural: 1 });

      const onDisk = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
      expect(onDisk).toContain('t-071 structural proof');

      const audit = await session.audit();
      expect(audit.status).toBe('PASS');
      expect(session.state).toBe('audited_pass');
      expect(session.snapshot.history.find((entry) => entry.op === 'applyEdits')?.outcome).toEqual({
        kind: 'applyEdits',
        changedFileCount: 1,
        bytesWritten: Buffer.byteLength(onDisk, 'utf8'),
        changeKindCounts: { full_file: 0, patch: 0, structural: 1 },
      });

      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
