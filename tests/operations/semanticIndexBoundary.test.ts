import { describe, expect, it } from 'vitest';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { AdapterError, ValidationError } from '../../src/hoplon/contracts/errors.js';
import {
  buildSemanticIndexBoundaryDocuments,
  type SemanticIndexBoundaryDeps,
} from '../../src/hoplon/operations/semanticIndexBoundary.js';

const CORRELATION_ID = 'corr-sem-search-002';

describe('semantic index boundary proofs (sem-search-002)', () => {
  it('persists canonical project-relative path identity without fsRootRealpath', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export const a = 1;\n'));

    const result = await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
      fsRootRealpath: '/private/real/project-alpha',
      candidateFiles: ['./src/a.ts'],
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.identity).toEqual({
      canonicalProjectRelativePath: 'src/a.ts',
      fsRootIdentityHash: 'fs-root-hash-alpha',
    });
    expect(JSON.stringify(result)).not.toContain('/private/real/project-alpha');
  });

  it('routes byte reads through HoplonFsAdapter and head/dirty state through VersioningAdapter', async () => {
    const { deps, fs, calls } = makeDeps({
      matrix: [['src/a.ts', 1, 2, 2]],
      headOid: 'abc123',
    });
    await fs.write('src/a.ts', enc('export const a = 1;\n'));

    const result = await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
      candidateFiles: ['src/a.ts'],
    });

    expect(calls.fsReads).toEqual(['src/a.ts']);
    expect(calls.resolveRefs).toEqual([{ dir: '/', ref: 'HEAD' }]);
    expect(calls.statusMatrixDirs).toEqual(['/']);
    expect(result.headOid).toBe('abc123');
    expect(result.documents[0]?.worktreeState).toBe('dirty');
  });

  it('rejects traversal candidates before byte reads', async () => {
    const { deps, calls } = makeDeps();

    await expect(
      buildSemanticIndexBoundaryDocuments(deps, {
        projectId: 'project-alpha',
        correlationId: CORRELATION_ID,
        fsRootIdentityHash: 'fs-root-hash-alpha',
        candidateFiles: ['../secret.ts'],
      }),
    ).rejects.toMatchObject({ kind: 'path_traversal' });
    expect(calls.fsReads).toEqual([]);
  });

  it('degrades unsupported symlink escapes before byte reads', async () => {
    const { deps, calls } = makeDeps({
      statFailurePath: 'linked-secret.ts',
    });

    const result = await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
      candidateFiles: ['linked-secret.ts'],
    });

    expect(result.status).toBe('EMPTY');
    expect(result.degradationReasons).toEqual(['unsupported_symlink']);
    expect(calls.fsReads).toEqual([]);
  });

  it('hard-excludes generated semantic storage even when candidate input includes it', async () => {
    const { deps, fs, calls } = makeDeps();
    await fs.write('.hoplon/semantic-index.sqlite', enc('sqlite bytes'));
    await fs.write('.hoplon/semantic-index.sqlite-wal', enc('wal bytes'));
    await fs.write('.hoplon/semantic-index.sqlite-shm', enc('shm bytes'));
    await fs.write('src/a.ts', enc('export const a = 1;\n'));

    const result = await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
      candidateFiles: [
        '.hoplon/semantic-index.sqlite',
        '.hoplon/semantic-index.sqlite-wal',
        '.hoplon/semantic-index.sqlite-shm',
        'src/a.ts',
      ],
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.excludedCount).toBe(3);
    expect(result.degradationReasons).toEqual(['semantic_sidecar_excluded']);
    expect(calls.fsReads).toEqual(['src/a.ts']);
  });

  it('uses the shared ignore collector for traversal and hard .hoplon exclusion', async () => {
    const { deps, fs, calls } = makeDeps();
    await fs.write('.gitignore', enc('ignored/\n!important.ts\n'));
    await fs.write('src/a.ts', enc('export const a = 1;\n'));
    await fs.write('ignored/b.ts', enc('export const b = 2;\n'));
    await fs.write('important.ts', enc('export const important = true;\n'));
    await fs.write('.hoplon/semantic-index.sqlite', enc('sqlite bytes'));

    const result = await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
    });

    expect(result.documents.map((d) => d.identity.canonicalProjectRelativePath).sort())
      .toEqual(['important.ts', 'src/a.ts']);
    expect(calls.fsReads).toEqual(['.gitignore', 'important.ts', 'src/a.ts']);
  });

  it('emits only H13-safe progress events', async () => {
    const { deps, fs, emitter } = makeDeps();
    await fs.write('src/a.ts', enc('export const secretSnippet = "no leak";\n'));

    await buildSemanticIndexBoundaryDocuments(deps, {
      projectId: 'project-alpha',
      runId: 'run-alpha',
      correlationId: CORRELATION_ID,
      fsRootIdentityHash: 'fs-root-hash-alpha',
      fsRootRealpath: '/private/real/project-alpha',
      candidateFiles: ['src/a.ts'],
    });

    for (const event of emitter.getEvents()) {
      assertEventIsContentFree(event);
      expect(JSON.stringify(event)).not.toContain('src/a.ts');
      expect(JSON.stringify(event)).not.toContain('secretSnippet');
      expect(JSON.stringify(event)).not.toContain('fs-root-hash-alpha');
      expect(JSON.stringify(event)).not.toContain('/private/real/project-alpha');
    }
  });
});

function makeDeps(options: {
  readonly matrix?: Array<[path: string, head: number, workdir: number, stage: number]>;
  readonly headOid?: string;
  readonly statFailurePath?: string;
} = {}): {
  readonly deps: SemanticIndexBoundaryDeps;
  readonly fs: HoplonFsAdapter;
  readonly emitter: ReturnType<typeof createMemoryEmitter>;
  readonly calls: {
    readonly fsReads: string[];
    readonly resolveRefs: Array<{ dir: string; ref: string }>;
    readonly statusMatrixDirs: string[];
  };
} {
  const baseFs = createMemFsAdapter();
  const calls = {
    fsReads: [] as string[],
    resolveRefs: [] as Array<{ dir: string; ref: string }>,
    statusMatrixDirs: [] as string[],
  };
  const fs: HoplonFsAdapter = {
    ...baseFs,
    async read(path) {
      calls.fsReads.push(path);
      return baseFs.read(path);
    },
    async stat(path) {
      if (path === options.statFailurePath) {
        throw new AdapterError(
          {
            kind: 'fs_read_failed',
            engineId: 'adapter',
            correlationId: 'adapter',
            cause: new ValidationError(
              {
                kind: 'path_traversal',
                engineId: 'adapter',
                correlationId: 'adapter',
              },
              'symlink escape',
            ),
          },
          'stat failed',
        );
      }
      return baseFs.stat(path);
    },
  };
  const emitter = createMemoryEmitter();
  const versioning = createVersioningStub({
    calls,
    matrix: options.matrix ?? [],
    headOid: options.headOid ?? 'head-oid',
  });
  return {
    deps: { fs, versioning, emitter, engineId: 'test-engine', root: '/' },
    fs,
    emitter,
    calls,
  };
}

function createVersioningStub(args: {
  readonly calls: {
    readonly resolveRefs: Array<{ dir: string; ref: string }>;
    readonly statusMatrixDirs: string[];
  };
  readonly matrix: Array<[path: string, head: number, workdir: number, stage: number]>;
  readonly headOid: string;
}): VersioningAdapter {
  return {
    async init(): Promise<void> {},
    async add(): Promise<void> {},
    async remove(): Promise<void> {},
    async commit(): Promise<{ sha: string }> {
      return { sha: args.headOid };
    },
    async checkout(): Promise<void> {},
    async statusMatrix(dir) {
      args.calls.statusMatrixDirs.push(dir);
      return args.matrix;
    },
    async resolveRef(dir, ref) {
      args.calls.resolveRefs.push({ dir, ref });
      return args.headOid;
    },
    async push(): Promise<void> {},
    async fetch(): Promise<void> {},
    async readBlob(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async diffSnapshotFiles() {
      return [];
    },
    async changedFilesBetweenRefs() {
      return [];
    },
    async readCommitInfo() {
      return {
        oid: args.headOid,
        parentOids: [],
        treeOid: 'tree-oid',
        committerTimestamp: 0,
        authorTimestamp: 0,
        messageFirstLine: 'stub',
      };
    },
    async readLineProvenance() {
      return {
        commitId: args.headOid,
        parentOids: [],
        authorName: 'stub',
        authorTimestamp: 0,
        committerTimestamp: 0,
        messageFirstLine: 'stub',
        lineRange: { startLine: 1, endLine: 1 },
        provenanceKind: 'line_changed' as const,
      };
    },
  };
}

function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
