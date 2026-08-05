import { describe, expect, it } from 'vitest';

import {
  createMemoryEmitter,
  createNoopEmbeddingCache,
  createNoopSemanticDocumentBuilder,
  createNoopSemanticStorageProfile,
  createNoopVectorStore,
} from '../../src/hoplon/adapters/index.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type {
  SemanticIndexDocument,
  SemanticIndexStoreAdapter,
} from '../../src/hoplon/adapters/semanticIndexStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import type { SemanticBranchAlias } from '../../src/hoplon/contracts/semanticSearch.js';
import { indexSemanticRefs } from '../../src/hoplon/operations/semanticRefIndexing.js';
import type { SemanticSearchDeps } from '../../src/hoplon/operations/semanticSearchShared.js';

const CORR = 'corr-sem-search-018';
const PROFILE = 'profile-alpha';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

describe('semantic ref indexing (sem-search-018)', () => {
  it('indexes all local branches without checkout and shares aliases for one commit', async () => {
    const h = makeHarness({
      local: [
        branch('main', COMMIT_A),
        branch('feature', COMMIT_A),
      ],
      files: { [COMMIT_A]: { 'src/a.ts': 'export const a = 1;\n' } },
    });
    const result = await indexSemanticRefs(h.deps, request('all_local_branches'));

    expect(result.status).toBe('AVAILABLE');
    expect(result.resolvedBranchCount).toBe(2);
    expect(result.indexedCommitCount).toBe(1);
    expect(h.calls.checkout).toBe(0);
    expect(h.calls.readBlobs).toEqual([{ ref: COMMIT_A, filepath: 'src/a.ts' }]);
    const doc = h.calls.semanticWrites[0]?.[0];
    expect(doc?.branchAliases?.map((alias) => alias.branchName).sort()).toEqual([
      'feature',
      'main',
    ]);
  });

  it('supports explicit branch refs and pattern scopes', async () => {
    const h = makeHarness({
      local: [branch('main', COMMIT_A), branch('feature/x', COMMIT_B)],
      remote: [branch('origin/feature/y', COMMIT_B, 'origin')],
      files: { [COMMIT_B]: { 'src/b.ts': 'export const b = 2;\n' } },
    });
    const explicit = await indexSemanticRefs(
      h.deps,
      request('branches', { refs: ['refs/heads/feature/x'] }),
    );
    const patterned = await indexSemanticRefs(
      h.deps,
      request('patterns', { patterns: ['origin/feature/*'], force: true }),
    );

    expect(explicit.resolvedBranchCount).toBe(1);
    expect(patterned.resolvedBranchCount).toBe(1);
    expect(h.calls.listFiles).toEqual([COMMIT_B, COMMIT_B]);
  });

  it('refreshes existing commit aliases without re-reading or embedding', async () => {
    const existing = existingDoc(COMMIT_A, [alias('main', COMMIT_A)]);
    const h = makeHarness({
      local: [branch('feature', COMMIT_A)],
      files: { [COMMIT_A]: { 'src/a.ts': 'changed text\n' } },
      existing: [existing],
    });
    const result = await indexSemanticRefs(h.deps, request('all_local_branches'));

    expect(result.aliasOnlyCommitCount).toBe(1);
    expect(result.indexedCommitCount).toBe(0);
    expect(h.calls.readBlobs).toEqual([]);
    expect(h.calls.embeddings).toEqual([]);
    expect(h.calls.semanticWrites[0]?.[0]?.branchAliases?.map((a) => a.branchName).sort())
      .toEqual(['feature', 'main']);
  });

  it('refreshes stale aliases from all indexed branch aliases', async () => {
    const h = makeHarness({
      local: [branch('main', COMMIT_B)],
      files: { [COMMIT_B]: { 'src/b.ts': 'new head\n' } },
      existing: [existingDoc(COMMIT_A, [alias('main', COMMIT_A)])],
    });
    const result = await indexSemanticRefs(h.deps, request('all_indexed'));

    expect(result.resolvedBranchCount).toBe(1);
    expect(result.indexedCommitCount).toBe(1);
    const staleWrite = h.calls.semanticWrites[0]?.find((doc) => doc.id.includes(COMMIT_A));
    expect(staleWrite?.branchAliases?.[0]?.staleState).toBe('stale');
    const freshWrite = h.calls.semanticWrites[1]?.find((doc) => doc.id.includes(COMMIT_B));
    expect(freshWrite?.branchAliases?.[0]?.staleState).toBe('fresh');
  });

  it('hard-excludes generated semantic sidecars', async () => {
    const h = makeHarness({
      local: [branch('main', COMMIT_A)],
      files: {
        [COMMIT_A]: {
          '.hoplon/semantic-index.sqlite': 'sqlite bytes',
          'src/a.ts': 'export const a = 1;\n',
        },
      },
    });
    const result = await indexSemanticRefs(h.deps, request('all_local_branches'));

    expect(result.excludedCount).toBe(1);
    expect(h.calls.readBlobs).toEqual([{ ref: COMMIT_A, filepath: 'src/a.ts' }]);
  });

  it('propagates abort before blob reads', async () => {
    const h = makeHarness({
      local: [branch('main', COMMIT_A)],
      files: { [COMMIT_A]: { 'src/a.ts': 'export const a = 1;\n' } },
    });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(
      indexSemanticRefs(h.deps, request('all_local_branches'), controller.signal),
    ).rejects.toThrow('stop');
    expect(h.calls.readBlobs).toEqual([]);
  });

  it('degrades when semantic runtime adapters are unavailable', async () => {
    const h = makeHarness({
      local: [branch('main', COMMIT_A)],
      files: { [COMMIT_A]: { 'src/a.ts': 'export const a = 1;\n' } },
      providers: false,
    });
    const result = await indexSemanticRefs(h.deps, request('all_local_branches'));

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.degradationReasons).toContain('provider_not_bound');
  });
});

function request(
  mode: 'all_local_branches' | 'branches' | 'patterns' | 'all_indexed',
  extra: { refs?: string[]; patterns?: string[]; force?: boolean } = {},
) {
  return {
    projectId: 'project-alpha',
    correlationId: CORR,
    fsRootIdentityHash: 'fs-root-alpha',
    branchScope: { mode, ...(extra.refs ? { refs: extra.refs } : {}), ...(extra.patterns ? { patterns: extra.patterns } : {}) },
    corpusSchemaVersion: 'sem-v1',
    embeddingProfileHash: PROFILE,
    embeddingProfileVerified: true,
    ...(extra.force === undefined ? {} : { force: extra.force }),
  };
}

function makeHarness(args: {
  local?: ReturnType<typeof branch>[];
  remote?: ReturnType<typeof branch>[];
  files?: Record<string, Record<string, string>>;
  existing?: SemanticIndexDocument[];
  providers?: boolean;
}) {
  const calls = {
    checkout: 0,
    listFiles: [] as string[],
    readBlobs: [] as Array<{ ref: string; filepath: string }>,
    embeddings: [] as string[],
    semanticWrites: [] as SemanticIndexDocument[][],
  };
  const emitter = createMemoryEmitter();
  const semanticIndexStore = createStore(args.existing ?? [], calls);
  const providers = args.providers ?? true;
  const semantic: SemanticSearchDeps = {
    embedding: { async embed(text) { calls.embeddings.push(text); return [text.length]; } },
    vectorStore: createNoopVectorStore(),
    embeddingCache: createNoopEmbeddingCache(),
    semanticIndexStore,
    lexicalIndex: createLexicalIndex(),
    vectorIndex: createVectorIndex(),
    semanticDocumentBuilder: createNoopSemanticDocumentBuilder(),
    semanticStorageProfile: createNoopSemanticStorageProfile(),
    emitter,
    engineId: 'test-engine',
    embeddingProvided: providers,
    vectorStoreProvided: false,
    embeddingCacheProvided: false,
    semanticIndexStoreProvided: providers,
    lexicalIndexProvided: providers,
    vectorIndexProvided: providers,
  };
  return {
    deps: {
      fs: createMemFsAdapter(),
      versioning: createVersioning(args, calls),
      emitter,
      engineId: 'test-engine',
      root: '/',
      semantic,
    },
    calls,
  };
}

function branch(name: string, oid: string, remote?: string) {
  return {
    kind: remote ? 'remote_tracking_branch' as const : 'local_branch' as const,
    name,
    fullRef: remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
    oid,
    ...(remote === undefined ? {} : { remote }),
  };
}

function createVersioning(
  args: Parameters<typeof makeHarness>[0],
  calls: ReturnType<typeof makeHarness>['calls'],
): VersioningAdapter {
  const local = args.local ?? [];
  const remote = args.remote ?? [];
  const inventory = [...local, ...remote];
  return {
    async init() {}, async add() {}, async remove() {}, async clearIndex() {},
    async commit() { return { sha: COMMIT_A }; },
    async checkout() { calls.checkout += 1; },
    async statusMatrix() { return []; },
    async resolveRef(_dir, ref) {
      const found = inventory.find((row) => row.name === ref || row.fullRef === ref);
      if (found === undefined) throw gitReadFailed(ref);
      return found.oid;
    },
    async listLocalBranches() { return local; },
    async listRemoteTrackingBranches() { return remote; },
    async resolveCurrentBranch() {
      const current = local[0];
      return current === undefined ? null : { name: current.name, fullRef: current.fullRef, oid: current.oid };
    },
    async resolveDefaultBranch() {
      const main = local.find((row) => row.name === 'main') ?? local[0];
      return main === undefined ? null : { name: main.name, fullRef: main.fullRef, oid: main.oid };
    },
    async push() {}, async fetch() {}, async readBlob() { return new Uint8Array(); },
    async listFilesAtRef(_dir, ref) {
      calls.listFiles.push(ref);
      return Object.keys(args.files?.[ref] ?? {}).sort().map((filepath) => ({ filepath, oid: `blob:${filepath}` }));
    },
    async readBlobAtRef(_dir, ref, filepath) {
      calls.readBlobs.push({ ref, filepath });
      const text = args.files?.[ref]?.[filepath];
      if (text === undefined) throw gitReadFailed(filepath);
      return { oid: `blob:${filepath}`, bytes: new TextEncoder().encode(text) };
    },
    async diffSnapshotFiles() { return []; }, async changedFilesBetweenRefs() { return []; },
    async readCommitInfo() { return { oid: COMMIT_A, parentOids: [], treeOid: 'tree', committerTimestamp: 0, authorTimestamp: 0, messageFirstLine: 'stub' }; },
    async readLineProvenance() { return { commitId: COMMIT_A, parentOids: [], authorName: 'stub', authorTimestamp: 0, committerTimestamp: 0, messageFirstLine: 'stub', lineRange: { startLine: 1, endLine: 1 }, provenanceKind: 'line_changed' as const }; },
  };
}

function createStore(docs: SemanticIndexDocument[], calls: { semanticWrites: SemanticIndexDocument[][] }): SemanticIndexStoreAdapter {
  return {
    async read() { return { status: 'AVAILABLE', documents: docs, freshness: 'indexed', degradationReasons: [] }; },
    async write(_projectId, documents) { calls.semanticWrites.push([...documents]); docs = [...documents]; return { status: 'AVAILABLE', writtenCount: documents.length, freshness: 'indexed', degradationReasons: [] }; },
    async delete() { return { status: 'AVAILABLE', writtenCount: 0, freshness: 'indexed', degradationReasons: [] }; },
  };
}

function createLexicalIndex() {
  return { async upsert() { return { status: 'AVAILABLE' as const, resultCount: 1, matches: [], degradationReasons: [] }; }, async search() { return { status: 'EMPTY' as const, resultCount: 0, matches: [], degradationReasons: [] }; }, async delete() { return { status: 'AVAILABLE' as const, resultCount: 0, matches: [], degradationReasons: [] }; } };
}

function createVectorIndex() {
  return { async upsert() { return { status: 'AVAILABLE' as const, resultCount: 1, matches: [], degradationReasons: [] }; }, async search() { return { status: 'EMPTY' as const, resultCount: 0, matches: [], degradationReasons: [] }; }, async delete() { return { status: 'AVAILABLE' as const, resultCount: 0, matches: [], degradationReasons: [] }; } };
}

function existingDoc(commitOid: string, branchAliases: SemanticBranchAlias[]): SemanticIndexDocument {
  return { id: `source/${commitOid}/src/a.ts`, text: 'old text', metadata: {}, contentHash: 'sha256:old', sourceSnapshot: { sourceSnapshotId: `source:project-alpha:${commitOid}:sem-v1:${PROFILE}`, projectId: 'project-alpha', commitOid, corpusSchemaVersion: 'sem-v1', embeddingProfileHash: PROFILE }, branchAliases };
}

function alias(branchName: string, commitOid: string): SemanticBranchAlias {
  return { projectId: 'project-alpha', sourceSnapshotId: `source:project-alpha:${commitOid}:sem-v1:${PROFILE}`, branchName, branchKind: 'local_branch', commitOid, observedAtIso: '1970-01-01T00:00:00.000Z', isDefault: branchName === 'main', isCurrent: branchName === 'main', staleState: 'fresh' };
}

function gitReadFailed(ref: string): AdapterError {
  return new AdapterError({ kind: 'git_read_failed', engineId: 'test', correlationId: CORR, cause: { ref } }, 'git read failed');
}
