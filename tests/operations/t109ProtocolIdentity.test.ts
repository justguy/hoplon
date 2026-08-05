import { describe, expect, it, vi } from 'vitest';

import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { SnapshotRecord, SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { hashManifest, hashManifestWithContent } from '../../src/hoplon/util/hashManifest.js';

function enc(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function manifest(runId: string, projectId = 'proj-t109'): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId,
    runId,
    correlationId: `corr-${projectId}-${runId}`,
    entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
  };
}

async function makeSnapshotDeps(): Promise<{
  deps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
}> {
  const fs = createMemFsAdapter();
  const deps: CreateSnapshotDeps = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: await createIsolatedTestStore(),
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'engine-t109',
    config: {
      gitRepoDir: '/.hoplon/repo',
      fsRoot: '/',
      manifestStorageMode: 'inline',
    },
  };
  return { deps, fs };
}

function inertCodeIntelligence(): CodeIntelligenceAdapter {
  return {
    parse: vi.fn(async () => {
      throw new Error('code intelligence must not be reached');
    }),
  } as unknown as CodeIntelligenceAdapter;
}

async function putSnapshotRecord(
  snapshotStore: SnapshotStore,
  storedManifest: WritableManifest,
  overrides: Partial<SnapshotRecord> = {},
): Promise<string> {
  const record: SnapshotRecord = {
    id: overrides.id ?? hashManifest(storedManifest),
    manifestSchemaVersion: overrides.manifestSchemaVersion ?? 1,
    engineId: overrides.engineId ?? 'engine-t109',
    projectId: overrides.projectId ?? storedManifest.projectId,
    runId: overrides.runId ?? storedManifest.runId,
    correlationId: overrides.correlationId ?? storedManifest.correlationId,
    status: overrides.status ?? 'committed',
    statusReason: overrides.statusReason ?? null,
    gitRef: overrides.gitRef ?? 'a'.repeat(40),
    manifest: overrides.manifest ?? storedManifest,
    createdAt: overrides.createdAt ?? '2026-04-28T00:00:00.000Z',
    ttlExpires: overrides.ttlExpires ?? null,
    replicaIds: overrides.replicaIds ?? [],
  };
  await snapshotStore.put(record);
  return record.id;
}

async function makeAuditHarness(
  storedManifest: WritableManifest,
  overrides: Partial<SnapshotRecord> = {},
): Promise<{
  deps: AuditDiffDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  snapshotRefId: string;
}> {
  const snapshotStore = await createIsolatedTestStore();
  const fs = createMemFsAdapter();
  const snapshotRefId = await putSnapshotRecord(snapshotStore, storedManifest, overrides);
  return {
    fs,
    snapshotRefId,
    deps: {
      fs,
      versioning: createIsomorphicGitVersioning({ fs }),
      snapshotStore,
      codeIntelligence: inertCodeIntelligence(),
      emitter: createMemoryEmitter(),
      engineId: 'engine-t109',
      config: {
        fsRoot: '/',
        gitRepoDir: '/.hoplon/repo',
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        manifestSchemaVersion: 1,
      },
    },
  };
}

describe('t-109 protocol identity proof corpus', () => {
  it('fresh runId changes content-addressed snapshot identity instead of reusing a stale run snapshot', async () => {
    const { deps, fs } = await makeSnapshotDeps();
    await fs.write('src/a.ts', enc('export const value = 1;\n'));

    const first = await createSnapshot(deps, { manifest: manifest('run-A') });
    const second = await createSnapshot(deps, { manifest: manifest('run-B') });

    expect(first.snapshotRef.id).not.toBe(second.snapshotRef.id);
    expect(first.snapshotRef.runId).toBe('run-A');
    expect(second.snapshotRef.runId).toBe('run-B');

    expect(await deps.snapshotStore.findByProjectAndRun('proj-t109', 'run-A')).toHaveLength(1);
    expect(await deps.snapshotStore.findByProjectAndRun('proj-t109', 'run-B')).toHaveLength(1);
  });

  it('same manifest in the same run reuses the committed content-addressed snapshot', async () => {
    const { deps, fs } = await makeSnapshotDeps();
    await fs.write('src/a.ts', enc('export const value = 1;\n'));

    const first = await createSnapshot(deps, { manifest: manifest('run-C') });
    const second = await createSnapshot(deps, { manifest: manifest('run-C') });

    expect(second.snapshotRef.id).toBe(first.snapshotRef.id);
    expect(await deps.snapshotStore.findByProjectAndRun('proj-t109', 'run-C')).toHaveLength(1);
  });

  it('stale committed duplicate with the same id but wrong run fails instead of reusing the stale runId', async () => {
    const { deps } = await makeSnapshotDeps();
    const putSpy = vi.spyOn(deps.snapshotStore, 'put');
    const commitSpy = vi.spyOn(deps.versioning, 'commit');
    const requestedManifest = manifest('run-fresh');
    const staleManifest = manifest('run-stale');
    // hcr-001: identity covers manifest + file bytes. src/a.ts is absent on
    // this volume, so the request's content-addressed id hashes an absent entry.
    const snapshotRefId = hashManifestWithContent(requestedManifest, [
      { path: 'src/a.ts', contentSha256: null },
    ]);

    await putSnapshotRecord(deps.snapshotStore, staleManifest, {
      id: snapshotRefId,
      projectId: requestedManifest.projectId,
      gitRef: 'c'.repeat(40),
    });
    putSpy.mockClear();

    await expect(
      createSnapshot(deps, { manifest: requestedManifest }),
    ).rejects.toMatchObject({ kind: 'run_id_mismatch' });

    expect(putSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('stale committed duplicate with the same id but wrong project fails before snapshot reuse', async () => {
    const { deps } = await makeSnapshotDeps();
    const putSpy = vi.spyOn(deps.snapshotStore, 'put');
    const commitSpy = vi.spyOn(deps.versioning, 'commit');
    const requestedManifest = manifest('run-project', 'proj-current');
    const staleManifest = manifest('run-project', 'proj-stale');
    // hcr-001: identity covers manifest + file bytes (absent entry here).
    const snapshotRefId = hashManifestWithContent(requestedManifest, [
      { path: 'src/a.ts', contentSha256: null },
    ]);

    await putSnapshotRecord(deps.snapshotStore, staleManifest, {
      id: snapshotRefId,
      runId: requestedManifest.runId,
      gitRef: 'd'.repeat(40),
    });
    putSpy.mockClear();

    await expect(
      createSnapshot(deps, { manifest: requestedManifest }),
    ).rejects.toMatchObject({ kind: 'project_id_mismatch' });

    expect(putSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('wrong-run snapshot refs fail as SemanticError before any filesystem or parser read', async () => {
    const storedManifest = manifest('run-origin');
    const { deps, fs, snapshotRefId } = await makeAuditHarness(storedManifest);
    const readSpy = vi.spyOn(fs, 'read');
    const statSpy = vi.spyOn(fs, 'stat');

    await expect(
      auditDiff(deps, {
        snapshotRefId,
        projectId: 'proj-t109',
        runId: 'run-retry-stale',
        correlationId: 'corr-run-retry-stale',
        files: ['src/a.ts'],
      }),
    ).rejects.toMatchObject({ kind: 'run_id_mismatch' });

    expect(readSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it('wrong-project snapshot refs fail as SemanticError before any filesystem or parser read', async () => {
    const storedManifest = manifest('run-origin', 'proj-origin');
    const { deps, fs, snapshotRefId } = await makeAuditHarness(storedManifest);
    const readSpy = vi.spyOn(fs, 'read');
    const statSpy = vi.spyOn(fs, 'stat');

    await expect(
      auditDiff(deps, {
        snapshotRefId,
        projectId: 'proj-other',
        runId: 'run-origin',
        correlationId: 'corr-proj-other-run-origin',
        files: ['src/a.ts'],
      }),
    ).rejects.toMatchObject({ kind: 'project_id_mismatch' });

    expect(readSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it('stored manifest schema skew fails as SemanticError before any filesystem or parser read', async () => {
    const storedManifest = manifest('run-schema');
    const { deps, fs, snapshotRefId } = await makeAuditHarness(storedManifest, {
      manifestSchemaVersion: 2,
      gitRef: 'b'.repeat(40),
    });
    const readSpy = vi.spyOn(fs, 'read');

    await expect(
      auditDiff(deps, {
        snapshotRefId,
        projectId: 'proj-t109',
        runId: 'run-schema',
        correlationId: 'corr-run-schema',
        files: ['src/a.ts'],
      }),
    ).rejects.toMatchObject({ kind: 'manifest_version_mismatch' });

    expect(readSpy).not.toHaveBeenCalled();
  });
});
