import { describe, expect, it } from 'vitest';

import {
  IndexSemanticCorpusResultSchema,
  IndexSemanticCorpusRequestSchema,
  SemanticBranchAliasSchema,
  SemanticChunkIdentitySchema,
  SemanticProviderEnvelopeSchema,
  SemanticSourceCommitSnapshotSchema,
  SemanticSearchRequestSchema,
  SemanticSearchResultSchema,
  SemanticSearchStatusSchema,
  SemanticSidecarStatusSchema,
} from '../../src/hoplon/contracts/semanticSearch.js';
import {
  SemanticSearchRecoveryEnvelopeSchema,
  buildSemanticSearchRecoveryEnvelope,
} from '../../src/hoplon/contracts/semanticSearchRecovery.js';

describe('semantic search V2 contracts', () => {
  const commitA = 'a'.repeat(40);
  const commitB = 'b'.repeat(40);
  const sourceSnapshot = {
    sourceSnapshotId: 'source-snapshot-proj-a-a',
    projectId: 'proj-a',
    commitOid: commitA,
    corpusSchemaVersion: 'semantic-corpus-v2',
    embeddingProfileHash: 'embedding-profile-a',
  };

  it('uses provider statuses for raw semantic search and reserves NO_VERDICT for sidecars', () => {
    expect(SemanticSearchStatusSchema.options).toEqual([
      'AVAILABLE',
      'DEGRADED',
      'UNAVAILABLE',
      'EMPTY',
    ]);
    expect(SemanticSearchStatusSchema.safeParse('NO_VERDICT').success).toBe(false);
    expect(SemanticSidecarStatusSchema.safeParse('NO_VERDICT').success).toBe(true);
  });

  it('validates the shared provider envelope shape', () => {
    expect(() =>
      SemanticProviderEnvelopeSchema.parse({
        providerStatus: 'DEGRADED',
        resultCount: 0,
        freshness: 'stale',
        degradationReasons: ['index_context_mismatch'],
      }),
    ).not.toThrow();
  });

  it('validates source commit snapshots separately from Hoplon SnapshotRef values', () => {
    expect(SemanticSourceCommitSnapshotSchema.parse(sourceSnapshot)).toEqual(
      sourceSnapshot,
    );
    expect(
      SemanticSourceCommitSnapshotSchema.safeParse({
        sourceSnapshotId: 'not-a-hoplon-snapshot-ref',
        projectId: 'proj-a',
        commitOid: commitA,
        corpusSchemaVersion: 'semantic-corpus-v2',
      }).success,
    ).toBe(false);
  });

  it('models branch aliases that share one indexed commit snapshot', () => {
    const aliases = [
      {
        projectId: 'proj-a',
        sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
        branchName: 'main',
        branchKind: 'local_branch',
        commitOid: commitA,
        observedAtIso: '2026-05-08T00:00:00.000Z',
        isDefault: true,
        isCurrent: true,
        staleState: 'fresh',
      },
      {
        projectId: 'proj-a',
        sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
        branchName: 'hoplon-origin/main',
        branchKind: 'remote_tracking_branch',
        commitOid: commitA,
        observedAtIso: '2026-05-08T00:00:00.000Z',
        isDefault: false,
        isCurrent: false,
        staleState: 'fresh',
        remote: 'hoplon-origin',
      },
    ];

    expect(aliases.map((alias) => SemanticBranchAliasSchema.parse(alias))).toEqual(
      aliases,
    );
  });

  it('models same path variants with different content on different commits', () => {
    const first = SemanticChunkIdentitySchema.parse({
      projectId: 'proj-a',
      sourceSnapshotId: 'source-snapshot-a',
      chunkId: 'proj-a:a:src/shared.ts:0',
      canonicalPath: 'src/shared.ts',
      contentHash: 'content-a',
      chunkHash: 'chunk-a',
      chunkIndex: 0,
      lineRange: { startLine: 1, endLine: 8 },
      sourceProvenance: { commitOid: commitA, branchNames: ['main'] },
      embeddingCacheKey: 'emb:profile:content-a:chunk-a',
    });
    const second = SemanticChunkIdentitySchema.parse({
      ...first,
      sourceSnapshotId: 'source-snapshot-b',
      chunkId: 'proj-a:b:src/shared.ts:0',
      contentHash: 'content-b',
      chunkHash: 'chunk-b',
      sourceProvenance: { commitOid: commitB, branchNames: ['feature/search'] },
      embeddingCacheKey: 'emb:profile:content-b:chunk-b',
    });

    expect(first.canonicalPath).toBe(second.canonicalPath);
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(first.sourceProvenance.commitOid).not.toBe(
      second.sourceProvenance.commitOid,
    );
  });

  it('keeps legacy project-scoped documents valid and rejects cross-project source rows', () => {
    expect(
      IndexSemanticCorpusRequestSchema.safeParse({
        correlationId: 'corr-legacy-doc',
        projectId: 'proj-a',
        documents: [{ id: 'legacy', text: 'legacy project scoped row' }],
      }).success,
    ).toBe(true);

    const parsed = IndexSemanticCorpusRequestSchema.safeParse({
      correlationId: 'corr-cross-project-doc',
      projectId: 'proj-a',
      documents: [
        {
          id: 'bad',
          text: 'cross project source row',
          sourceSnapshot: { ...sourceSnapshot, projectId: 'proj-b' },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('requires providerStatus, resultCount, freshness, and degradationReasons on results', () => {
    expect(() =>
      IndexSemanticCorpusResultSchema.parse({
        correlationId: 'corr-contract-index',
        projectId: 'proj',
        status: 'UNAVAILABLE',
        providerStatus: 'UNAVAILABLE',
        providerAvailable: false,
        resultCount: 0,
        freshness: 'unavailable',
        degradationReasons: ['provider_not_bound'],
        indexedCount: 0,
        requestedCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      SemanticSearchResultSchema.parse({
        correlationId: 'corr-contract-search',
        projectId: 'proj',
        advisory: true,
        status: 'EMPTY',
        providerStatus: 'EMPTY',
        providerAvailable: true,
        resultCount: 0,
        freshness: 'indexed',
        degradationReasons: [],
        topK: 5,
        matches: [],
      }),
    ).not.toThrow();
  });

  it('accepts unified semanticSearch branch, stale, payload, and suggestion fields', () => {
    const parsed = SemanticSearchRequestSchema.parse({
      correlationId: 'corr-contract-search-request',
      projectId: 'proj',
      query: 'find semantic branch variants',
      topK: 5,
      branchScope: { mode: 'branches', refs: ['main', 'origin/main'] },
      stalePolicy: 'include_with_warning',
      resultFields: 'path_and_symbol',
      suggestionMode: 'deterministic_then_semantic',
    });

    expect(parsed.branchScope?.mode).toBe('branches');
    expect(parsed.stalePolicy).toBe('include_with_warning');
    expect(parsed.resultFields).toBe('path_and_symbol');
    expect(parsed.suggestionMode).toBe('deterministic_then_semantic');
  });

  it('builds typed recovery diagnostics for invalid semanticSearch requests', () => {
    const parsed = SemanticSearchRequestSchema.safeParse({
      correlationId: 'corr-contract-search-recovery',
      projectId: 'proj',
      topK: 5,
      qurey: 'typo',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected invalid request');

    const recovery = buildSemanticSearchRecoveryEnvelope(parsed.error);
    expect(() => SemanticSearchRecoveryEnvelopeSchema.parse(recovery)).not.toThrow();
    expect(recovery.advisory).toBe(true);
    expect(recovery.minimalValidRequest).toMatchObject({
      correlationId: 'corr-semantic-search',
      projectId: 'project-id',
      query: 'semantic search query',
      topK: 5,
    });
    expect(recovery.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: 'query',
          message: "Missing required semanticSearch field 'query'",
        }),
        expect.objectContaining({
          fieldPath: 'qurey',
          didYouMean: 'query',
        }),
      ]),
    );
  });
});
