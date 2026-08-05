import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dryRun } from '../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../src/hoplon/operations/dryRun.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');
const FS_ROOT = '/';
const GIT_REPO_DIR = '/.hoplon/repo';

function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

async function makeDeps(): Promise<{
  dryRunDeps: DryRunDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createIsolatedTestStore();
  const emitter = createMemoryEmitter();

  return {
    dryRunDeps: {
      fs,
      versioning,
      snapshotStore,
      codeIntelligence: sharedCI,
      emitter,
      engineId: 't071-dryrun-engine',
      config: {
        fsRoot: FS_ROOT,
        gitRepoDir: GIT_REPO_DIR,
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        manifestSchemaVersion: 1,
      },
    },
    snapshotDeps: {
      fs,
      versioning,
      snapshotStore,
      lockProvider: createAsyncMutexLockProvider(),
      emitter,
      secretScanner: createBuiltinRegexScanner(),
      engineId: 't071-dryrun-engine',
      config: {
        gitRepoDir: GIT_REPO_DIR,
        fsRoot: FS_ROOT,
        manifestStorageMode: 'inline',
      },
    },
    fs,
  };
}

function makeManifest(scope: WritableManifest['entries'][number]['scope']): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-t071-dryrun',
    runId: 'run-t071-dryrun',
    correlationId: 'corr-t071-dryrun-seed',
    entries: [{ path: 'src/a.ts', scope }],
  };
}

async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  manifest: WritableManifest,
): Promise<string> {
  const result = await createSnapshot(snapshotDeps, { manifest });
  return result.snapshotRef.id;
}

describe('t-071 dryRun materialization', () => {
  it('materializes a patch variant in memory and PASSes the final in-scope file state', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.ts', enc('export function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(
      snapshotDeps,
      makeManifest({ kind: 'symbols', symbols: ['foo'] }),
    );

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-t071-dryrun',
      runId: 'run-t071-dryrun',
      correlationId: 'corr-t071-dryrun',
      proposedChanges: [
        {
          kind: 'patch',
          file: 'src/a.ts',
          hunks: [{ search: 'return 1;', replace: 'return 42;' }],
        },
      ],
    });

    expect(result.status).toBe('PASS');
  });

  it('materializes a structural variant in memory and PASSes the targeted symbol rewrite', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write(
      'src/a.ts',
      enc('before();\nexport function foo() { return 1; }\nafter();\n'),
    );
    const snapshotRefId = await takeSnapshot(
      snapshotDeps,
      makeManifest({ kind: 'symbols', symbols: ['foo'] }),
    );

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-t071-dryrun',
      runId: 'run-t071-dryrun',
      correlationId: 'corr-t071-dryrun',
      proposedChanges: [
        {
          kind: 'structural',
          file: 'src/a.ts',
          target: { symbol: 'foo' },
          content: 'export function foo() { return 99; }\n',
        },
      ],
    });

    expect(result.status).toBe('PASS');
  });

  it('returns parse_failure when a patch anchor cannot be applied to the snapshot baseline', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.ts', enc('export function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(
      snapshotDeps,
      makeManifest({ kind: 'symbols', symbols: ['foo'] }),
    );

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-t071-dryrun',
      runId: 'run-t071-dryrun',
      correlationId: 'corr-t071-dryrun',
      proposedChanges: [
        {
          kind: 'patch',
          file: 'src/a.ts',
          hunks: [{ search: 'return 2;', replace: 'return 42;' }],
        },
      ],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'parse_failure',
            path: 'src/a.ts',
            parseError: 'patch_not_applicable',
          }),
        ]),
      );
    }
  });

  it('rethrows non-not-found readBlob failures instead of assuming an empty baseline', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.ts', enc('export function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(
      snapshotDeps,
      makeManifest({ kind: 'symbols', symbols: ['foo'] }),
    );

    const brokenVersioning: VersioningAdapter = {
      ...dryRunDeps.versioning,
      async readBlob(): Promise<Uint8Array> {
        throw new AdapterError(
          {
            kind: 'git_read_failed',
            engineId: 't071-dryrun-engine',
            correlationId: 'corr-t071-dryrun',
            cause: { code: 'InternalError', name: 'InternalError', data: { what: 'broken-pack' } },
          },
          'simulated readBlob infrastructure failure',
        );
      },
    };

    await expect(
      dryRun(
        { ...dryRunDeps, versioning: brokenVersioning },
        {
          snapshotRefId,
          projectId: 'proj-t071-dryrun',
          runId: 'run-t071-dryrun',
          correlationId: 'corr-t071-dryrun',
          proposedChanges: [{ kind: 'patch', file: 'src/a.ts', hunks: [{ search: 'return 1;', replace: 'return 2;' }] }],
        },
      ),
    ).rejects.toMatchObject({
      kind: 'git_read_failed',
      message: 'simulated readBlob infrastructure failure',
    });
  });

  it('returns parse_failure when structural materialization hits a parser_init_failed adapter error', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.ts', enc('export function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(
      snapshotDeps,
      makeManifest({ kind: 'symbols', symbols: ['foo'] }),
    );

    const brokenCI: CodeIntelligenceAdapter = {
      async parse(): Promise<never> {
        throw new AdapterError(
          {
            kind: 'parser_init_failed',
            engineId: 't071-dryrun-engine',
            correlationId: 'corr-t071-dryrun',
            cause: { reason: 'file_too_large' },
          },
          'simulated parser failure',
        );
      },
      getTopLevelSymbols() {
        return [];
      },
    };

    const result = await dryRun(
      { ...dryRunDeps, codeIntelligence: brokenCI },
      {
        snapshotRefId,
        projectId: 'proj-t071-dryrun',
        runId: 'run-t071-dryrun',
        correlationId: 'corr-t071-dryrun',
        proposedChanges: [
          {
            kind: 'structural',
            file: 'src/a.ts',
            target: { symbol: 'foo' },
            content: 'export function foo() { return 2; }\n',
          },
        ],
      },
    );

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'parse_failure',
            path: 'src/a.ts',
            parseError: 'file_too_large',
          }),
        ]),
      );
    }
  });
});
