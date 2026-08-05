import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNodeFsAdapter } from '../../src/hoplon/adapters/fs/node.js';
import { createSqliteSnapshotStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAMMARS_DIR = path.join(REPO_ROOT, 'vendor/grammars');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('hcr-010 default-runtime crash reconciliation', () => {
  it('completes only durable pending rows whose Phase-B commit exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-hcr010-reconcile-'));
    roots.push(root);
    const dbPath = path.join(root, '.hoplon', 'hoplon.db');
    const gitRepoDir = '.hoplon/repo';
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const nodeFs = createNodeFsAdapter({ root });
    const versioning = createIsomorphicGitVersioning({ fs: nodeFs });
    const orphanId = '8'.repeat(64);
    await versioning.init(gitRepoDir);
    await nodeFs.write(
      '.hoplon/repo/src/recovered.ts',
      new TextEncoder().encode('export const recovered = true;\n'),
    );
    await versioning.add(gitRepoDir, ['src/recovered.ts']);
    const { sha } = await versioning.commit(
      gitRepoDir,
      `hoplon-snapshot ${orphanId}`,
      { committer: { timestamp: 0 } },
    );

    const seedStore = await createSqliteSnapshotStore({ dbPath });
    await seedStore.put({
      id: orphanId,
      manifestSchemaVersion: 1,
      engineId: 'default-runtime',
      projectId: 'proj-recovery',
      runId: 'run-recovery',
      correlationId: 'corr-recovery',
      status: 'pending',
      statusReason: null,
      gitRef: sha,
      manifest: null,
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      ttlExpires: null,
      replicaIds: [],
      presencePaths: null,
    });
    const invalidOrphanId = '7'.repeat(64);
    await seedStore.put({
      id: invalidOrphanId,
      manifestSchemaVersion: 1,
      engineId: 'default-runtime',
      projectId: 'proj-recovery',
      runId: 'run-recovery',
      correlationId: 'corr-invalid',
      status: 'pending',
      statusReason: null,
      gitRef: 'f'.repeat(40),
      manifest: null,
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      ttlExpires: null,
      replicaIds: [],
      presencePaths: null,
    });

    const engine = await createDefaultHoplonEngine({
      root,
      dbPath,
      gitRepoDir,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'default-runtime',
    });

    const verifyStore = await createSqliteSnapshotStore({ dbPath });
    expect(await verifyStore.get(orphanId)).toMatchObject({
      status: 'committed',
      statusReason: null,
      gitRef: sha,
    });
    expect(await verifyStore.get(invalidOrphanId)).toMatchObject({
      status: 'failed',
      statusReason: 'pending row older than threshold on startup reconcile',
      gitRef: null,
    });
    await expect(engine.reconcile()).resolves.toMatchObject({
      reconciled: 0,
      failed: 0,
      orphans: { pendingRows: 0 },
    });
  });
});
