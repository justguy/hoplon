import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');
const GIT_REPO_DIR = '/.hoplon/repo';

function manifestFor(path: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-t125',
    runId: 'run-t125',
    correlationId: 'corr-t125',
    entries: [{ path, scope: { kind: 'whole_file' } }],
  };
}

async function buildBundle() {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createIsolatedTestStore();
  const engine = await createHoplonEngine(
    {
      fs,
      versioning,
      snapshotStore,
      lockProvider: createAsyncMutexLockProvider(),
      emitter: createMemoryEmitter(),
      codeIntelligence: await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR }),
      secretScanner: createBuiltinRegexScanner(),
    },
    {
      engineId: 't125-engine',
      fsRoot: '/',
      gitRepoDir: GIT_REPO_DIR,
    },
  );
  return { fs, versioning, snapshotStore, engine };
}

describe('t-125 session line provenance evidence', () => {
  it('returns bounded line provenance for a manifest-owned line range', async () => {
    const { fs, versioning, snapshotStore, engine } = await buildBundle();
    await fs.write('src/foo.ts', new TextEncoder().encode('one\ntwo\n'));
    const session = createHoplonEditSession({
      engine,
      manifest: manifestFor('src/foo.ts'),
      fs,
      versioning,
      snapshotStore,
      gitRepoDir: GIT_REPO_DIR,
    });
    await session.preflight();
    const ref = await session.createSnapshot();

    const result = await session.getSnapshotEvidence({
      kind: 'line_provenance',
      snapshotRefId: ref.id,
      file: 'src/foo.ts',
      target: { kind: 'line_range', lineRange: { startLine: 2, endLine: 2 } },
    });

    expect(result.kind).toBe('line_provenance');
    if (result.kind !== 'line_provenance') throw new Error('unreachable');
    expect(result.snapshotRefId).toBe(ref.id);
    expect(result.file).toBe('src/foo.ts');
    expect(result.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(result.snapshotGitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit.commitId).toBe(result.snapshotGitCommitSha);
    expect(result.commit.messageFirstLine).toContain('hoplon-snapshot');
    session.close();
  }, 60_000);

  it('accepts a syntax-node target carrying a concrete line range', async () => {
    const { fs, versioning, snapshotStore, engine } = await buildBundle();
    await fs.write('src/foo.ts', new TextEncoder().encode('function foo() {\n  return 1;\n}\n'));
    const session = createHoplonEditSession({
      engine,
      manifest: manifestFor('src/foo.ts'),
      fs,
      versioning,
      snapshotStore,
      gitRepoDir: GIT_REPO_DIR,
    });
    await session.preflight();
    const ref = await session.createSnapshot();

    const result = await session.getSnapshotEvidence({
      kind: 'line_provenance',
      snapshotRefId: ref.id,
      file: 'src/foo.ts',
      target: {
        kind: 'syntax_node',
        syntaxNode: {
          nodeKind: 'function_declaration',
          lineRange: { startLine: 1, endLine: 3 },
        },
      },
    });

    expect(result.kind).toBe('line_provenance');
    if (result.kind !== 'line_provenance') throw new Error('unreachable');
    expect(result.target.kind).toBe('syntax_node');
    expect(result.lineRange).toEqual({ startLine: 1, endLine: 3 });
    session.close();
  }, 60_000);

  it('fails closed when the requested file is outside the snapshot manifest', async () => {
    const { fs, versioning, snapshotStore, engine } = await buildBundle();
    await fs.write('src/foo.ts', new TextEncoder().encode('one\n'));
    const session = createHoplonEditSession({
      engine,
      manifest: manifestFor('src/foo.ts'),
      fs,
      versioning,
      snapshotStore,
      gitRepoDir: GIT_REPO_DIR,
    });
    await session.preflight();
    const ref = await session.createSnapshot();

    await expect(
      session.getSnapshotEvidence({
        kind: 'line_provenance',
        snapshotRefId: ref.id,
        file: 'src/not-owned.ts',
        target: { kind: 'line_range', lineRange: { startLine: 1, endLine: 1 } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    session.close();
  }, 60_000);
});
