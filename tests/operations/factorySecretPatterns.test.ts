/**
 * tests/operations/factorySecretPatterns.test.ts — F2 regression.
 *
 * The public `HoplonEngineConfig.secretPatterns` documents: "Override the
 * built-in secret regex patterns for createSnapshot scanning." Previously the
 * factory resolved and then discarded this value, so a custom secret pattern
 * never reached the scanning path. This suite proves that an engine built with
 * a custom secretPattern actually flags matching content through
 * engine.createSnapshot.
 *
 * In-memory adapters only (no disk, no live git binary, no LLM).
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import type { HoplonAdapters } from '../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createNoopAnalyzer } from '../../src/hoplon/adapters/staticAnalysis/noop.js';
import type { CreateSnapshotRequest } from '../../src/hoplon/contracts/requests.js';

async function buildAdapters(): Promise<{
  adapters: HoplonAdapters;
  fs: ReturnType<typeof createMemFsAdapter>;
}> {
  const fs = createMemFsAdapter();
  const adapters: HoplonAdapters = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: await createIsolatedTestStore(),
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    codeIntelligence: {
      async parse() {
        return { rootNode: { kind: 'program', children: [] } };
      },
      getTopLevelSymbols() {
        return [];
      },
    } as unknown as HoplonAdapters['codeIntelligence'],
    // Injected scanner deliberately scans NOTHING. If the factory ignores
    // config.secretPatterns (the bug) this no-op scanner is what runs and no
    // warning is produced.
    secretScanner: createBuiltinRegexScanner({ patterns: [] }),
    staticAnalysis: createNoopAnalyzer(),
  };
  return { adapters, fs };
}

function snapshotRequest(): CreateSnapshotRequest {
  return {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-f2',
      runId: 'run-f2',
      correlationId: 'corr-f2',
      entries: [{ path: 'secret.txt', scope: { kind: 'whole_file' } }],
    },
  } as unknown as CreateSnapshotRequest;
}

describe('F2 — config.secretPatterns is wired into createSnapshot scanning', () => {
  it('flags content matching a caller-supplied custom secretPattern', async () => {
    const { adapters, fs } = await buildAdapters();
    await fs.write('secret.txt', new TextEncoder().encode("token = 'HOPLONSECRET-4242';\n"));

    const engine = await createHoplonEngine(adapters, {
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
      secretPatterns: [/HOPLONSECRET-[0-9]+/],
    });

    const result = await engine.createSnapshot(snapshotRequest());
    const secretWarnings = result.warnings.filter((w) => w.kind === 'possible_secret');
    expect(secretWarnings.length).toBeGreaterThan(0);
  });

  it('does not scan with custom patterns when none are configured (default unchanged)', async () => {
    const { adapters, fs } = await buildAdapters();
    await fs.write('secret.txt', new TextEncoder().encode("token = 'HOPLONSECRET-4242';\n"));

    // No secretPatterns → injected no-op scanner runs unchanged → no warnings.
    const engine = await createHoplonEngine(adapters, {
      fsRoot: '/',
      gitRepoDir: '/.hoplon/repo',
    });

    const result = await engine.createSnapshot(snapshotRequest());
    const secretWarnings = result.warnings.filter((w) => w.kind === 'possible_secret');
    expect(secretWarnings.length).toBe(0);
  });
});
