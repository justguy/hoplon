import { describe, expect, it } from 'vitest';

import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import type { SnapshotRecord, SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { RevertRequest } from '../../src/hoplon/contracts/requests.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { revertUncontracted } from '../../src/hoplon/operations/revertUncontracted.js';
import type { RevertUncontractedDeps } from '../../src/hoplon/operations/revertUncontracted.js';

const te = new TextEncoder();
const td = new TextDecoder();

function enc(value: string): Uint8Array {
  return te.encode(value);
}

function dec(value: Uint8Array): string {
  return td.decode(value);
}

async function makeHarness(): Promise<{
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
  store: SnapshotStore;
  snapshotDeps: CreateSnapshotDeps;
  revertDeps: RevertUncontractedDeps;
}> {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const versioning = createIsomorphicGitVersioning({ fs });
  const base = {
    snapshotStore: store,
    lockProvider,
    emitter,
    engineId: 'test-engine',
    config: {
      gitRepoDir: '/.hoplon/repo',
      fsRoot: '/',
    },
  };
  return {
    fs,
    emitter,
    store,
    snapshotDeps: {
      fs,
      versioning,
      secretScanner: createBuiltinRegexScanner(),
      ...base,
      config: { ...base.config, manifestStorageMode: 'inline' },
    },
    revertDeps: {
      fs,
      versioning,
      ...base,
      config: {
        ...base.config,
        revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**'],
      },
    },
  };
}

async function takeSnapshot(
  deps: CreateSnapshotDeps,
  entries: readonly string[],
): Promise<string> {
  const result = await createSnapshot(deps, {
    manifest: {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      entries: entries.map((path) => ({ path, scope: { kind: 'whole_file' as const } })),
    },
  });
  return result.snapshotRef.id;
}

function req(snapshotRefId: string, overrides: Partial<RevertRequest> = {}): RevertRequest {
  return {
    snapshotRefId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    ...overrides,
  };
}

function fsFailingWrite(
  base: ReturnType<typeof createMemFsAdapter>,
  failPath: string,
): HoplonFsAdapter & { writes: string[]; removes: string[] } {
  const writes: string[] = [];
  const removes: string[] = [];
  return {
    read: (path) => base.read(path),
    write: async (path, content) => {
      writes.push(path);
      if (path === failPath) throw new Error(`injected write failure: ${path}`);
      await base.write(path, content);
    },
    list: (path) => base.list(path),
    stat: (path) => base.stat(path),
    mkdir: (path, opts) => base.mkdir(path, opts),
    remove: async (path) => {
      removes.push(path);
      await base.remove(path);
    },
    writes,
    removes,
  };
}

function fsSpyingMutations(
  base: ReturnType<typeof createMemFsAdapter>,
): HoplonFsAdapter & { writes: string[]; removes: string[] } {
  const writes: string[] = [];
  const removes: string[] = [];
  return {
    read: (path) => base.read(path),
    write: async (path, content) => {
      writes.push(path);
      await base.write(path, content);
    },
    list: (path) => base.list(path),
    stat: (path) => base.stat(path),
    mkdir: (path, opts) => base.mkdir(path, opts),
    remove: async (path) => {
      removes.push(path);
      await base.remove(path);
    },
    writes,
    removes,
  };
}

function storeWithRecord(
  base: SnapshotStore,
  transform: (record: SnapshotRecord) => SnapshotRecord,
): SnapshotStore {
  const wrapped: SnapshotStore = {
    put: (record) => base.put(record),
    get: async (id) => {
      const record = await base.get(id);
      return record === null ? null : transform(record);
    },
    findByProjectAndRun: (projectId, runId) => base.findByProjectAndRun(projectId, runId),
    updateStatus: (id, status, reason, gitRef) => base.updateStatus(id, status, reason, gitRef),
    listPending: (olderThanMs) => base.listPending(olderThanMs),
    gc: (opts) => base.gc(opts),
    appendAuditLog: (record) => base.appendAuditLog(record),
    findAuditLogByProjectAndRun: (projectId, runId) =>
      base.findAuditLogByProjectAndRun(projectId, runId),
    gcAuditLog: (opts) => base.gcAuditLog(opts),
    findPolicyAuditEntries: (request) => base.findPolicyAuditEntries(request),
    verifyAuditLogIntegrity: (request) => base.verifyAuditLogIntegrity(request),
  };
  if (base.listByReplica) wrapped.listByReplica = (replicaId) => base.listByReplica!(replicaId);
  if (base.setReplicaIds) {
    wrapped.setReplicaIds = (id, replicaIds) => base.setReplicaIds!(id, replicaIds);
  }
  return wrapped;
}

async function captureRevertError(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AdapterError);
    return err as AdapterError;
  }
  throw new Error('expected revertUncontracted to fail');
}

describe('t-110 revert recovery chaos corpus', () => {
  it('surfaces non-idempotent recovery guidance after partial manifest restore failure', async () => {
    const h = await makeHarness();
    await h.fs.write('src/a.ts', enc('original-a'));
    await h.fs.write('src/b.ts', enc('original-b'));
    const snapshotId = await takeSnapshot(h.snapshotDeps, ['src/a.ts', 'src/b.ts']);
    await h.fs.write('src/a.ts', enc('modified-a'));
    await h.fs.write('src/b.ts', enc('modified-b'));
    const failingFs = fsFailingWrite(h.fs, 'src/b.ts');
    h.revertDeps.fs = failingFs;

    const error = await captureRevertError(
      revertUncontracted(h.revertDeps, req(snapshotId)),
    );

    expect(error.kind).toBe('fs_write_failed');
    expect(error.correlationId).toBe('corr-001');
    expect(error.message).toMatch(/not idempotent/);
    expect(error.message).toMatch(/do not retry blindly/);
    expect(failingFs.writes).toEqual(['src/a.ts', 'src/b.ts']);
    expect(failingFs.removes).toEqual([]);
    expect(dec(await h.fs.read('src/a.ts'))).toBe('original-a');
    expect(dec(await h.fs.read('src/b.ts'))).toBe('modified-b');
    const events = h.emitter.getEvents().filter((event) => event.op === 'revertUncontracted');
    expect(events.some((event) => event.phase === 'end')).toBe(false);
    expect(events.find((event) => event.phase === 'error')?.errorKind).toBe('fs_write_failed');
  });

  it('proves broad and narrow revertAllowlist misconfiguration with path evidence', async () => {
    const broad = await makeHarness();
    broad.revertDeps.config.revertAllowlist = ['**'];
    await broad.fs.write('src/a.ts', enc('original'));
    const broadSnapshotId = await takeSnapshot(broad.snapshotDeps, ['src/a.ts']);
    await broad.fs.write('generated/survives.txt', enc('broadly protected'));

    const broadResult = await revertUncontracted(broad.revertDeps, req(broadSnapshotId));

    expect(broadResult.allowlistSkipped).toContain('generated/survives.txt');
    expect(broadResult.deleted).not.toContain('generated/survives.txt');
    expect((await broad.fs.stat('generated/survives.txt')).exists).toBe(true);

    const narrow = await makeHarness();
    narrow.revertDeps.config.revertAllowlist = ['custom/**', '.hoplon/**'];
    await narrow.fs.write('src/a.ts', enc('original'));
    const narrowSnapshotId = await takeSnapshot(narrow.snapshotDeps, ['src/a.ts']);
    await narrow.fs.write('custom/survives.txt', enc('narrowly protected'));
    await narrow.fs.write('.git/HEAD', enc('ref: refs/heads/main'));

    const narrowResult = await revertUncontracted(narrow.revertDeps, req(narrowSnapshotId));

    expect(narrowResult.allowlistSkipped).toContain('custom/survives.txt');
    expect(narrowResult.deleted).toContain('.git/HEAD');
    expect((await narrow.fs.stat('custom/survives.txt')).exists).toBe(true);
    expect((await narrow.fs.stat('.git/HEAD')).exists).toBe(false);
  });

  it('escalates registry/git-object split-brain before mutating the workspace', async () => {
    const h = await makeHarness();
    await h.fs.write('src/a.ts', enc('original'));
    const snapshotId = await takeSnapshot(h.snapshotDeps, ['src/a.ts']);
    await h.fs.write('src/a.ts', enc('modified'));
    const mutationSpy = fsSpyingMutations(h.fs);
    h.revertDeps.fs = mutationSpy;
    h.revertDeps.snapshotStore = storeWithRecord(h.store, (record) => ({
      ...record,
      gitRef: 'f'.repeat(40),
    }));

    const error = await captureRevertError(
      revertUncontracted(h.revertDeps, req(snapshotId)),
    );

    expect(error.kind).toBe('git_read_failed');
    expect(error.message).toMatch(/split-brain/);
    expect(error.message).toMatch(/fresh snapshot|escalate/);
    expect(mutationSpy.writes).toEqual([]);
    expect(mutationSpy.removes).toEqual([]);
    expect(dec(await h.fs.read('src/a.ts'))).toBe('modified');
  });
});
