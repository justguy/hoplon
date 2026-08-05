import { describe, expect, it } from 'vitest';

import {
  createInMemoryPortableSemanticIndexStorage,
  createPortableSemanticIndex,
} from '../src/index.js';
import type {
  PortableSemanticIndexSnapshot,
  PortableSemanticIndexStorage,
} from '../src/index.js';

describe('portable semantic index package', () => {
  it('surfaces the lexical-only degraded runtime and storage profile', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });

    const description = await index.describe();
    const profile = await index.storageProfile.describe();

    expect(description.runtimeProfile).toBe('lexical_only_degraded');
    expect(description.persistenceMode).toBe('host_snapshot_storage');
    expect(description.lexicalAvailable).toBe(true);
    expect(description.vectorAvailable).toBe(false);
    expect(description.nativeRuntime).toBe(false);
    expect(description.scaleLimits).toEqual({
      maxRecommendedDocuments: 50_000,
      maxRecommendedTokensPerDocument: 20_000,
    });
    expect(profile).toEqual({
      kind: 'lexical_only_degraded',
      status: 'DEGRADED',
      durableLexical: true,
      durableVector: false,
      nativeRuntime: false,
      degradationReasons: ['lexical_only_degraded_vector_runtime_not_bound'],
    });
  });

  it('persists lexical documents across adapter restarts through host storage', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const first = createPortableSemanticIndex({ storage });

    await expect(
      first.lexicalIndex.upsert('project-a', [
        {
          id: 'doc-2',
          text: 'semantic search cache freshness tombstone handling',
          metadata: { path: 'docs/cache.md', ordinal: 2 },
        },
        {
          id: 'doc-1',
          text: 'portable lexical index profile degradation',
          metadata: { path: 'docs/profile.md', ordinal: 1 },
        },
      ]),
    ).resolves.toMatchObject({
      status: 'AVAILABLE',
      resultCount: 2,
      degradationReasons: [],
    });

    const restarted = createPortableSemanticIndex({ storage });
    const result = await restarted.lexicalIndex.search(
      'project-a',
      'portable degraded lexical profile',
      5,
    );

    expect(result.status).toBe('AVAILABLE');
    expect(result.degradationReasons).toEqual([]);
    expect(result.matches.map((match) => match.id)).toEqual(['doc-1']);
    expect(result.matches[0]?.metadata).toEqual({
      path: 'docs/profile.md',
      ordinal: 1,
    });
  });

  it('persists commit-scoped chunk contracts without breaking project scoping', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });
    const commitOid = 'd'.repeat(40);

    await index.lexicalIndex.upsert('project-a', [
      {
        id: 'src/shared.ts#0',
        text: 'branch scoped semantic content',
        metadata: { path: 'src/shared.ts' },
        sourceSnapshot: {
          sourceSnapshotId: 'source-snapshot-a',
          projectId: 'project-a',
          commitOid,
          corpusSchemaVersion: 'semantic-corpus-v2',
          embeddingProfileHash: 'embedding-profile',
        },
        branchAliases: [
          {
            projectId: 'project-a',
            sourceSnapshotId: 'source-snapshot-a',
            branchName: 'main',
            branchKind: 'local_branch',
            commitOid,
            observedAtIso: '2026-05-08T00:00:00.000Z',
            isDefault: true,
            isCurrent: true,
            staleState: 'fresh',
          },
        ],
        chunkIdentity: {
          projectId: 'project-a',
          sourceSnapshotId: 'source-snapshot-a',
          chunkId: 'src/shared.ts#0',
          canonicalPath: 'src/shared.ts',
          contentHash: 'content-a',
          chunkHash: 'chunk-a',
          chunkIndex: 0,
          sourceProvenance: { commitOid, branchNames: ['main'] },
          embeddingCacheKey: 'emb:profile:content-a:chunk-a',
        },
      },
    ]);

    const snapshot = await storage.load();
    const stored = snapshot?.projects['project-a']?.['src/shared.ts#0'];
    expect(stored?.sourceSnapshot?.sourceSnapshotId).toBe('source-snapshot-a');
    expect(stored?.branchAliases?.map((alias) => alias.branchName)).toEqual([
      'main',
    ]);
    expect(stored?.chunkIdentity?.canonicalPath).toBe('src/shared.ts');
    expect(snapshot?.projects['project-b']).toBeUndefined();
  });

  it('keeps vector operations unavailable under lexical-only degradation', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });

    await expect(
      index.vectorIndex.upsert('project-a', [
        { id: 'record-1', vector: [0.1, 0.2], metadata: { path: 'a.ts' } },
      ]),
    ).resolves.toEqual({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
      degradationReasons: ['lexical_only_degraded_vector_runtime_not_bound'],
    });

    await expect(index.vectorIndex.search('project-a', [0.1, 0.2], 3)).resolves.toEqual({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
      degradationReasons: ['lexical_only_degraded_vector_runtime_not_bound'],
    });
  });

  it('persists deletions through the same storage boundary', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });

    await index.lexicalIndex.upsert('project-a', [
      {
        id: 'doc-1',
        text: 'delete me from lexical storage',
        metadata: { path: 'delete.md' },
      },
    ]);
    await expect(index.lexicalIndex.delete('project-a', ['doc-1'])).resolves.toMatchObject({
      status: 'AVAILABLE',
      resultCount: 1,
    });

    const restarted = createPortableSemanticIndex({ storage });
    await expect(
      restarted.lexicalIndex.search('project-a', 'delete lexical', 5),
    ).resolves.toMatchObject({
      status: 'EMPTY',
      resultCount: 0,
      matches: [],
    });
  });

  it('persists tombstones and lets recreated rows clear suppressive state', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });

    await index.lexicalIndex.upsert('project-a', [
      {
        id: 'doc-1',
        text: 'policy banned lexical document',
        metadata: { path: 'policy.md' },
      },
    ]);
    await index.lexicalIndex.delete('project-a', ['doc-1'], {
      tombstoneKind: 'policy_banned',
    });

    await expect(index.lexicalIndex.search('project-a', 'policy banned', 5))
      .resolves.toMatchObject({ status: 'EMPTY', matches: [] });

    const restarted = createPortableSemanticIndex({ storage });
    await restarted.lexicalIndex.upsert('project-a', [
      {
        id: 'doc-1',
        text: 'policy banned lexical document returns',
        metadata: { path: 'policy.md' },
      },
    ]);

    await expect(restarted.lexicalIndex.search('project-a', 'returns', 5))
      .resolves.toMatchObject({
        status: 'AVAILABLE',
        resultCount: 1,
        matches: [{ id: 'doc-1', metadata: { path: 'policy.md' } }],
      });
  });

  it('runs caller-driven tombstone GC with counts only', async () => {
    const storage = createInMemoryPortableSemanticIndexStorage();
    const index = createPortableSemanticIndex({ storage });

    await index.lexicalIndex.delete('project-a', ['missing-a', 'missing-b']);
    await expect(
      index.maintenance.gc({ semanticTombstones: true }),
    ).resolves.toEqual({
      status: 'AVAILABLE',
      cacheEntriesDeleted: 0,
      overlaysReaped: 0,
      tombstonesDeleted: 2,
      degradationReasons: [],
    });

    const snapshot = await storage.load();
    expect(snapshot?.tombstones).toEqual({});
  });

  it('reports lexical storage failures without pretending vector search exists', async () => {
    const failingStorage: PortableSemanticIndexStorage = {
      async load(): Promise<PortableSemanticIndexSnapshot | null> {
        throw new Error('storage offline');
      },
      async save(): Promise<void> {
        throw new Error('storage offline');
      },
    };
    const index = createPortableSemanticIndex({ storage: failingStorage });

    await expect(index.lexicalIndex.search('project-a', 'anything', 5)).resolves.toEqual({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
      degradationReasons: ['portable_semantic_index_storage_error'],
    });

    await expect(index.vectorIndex.delete('project-a', ['record-1'])).resolves.toEqual({
      status: 'UNAVAILABLE',
      resultCount: 0,
      matches: [],
      degradationReasons: ['lexical_only_degraded_vector_runtime_not_bound'],
    });
  });
});
