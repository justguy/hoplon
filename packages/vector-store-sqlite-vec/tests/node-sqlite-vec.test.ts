import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { getLoadablePath } from 'sqlite-vec';

import { createNodeSqliteVecSemanticIndex } from '../src/index.js';
import type { NodeSqliteVecSemanticIndex } from '../src/index.js';

describe('node:sqlite sqlite-vec semantic index package', () => {
  it('loads sqlite-vec, reports native runtime fields, and persists vec0 data', async () => {
    const databasePath = tempDatabasePath('success');
    await removeDatabase(databasePath);
    const extensionPath = getLoadablePath();
    const extensionSha256 = await sha256(extensionPath);

    const first = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 3,
      expectedExtensionSha256: extensionSha256,
    });

    const description = await first.describe();
    expect(description).toMatchObject({
      runtimeProfile: 'native_performance',
      status: 'AVAILABLE',
      snapshotSqlRuntime: 'not_owned_by_plugin',
      semanticSqlRuntime: 'node:sqlite',
      semanticVectorRuntime: 'sqlite-vec-native',
      lexicalAvailable: true,
      vectorAvailable: true,
      nativeRuntime: true,
      nativeExtensionLoaded: true,
      nativeExtensionBinaryHash: extensionSha256,
      nativeExtensionPath: extensionPath,
      sqliteVecVersion: 'v0.1.9',
      fts5Available: true,
      walMode: 'wal',
      busyTimeoutMs: 5000,
      vectorSchemaAvailable: true,
      sqlLevelExtensionLoadBlocked: true,
      degradationReasons: [],
    });

    await expect(
      first.lexicalIndex.upsert('project-a', [
        {
          id: 'doc-1',
          text: 'node sqlite vec native semantic search',
          metadata: { path: 'src/native.ts' },
        },
      ]),
    ).resolves.toMatchObject({ status: 'AVAILABLE', resultCount: 1 });
    await expect(first.lexicalIndex.search('project-a', 'native semantic', 5))
      .resolves.toMatchObject({
        status: 'AVAILABLE',
        matches: [{ id: 'doc-1', metadata: { path: 'src/native.ts' } }],
      });

    await insertVectors(first);
    await first.close();

    const reopened = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 3,
      expectedExtensionSha256: extensionSha256,
    });
    await expect(reopened.vectorIndex.search('project-a', [0.1, 0.25, 0.35], 2))
      .resolves.toMatchObject({
        status: 'AVAILABLE',
        resultCount: 2,
        matches: [
          { id: 'doc-1', metadata: { path: 'src/one.ts' } },
          { id: 'doc-3', metadata: { path: 'src/three.ts' } },
        ],
      });
    await reopened.close();
  });

  it('degrades to lexical-only when sqlite-vec cannot load', async () => {
    const databasePath = tempDatabasePath('missing-extension');
    await removeDatabase(databasePath);
    const index = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 3,
      extensionPath: join(tmpdir(), 'missing-vec0.dylib'),
    });

    await expect(index.describe()).resolves.toMatchObject({
      status: 'DEGRADED',
      semanticSqlRuntime: 'node:sqlite',
      semanticVectorRuntime: 'lexical-only',
      lexicalAvailable: true,
      vectorAvailable: false,
      nativeExtensionLoaded: false,
      fts5Available: true,
      degradationReasons: ['vector_extension_unavailable'],
    });
    await expect(
      index.lexicalIndex.upsert('project-a', [
        { id: 'doc-1', text: 'lexical fallback survives', metadata: { path: 'a.ts' } },
      ]),
    ).resolves.toMatchObject({ status: 'AVAILABLE' });
    await expect(index.vectorIndex.upsert('project-a', []))
      .resolves.toMatchObject({
        status: 'UNAVAILABLE',
        degradationReasons: ['vector_extension_unavailable'],
      });
    await index.close();
  });

  it('blocks sqlite-vec load when the binary hash does not match', async () => {
    const databasePath = tempDatabasePath('hash-mismatch');
    await removeDatabase(databasePath);
    const extensionPath = getLoadablePath();
    const observedHash = await sha256(extensionPath);
    const index = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 3,
      extensionPath,
      expectedExtensionSha256: '0'.repeat(64),
    });

    await expect(index.describe()).resolves.toMatchObject({
      status: 'DEGRADED',
      nativeExtensionLoaded: false,
      nativeExtensionBinaryHash: observedHash,
      nativeExtensionPath: extensionPath,
      vectorAvailable: false,
      degradationReasons: ['native_extension_hash_mismatch'],
    });
    await expect(index.vectorIndex.search('project-a', [0.1, 0.2, 0.3], 1))
      .resolves.toMatchObject({
        status: 'UNAVAILABLE',
        degradationReasons: ['vector_extension_unavailable'],
      });
    await index.close();
  });

  it('reports strict no-native hosts without fabricating lexical availability', async () => {
    const index = await createNodeSqliteVecSemanticIndex({
      databasePath: ':memory:',
      vectorDimension: 3,
      loadNodeSqlite: async () => {
        throw new Error('node:sqlite unavailable');
      },
    });

    await expect(index.describe()).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      semanticSqlRuntime: 'unavailable',
      lexicalAvailable: false,
      vectorAvailable: false,
      nativeRuntime: false,
      degradationReasons: ['node_sqlite_runtime_unavailable'],
    });
    await expect(index.lexicalIndex.search('project-a', 'anything', 1))
      .resolves.toMatchObject({
        status: 'UNAVAILABLE',
        degradationReasons: ['node_sqlite_runtime_unavailable'],
      });
  });
});

async function insertVectors(index: NodeSqliteVecSemanticIndex): Promise<void> {
  await expect(
    index.vectorIndex.upsert('project-a', [
      { id: 'doc-1', vector: [0.1, 0.2, 0.3], metadata: { path: 'src/one.ts' } },
      { id: 'doc-2', vector: [0.9, 0.1, 0.1], metadata: { path: 'src/two.ts' } },
      { id: 'doc-3', vector: [0.2, 0.8, 0.2], metadata: { path: 'src/three.ts' } },
    ]),
  ).resolves.toMatchObject({ status: 'AVAILABLE', resultCount: 3 });
}

function tempDatabasePath(name: string): string {
  return join(tmpdir(), `hoplon-node-sqlite-vec-${name}-${process.pid}.sqlite`);
}

async function removeDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
