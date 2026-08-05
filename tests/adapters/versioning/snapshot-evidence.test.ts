/**
 * tests/adapters/versioning/snapshot-evidence.test.ts — t-081 proof for the
 * `diffSnapshotFiles` and `readCommitInfo` adapter primitives.
 *
 * All tests are fully in-process (memfs + isomorphic-git); no real network,
 * no host git binary. The two primitives are the sole Git-facing surface
 * the session-level evidence composer can call into, so the adapter-level
 * scope enforcement here is load-bearing.
 */

import { describe, it, expect } from 'vitest';
import * as git from 'isomorphic-git';

import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createFsShim } from '../../../src/hoplon/adapters/versioning/fsShim.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import {
  AdapterError,
  ValidationError,
} from '../../../src/hoplon/contracts/errors.js';
import type { HoplonFsAdapter } from '../../../src/hoplon/adapters/fs.js';

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function dec(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder('utf-8').decode(bytes);
}

async function buildRepoWithTwoCommits(
  fs: HoplonFsAdapter,
  dir: string,
): Promise<{ firstSha: string; secondSha: string }> {
  const versioning = createIsomorphicGitVersioning({ fs });
  await versioning.init(dir);
  const dirRel = dir.startsWith('/') ? dir.slice(1) : dir;

  // Commit 1: src/foo.ts = "one\n"
  await fs.write(`${dirRel}/src/foo.ts`, enc('one\n'));
  await versioning.add(dir, ['src/foo.ts']);
  const { sha: firstSha } = await versioning.commit(dir, 'first', {
    committer: { timestamp: 1000 },
  });

  // Commit 2: src/foo.ts = "one\ntwo\n"; src/bar.ts = "new\n"
  await fs.write(`${dirRel}/src/foo.ts`, enc('one\ntwo\n'));
  await fs.write(`${dirRel}/src/bar.ts`, enc('new\n'));
  await versioning.add(dir, ['src/foo.ts', 'src/bar.ts']);
  const { sha: secondSha } = await versioning.commit(dir, 'second line\nplus body', {
    committer: { timestamp: 2000 },
  });

  return { firstSha, secondSha };
}

describe('t-081 versioning adapter — diffSnapshotFiles', () => {
  it('returns before/after bytes for a modified file across two commits', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const rows = await versioning.diffSnapshotFiles({
      dir: '/repo',
      fromRef: firstSha,
      toRef: secondSha,
      filepaths: ['src/foo.ts'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.filepath).toBe('src/foo.ts');
    expect(dec(rows[0]!.beforeBytes)).toBe('one\n');
    expect(dec(rows[0]!.afterBytes)).toBe('one\ntwo\n');
  });

  it('reports added file (null before, real after) when fromRef predates the file', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const rows = await versioning.diffSnapshotFiles({
      dir: '/repo',
      fromRef: firstSha,
      toRef: secondSha,
      filepaths: ['src/bar.ts'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beforeBytes).toBeNull();
    expect(dec(rows[0]!.afterBytes)).toBe('new\n');
  });

  it('reports null/real pair when toRef is null (snapshot-vs-live composer precondition)', async () => {
    const fs = createMemFsAdapter();
    const { secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const rows = await versioning.diffSnapshotFiles({
      dir: '/repo',
      fromRef: secondSha,
      toRef: null,
      filepaths: ['src/foo.ts'],
    });
    expect(rows).toHaveLength(1);
    expect(dec(rows[0]!.beforeBytes)).toBe('one\ntwo\n');
    expect(rows[0]!.afterBytes).toBeNull();
  });

  it('refuses a branch name as fromRef with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const { secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: 'main',
        toRef: secondSha,
        filepaths: ['src/foo.ts'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('invalid_scope');
    expect((err as ValidationError).message).toMatch(/fromRef/);
  });

  it('refuses HEAD as toRef with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const { firstSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: firstSha,
        toRef: 'HEAD',
        filepaths: ['src/foo.ts'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('invalid_scope');
    expect((err as ValidationError).message).toMatch(/toRef/);
  });

  it('refuses a sha256:<hex> composite ID with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });
    const composite = `sha256:${secondSha.padEnd(64, '0')}`;

    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: firstSha,
        toRef: composite,
        filepaths: ['src/foo.ts'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('invalid_scope');
  });

  it('refuses empty filepaths list with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: firstSha,
        toRef: secondSha,
        filepaths: [],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('invalid_scope');
  });

  it('refuses both sides null with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: null,
        toRef: null,
        filepaths: ['src/foo.ts'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('invalid_scope');
  });

  it('refuses absolute / parent-traversal filepaths with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    for (const bad of ['/abs/path.ts', 'src/../../escape.ts', '']) {
      const err = await versioning
        .diffSnapshotFiles({
          dir: '/repo',
          fromRef: firstSha,
          toRef: secondSha,
          filepaths: [bad],
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).kind).toBe('invalid_scope');
    }
  });

  it('raises AdapterError git_read_failed for an unknown commit SHA', async () => {
    const fs = createMemFsAdapter();
    const { firstSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });
    const fakeSha = 'f'.repeat(40);

    const err = await versioning
      .diffSnapshotFiles({
        dir: '/repo',
        fromRef: firstSha,
        toRef: fakeSha,
        filepaths: ['src/foo.ts'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('git_read_failed');
  });
});

describe('t-081 versioning adapter — readCommitInfo', () => {
  it('returns a narrow commit-metadata subset for a committed SHA', async () => {
    const fs = createMemFsAdapter();
    const { firstSha, secondSha } = await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const info = await versioning.readCommitInfo({ dir: '/repo', ref: secondSha });
    expect(info.oid).toBe(secondSha);
    expect(info.parentOids).toEqual([firstSha]);
    expect(info.committerTimestamp).toBe(2000);
    expect(info.authorTimestamp).toBe(2000);
    // message first line only — multi-line body is clipped
    expect(info.messageFirstLine).toBe('second line');
    // tree oid is a 40-char hex; the exact tree SHA is deterministic for memfs
    expect(info.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses non-SHA refs with ValidationError invalid_scope', async () => {
    const fs = createMemFsAdapter();
    await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    for (const bad of ['HEAD', 'main', 'refs/heads/main', 'f'.repeat(39), 'F'.repeat(40)]) {
      const err = await versioning
        .readCommitInfo({ dir: '/repo', ref: bad })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).kind).toBe('invalid_scope');
    }
  });

  it('raises AdapterError git_read_failed for an unknown SHA', async () => {
    const fs = createMemFsAdapter();
    await buildRepoWithTwoCommits(fs, '/repo');
    const versioning = createIsomorphicGitVersioning({ fs });

    const err = await versioning
      .readCommitInfo({ dir: '/repo', ref: '0'.repeat(40) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('git_read_failed');
  });

  it('does not touch push/fetch — round-trip is independent of the remote path (t-033 untouched)', async () => {
    // Regression guard: construct a versioning adapter with disableRemote:true
    // and confirm diffSnapshotFiles + readCommitInfo still work (they must
    // never route through push/fetch under the hood).
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs, disableRemote: true });
    await versioning.init('/repo');
    const dirRel = 'repo';
    await fs.write(`${dirRel}/src/a.ts`, enc('alpha\n'));
    await versioning.add('/repo', ['src/a.ts']);
    const { sha } = await versioning.commit('/repo', 'alpha', {
      committer: { timestamp: 42 },
    });

    const info = await versioning.readCommitInfo({ dir: '/repo', ref: sha });
    expect(info.oid).toBe(sha);

    const rows = await versioning.diffSnapshotFiles({
      dir: '/repo',
      fromRef: null,
      toRef: sha,
      filepaths: ['src/a.ts'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beforeBytes).toBeNull();
    expect(dec(rows[0]!.afterBytes)).toBe('alpha\n');

    // Sanity: the bare repo is still the adapter's only source of truth.
    const shim = createFsShim(fs);
    const headRef = await git.resolveRef({ fs: shim, dir: '/repo', ref: 'HEAD' });
    expect(headRef).toBe(sha);
  });
});
