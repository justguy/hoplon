import { describe, expect, it, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import { dryRun } from '../../src/hoplon/operations/dryRun.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');
const GIT_REPO_DIR = '/.hoplon/repo';

let codeIntelligence: CodeIntelligenceAdapter;

beforeAll(async () => {
  codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: GRAMMARS_DIR,
  });
}, 30_000);

describe('dryRun invariant bindings', () => {
  it('returns a non-blocking invariant report beside the deterministic audit result', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const snapshotStore = await createIsolatedTestStore();
    const emitter = createMemoryEmitter();
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-invariants',
      runId: 'run-invariants',
      correlationId: 'corr-invariants',
      entries: [{ path: 'src/api.ts', scope: { kind: 'whole_file' } }],
    };

    await fs.write(
      'src/api.ts',
      new TextEncoder().encode('export function loadUser() { return null; }\n'),
    );
    const snapshot = await createSnapshot({
      fs,
      versioning,
      snapshotStore,
      lockProvider: createAsyncMutexLockProvider(),
      emitter,
      secretScanner: createBuiltinRegexScanner(),
      engineId: 'test-engine',
      config: {
        gitRepoDir: GIT_REPO_DIR,
        fsRoot: '/',
        manifestStorageMode: 'inline',
      },
    }, { manifest });

    const result = await dryRun({
      fs,
      versioning,
      snapshotStore,
      codeIntelligence,
      emitter,
      engineId: 'test-engine',
      config: {
        fsRoot: '/',
        gitRepoDir: GIT_REPO_DIR,
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        manifestSchemaVersion: 1,
      },
    }, {
      snapshotRefId: snapshot.snapshotRef.id,
      projectId: manifest.projectId,
      runId: manifest.runId,
      correlationId: manifest.correlationId,
      proposedChanges: [
        {
          file: 'src/api.ts',
          content:
            'export async function loadUser(): Promise<Response> { return fetch("/user"); }\n',
        },
      ],
      invariantBindings: [
        {
          id: 'loadUser-export',
          kind: 'exported_symbol_exists',
          file: 'src/api.ts',
          symbolName: 'loadUser',
        },
        {
          id: 'unsupported',
          kind: 'unsupported',
          requestedKind: 'free_form_policy_claim',
        },
      ],
    });

    expect(result.status).toBe('PASS');
    expect(result.invariantReport?.blockingEnabled).toBe(false);
    expect(result.invariantReport?.results.map((r) => [r.invariantId, r.status])).toEqual([
      ['loadUser-export', 'PROVED'],
      ['unsupported', 'UNSUPPORTED'],
    ]);
  });
});
