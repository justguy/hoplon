/**
 * tests/operations/hcr001SnapshotIdentity.test.ts — hcr-001 regression corpus.
 *
 * (6a) Snapshot identity covers manifest paths AND actual file bytes:
 *      same manifest + changed bytes → NEW snapshot; same manifest + same
 *      bytes → committed-snapshot reuse (property preserved).
 * (6b) The snapshot commit tree is manifest-exact — no stale paths from
 *      earlier snapshots leak into later commits.
 * (7)  Single read pipeline closes the DLP scan-to-commit race: the bytes
 *      that were scanned are the bytes that are committed, even when an
 *      intervening write lands between scan and commit.
 * (gap) The git ref is persisted on the still-pending row before Phase C, so
 *      a crash between Phase B and C leaves recoverable evidence.
 *
 * In-memory adapters only (memfs + isomorphic-git + isolated sqlite).
 */

import { describe, it, expect } from 'vitest';

import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createMockPatternDlpAdapter } from '../../src/hoplon/adapters/dlp.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { CreateSnapshotRequest } from '../../src/hoplon/contracts/requests.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function makeDeps(opts?: {
  fs?: HoplonFsAdapter;
  snapshotStore?: SnapshotStore;
  dlp?: CreateSnapshotDeps['dlp'];
  dlpPolicyMode?: 'disabled' | 'warn' | 'block';
}): Promise<{ deps: CreateSnapshotDeps; fs: HoplonFsAdapter; store: SnapshotStore }> {
  const fs = opts?.fs ?? createMemFsAdapter();
  const store = opts?.snapshotStore ?? (await createIsolatedTestStore());
  const deps: CreateSnapshotDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    secretScanner: createBuiltinRegexScanner(),
    ...(opts?.dlp !== undefined ? { dlp: opts.dlp } : {}),
    engineId: 'test-engine',
    config: {
      gitRepoDir: '/.hoplon/repo',
      fsRoot: '/',
      manifestStorageMode: 'inline',
      ...(opts?.dlpPolicyMode !== undefined ? { dlpPolicyMode: opts.dlpPolicyMode } : {}),
    },
  };
  return { deps, fs, store };
}

function makeReq(
  overrides: Partial<CreateSnapshotRequest['manifest']> = {},
): CreateSnapshotRequest {
  return {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' as const } }],
      ...overrides,
    },
  };
}

describe('hcr-001 6a: same manifest + changed bytes → new snapshot', () => {
  it('produces a different id and commits the new bytes instead of reusing the stale ref', async () => {
    const { deps, fs, store } = await makeDeps();

    await fs.write('src/a.ts', enc('export const v = 1;\n'));
    const first = await createSnapshot(deps, makeReq());

    // Same manifest, different file bytes — the defect returned the OLD
    // committed ref here without rereading the file.
    await fs.write('src/a.ts', enc('export const v = 2;\n'));
    const second = await createSnapshot(deps, makeReq());

    expect(second.snapshotRef.id).not.toBe(first.snapshotRef.id);

    const firstRecord = await store.get(first.snapshotRef.id);
    const secondRecord = await store.get(second.snapshotRef.id);
    expect(firstRecord?.status).toBe('committed');
    expect(secondRecord?.status).toBe('committed');

    const firstBytes = await deps.versioning.readBlob(
      deps.config.gitRepoDir,
      firstRecord!.gitRef!,
      'src/a.ts',
    );
    const secondBytes = await deps.versioning.readBlob(
      deps.config.gitRepoDir,
      secondRecord!.gitRef!,
      'src/a.ts',
    );
    expect(dec(firstBytes)).toBe('export const v = 1;\n');
    expect(dec(secondBytes)).toBe('export const v = 2;\n');
  });
});

describe('hcr-001 6a: same manifest + same bytes reuses the committed snapshot', () => {
  it('keeps the reuse property: identical content short-circuits to one row', async () => {
    const { deps, fs, store } = await makeDeps();

    await fs.write('src/a.ts', enc('export const v = 1;\n'));
    const first = await createSnapshot(deps, makeReq());
    const second = await createSnapshot(deps, makeReq());

    expect(second.snapshotRef.id).toBe(first.snapshotRef.id);
    expect(second.warnings).toHaveLength(0); // short-circuit skips the re-scan
    expect(await store.findByProjectAndRun('proj-test', 'run-001')).toHaveLength(1);
  });
});

describe('hcr-001 6b: snapshot commit tree is manifest-exact', () => {
  it('does not carry paths from an earlier snapshot into a later commit', async () => {
    const { deps, fs, store } = await makeDeps();

    await fs.write('src/a.ts', enc('export const a = 1;\n'));
    await fs.write('src/b.ts', enc('export const b = 1;\n'));

    // First snapshot contracts BOTH files.
    await createSnapshot(
      deps,
      makeReq({
        entries: [
          { path: 'src/a.ts', scope: { kind: 'whole_file' as const } },
          { path: 'src/b.ts', scope: { kind: 'whole_file' as const } },
        ],
      }),
    );

    // Second snapshot contracts only src/b.ts. Before the fix, src/a.ts
    // persisted in the git tree from the earlier commit — an unscanned,
    // out-of-contract historical file inside the new snapshot.
    const second = await createSnapshot(
      deps,
      makeReq({
        runId: 'run-002',
        correlationId: 'corr-002',
        entries: [{ path: 'src/b.ts', scope: { kind: 'whole_file' as const } }],
      }),
    );

    const secondRecord = await store.get(second.snapshotRef.id);
    const files = await deps.versioning.listFilesAtRef(
      deps.config.gitRepoDir,
      secondRecord!.gitRef!,
    );
    expect(files.map((f) => f.filepath)).toEqual(['src/b.ts']);
  });
});

describe('hcr-001 7: DLP scan-to-commit race is closed', () => {
  it('commits exactly the scanned bytes even when an intervening write lands', async () => {
    const baseFs = createMemFsAdapter();
    const benign = 'const note = "all clear";\n';
    const secret = 'const ssn = "123-45-6789";\n';
    await baseFs.write('src/data.ts', enc(benign));

    // Racing writer: immediately after the FIRST read of src/data.ts, an SSN
    // lands in the source file. With the old double-read flow the scan saw
    // benign bytes and the commit reread (and committed) the SSN silently.
    let dataReads = 0;
    const racingFs: HoplonFsAdapter = {
      read: async (path) => {
        const bytes = await baseFs.read(path);
        if (path === 'src/data.ts') {
          dataReads++;
          if (dataReads === 1) {
            await baseFs.write('src/data.ts', enc(secret));
          }
        }
        return bytes;
      },
      write: (path, content) => baseFs.write(path, content),
      list: (path) => baseFs.list(path),
      stat: (path) => baseFs.stat(path),
      mkdir: (path, o) => baseFs.mkdir(path, o),
      remove: (path) => baseFs.remove(path),
    };

    const { deps, store } = await makeDeps({
      fs: racingFs,
      dlp: createMockPatternDlpAdapter({
        rules: [
          {
            ruleId: 'pii.ssn',
            classification: 'pii',
            pattern: /\d{3}-\d{2}-\d{4}/,
          },
        ],
      }),
      dlpPolicyMode: 'block',
    });

    const result = await createSnapshot(
      deps,
      makeReq({ entries: [{ path: 'src/data.ts', scope: { kind: 'whole_file' as const } }] }),
    );

    // The scan saw benign bytes → no block. The committed bytes MUST be those
    // same scanned benign bytes — never the unscanned SSN.
    const record = await store.get(result.snapshotRef.id);
    expect(record?.status).toBe('committed');
    const committed = await deps.versioning.readBlob(
      deps.config.gitRepoDir,
      record!.gitRef!,
      'src/data.ts',
    );
    expect(dec(committed)).toBe(benign);
    expect(dec(committed)).not.toContain('123-45-6789');
  });
});

describe('hcr-001 gap: git ref evidence persisted before Phase C', () => {
  it('leaves a pending row that carries its gitRef when Phase C fails', async () => {
    const baseStore = await createIsolatedTestStore();

    // Spy store: Phase C (updateStatus → 'committed') crashes; everything
    // else — including the pre-finalization ref-evidence write — passes
    // through to the real store.
    const spyStore: SnapshotStore = {
      put: (record) => baseStore.put(record),
      get: (id) => baseStore.get(id),
      findByProjectAndRun: (p, r) => baseStore.findByProjectAndRun(p, r),
      updateStatus: async (id, status, reason, gitRef) => {
        if (status === 'committed') {
          throw new Error('simulated Phase C crash');
        }
        return baseStore.updateStatus(id, status, reason, gitRef);
      },
      listPending: (ms) => baseStore.listPending(ms),
      gc: (opts) => baseStore.gc(opts),
      appendAuditLog: (record) => baseStore.appendAuditLog(record),
      findAuditLogByProjectAndRun: (p, r) => baseStore.findAuditLogByProjectAndRun(p, r),
      gcAuditLog: (opts) => baseStore.gcAuditLog(opts),
      findPolicyAuditEntries: (request) => baseStore.findPolicyAuditEntries(request),
      verifyAuditLogIntegrity: (request) => baseStore.verifyAuditLogIntegrity(request),
      ...(baseStore.recordPendingGitRef
        ? {
            recordPendingGitRef: (id: string, gitRef: string) =>
              baseStore.recordPendingGitRef!(id, gitRef),
          }
        : {}),
    };

    const { deps, fs } = await makeDeps({ snapshotStore: spyStore });
    await fs.write('src/a.ts', enc('const x = 1;'));

    await expect(createSnapshot(deps, makeReq())).rejects.toThrow(AdapterError);

    const rows = await baseStore.findByProjectAndRun('proj-test', 'run-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    // The recovery-critical evidence: the pending row knows its commit SHA.
    expect(rows[0]!.gitRef).toMatch(/^[0-9a-f]{40}$/);
  });
});
