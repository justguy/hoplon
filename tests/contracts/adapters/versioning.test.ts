/**
 * tests/contracts/adapters/versioning.test.ts
 *
 * Contract tests for createIsomorphicGitVersioning.
 * Zero disk I/O — all tests use createMemFsAdapter().
 *
 * 13 required tests per Slice C4 spec:
 *  1. init + add + commit cycle — returns a SHA (40-char hex)
 *  2. deterministic SHA for same content (git content-addressable property)
 *  3. checkout restores file
 *  4. path-scoped checkout — only listed paths restored
 *  5. statusMatrix reports modifications
 *  6. resolveRef on HEAD returns commit SHA
 *  7. push throws remote_not_supported
 *  8. fetch throws remote_not_supported
 *  9. committer identity is hard-coded (hoplon-engine / noreply@hoplon.local)
 * 10. process.env.GIT_AUTHOR_NAME override doesn't affect committer
 * 11. fs shim stat shape — isFile() is a function returning true (bug-prone area)
 * 12. symlink rejection — shim's symlink() throws AdapterError
 * 13. errors wrap underlying fs errors via AdapterError
 */

import { describe, it, expect } from 'vitest';
import * as git from 'isomorphic-git';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createFsShim } from '../../../src/hoplon/adapters/versioning/fsShim.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { AdapterError, EngineError } from '../../../src/hoplon/contracts/errors.js';
import type { HoplonFsAdapter } from '../../../src/hoplon/adapters/fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a UTF-8 file via the fs adapter. */
async function writeFile(adapter: HoplonFsAdapter, path: string, content: string): Promise<void> {
  await adapter.write(path, new TextEncoder().encode(content));
}

/** Read a UTF-8 file via the fs adapter. */
async function readFile(adapter: HoplonFsAdapter, path: string): Promise<string> {
  const bytes = await adapter.read(path);
  return new TextDecoder().decode(bytes);
}

/** Build a fresh versioning adapter + mem fs adapter, init the repo. */
async function initRepo(dir = '/repo') {
  const fsAdapter = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
  await versioning.init(dir);
  return { fsAdapter, versioning };
}

// ---------------------------------------------------------------------------
// 1. init + add + commit cycle
// ---------------------------------------------------------------------------

describe('C4 — VersioningAdapter (isomorphicGit)', () => {
  it('1. init + add + commit cycle returns a 40-char hex SHA', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/hello.txt', 'hello world');
    await versioning.add('/repo', ['hello.txt']);
    const result = await versioning.commit('/repo', 'initial commit');

    expect(typeof result.sha).toBe('string');
    expect(result.sha).toHaveLength(40);
    expect(/^[0-9a-f]{40}$/.test(result.sha)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Deterministic SHA for same content
  // -------------------------------------------------------------------------
  it('2. same content + message + committer produces the same SHA twice', async () => {
    // Build two independent repos with identical inputs and assert identical SHAs.
    // This proves content-addressable property (H1-adjacent).
    // Timestamp is pinned via CF2's committer.timestamp option so the SHA is
    // deterministic regardless of wall-clock spacing between the two calls.
    async function buildSha(): Promise<string> {
      const fsAdapter = createMemFsAdapter();
      const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
      await versioning.init('/repo');
      await writeFile(fsAdapter, '/repo/file.txt', 'deterministic content');
      await versioning.add('/repo', ['file.txt']);
      const { sha } = await versioning.commit('/repo', 'deterministic commit', {
        committer: { timestamp: 0 },
      });
      return sha;
    }

    const sha1 = await buildSha();
    const sha2 = await buildSha();
    expect(sha1).toBe(sha2);
    expect(sha1).toHaveLength(40);
  });

  // -------------------------------------------------------------------------
  // 3. checkout restores file
  // -------------------------------------------------------------------------
  it('3. checkout after modification restores original content', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/file.txt', 'original');
    await versioning.add('/repo', ['file.txt']);
    const { sha } = await versioning.commit('/repo', 'v1');

    // Modify the file
    await writeFile(fsAdapter, '/repo/file.txt', 'modified');
    const modified = await readFile(fsAdapter, '/repo/file.txt');
    expect(modified).toBe('modified');

    // Checkout the original ref
    await versioning.checkout('/repo', sha);

    const restored = await readFile(fsAdapter, '/repo/file.txt');
    expect(restored).toBe('original');
  });

  // -------------------------------------------------------------------------
  // 4. Path-scoped checkout
  // -------------------------------------------------------------------------
  it('4. path-scoped checkout restores only the listed path', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/a.txt', 'content-a');
    await writeFile(fsAdapter, '/repo/b.txt', 'content-b');
    await versioning.add('/repo', ['a.txt', 'b.txt']);
    const { sha } = await versioning.commit('/repo', 'both files');

    // Modify both files
    await writeFile(fsAdapter, '/repo/a.txt', 'modified-a');
    await writeFile(fsAdapter, '/repo/b.txt', 'modified-b');

    // Checkout only a.txt
    await versioning.checkout('/repo', sha, ['a.txt']);

    const aContent = await readFile(fsAdapter, '/repo/a.txt');
    const bContent = await readFile(fsAdapter, '/repo/b.txt');

    expect(aContent).toBe('content-a');  // restored
    expect(bContent).toBe('modified-b'); // still modified
  });

  it('4b. remove stages a deletion so the next commit no longer contains the file', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/a.txt', 'content-a');
    await versioning.add('/repo', ['a.txt']);
    await versioning.commit('/repo', 'add a.txt');

    await versioning.remove('/repo', ['a.txt']);
    const { sha } = await versioning.commit('/repo', 'remove a.txt');

    const stat = await fsAdapter.stat('/repo/a.txt');
    expect(stat.exists).toBe(false);
    await expect(versioning.readBlob('/repo', sha, 'a.txt')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdapterError && err.kind === 'git_read_failed',
    );
  });

  // -------------------------------------------------------------------------
  // 5. statusMatrix reports modifications
  // -------------------------------------------------------------------------
  it('5. statusMatrix reports a modification after a file is changed', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/tracked.txt', 'v1');
    await versioning.add('/repo', ['tracked.txt']);
    await versioning.commit('/repo', 'initial');

    // Modify the file without staging
    await writeFile(fsAdapter, '/repo/tracked.txt', 'v2');

    const matrix = await versioning.statusMatrix('/repo');

    // Find the row for tracked.txt
    const row = matrix.find(([p]) => p === 'tracked.txt');
    expect(row).toBeDefined();

    // Per isomorphic-git statusMatrix: [path, HEAD, workdir, stage]
    // HEAD=1 (present), workdir=2 (modified), stage=1 (unchanged from HEAD)
    // means the file was modified in workdir but not staged.
    const [, head, workdir, stage] = row!;
    expect(head).toBe(1);    // file in HEAD
    expect(workdir).toBe(2); // workdir differs from HEAD
    expect(stage).toBe(1);   // stage == HEAD (not staged)
  });

  // -------------------------------------------------------------------------
  // 6. resolveRef on HEAD
  // -------------------------------------------------------------------------
  it('6. resolveRef("HEAD") returns the commit SHA after a commit', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/f.txt', 'data');
    await versioning.add('/repo', ['f.txt']);
    const { sha } = await versioning.commit('/repo', 'commit for ref test');

    const resolved = await versioning.resolveRef('/repo', 'HEAD');
    expect(resolved).toBe(sha);
  });

  it('6b. changedFilesBetweenRefs reports add/delete/modify changes without checkout', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/a.txt', 'a-v1');
    await writeFile(fsAdapter, '/repo/rename-old.txt', 'rename-body');
    await versioning.add('/repo', ['a.txt', 'rename-old.txt']);
    const { sha: fromRef } = await versioning.commit('/repo', 'base', {
      committer: { timestamp: 0 },
    });

    await writeFile(fsAdapter, '/repo/a.txt', 'a-v2');
    await writeFile(fsAdapter, '/repo/added.txt', 'new');
    await writeFile(fsAdapter, '/repo/rename-new.txt', 'rename-body');
    await versioning.add('/repo', ['a.txt', 'added.txt', 'rename-new.txt']);
    await versioning.remove('/repo', ['rename-old.txt']);
    const { sha: toRef } = await versioning.commit('/repo', 'changed', {
      committer: { timestamp: 1 },
    });

    const changed = await versioning.changedFilesBetweenRefs({
      dir: '/repo',
      fromRef,
      toRef,
    });

    expect(changed).toEqual([
      { filepath: 'a.txt', changeKind: 'modified' },
      { filepath: 'added.txt', changeKind: 'added' },
      { filepath: 'rename-new.txt', changeKind: 'added' },
      { filepath: 'rename-old.txt', changeKind: 'deleted' },
    ]);
    expect(await readFile(fsAdapter, '/repo/a.txt')).toBe('a-v2');
  });

  it('6c. changedFilesBetweenRefs rejects non-SHA refs before tree walking', async () => {
    const { versioning } = await initRepo();
    await expect(
      versioning.changedFilesBetweenRefs({
        dir: '/repo',
        fromRef: 'HEAD',
        toRef: 'also-not-a-sha',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        'kind' in err &&
        err.kind === 'invalid_scope',
    );
  });

  it('6d. changedFilesBetweenRefs classifies missing commit objects as git_read_failed', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/a.txt', 'a-v1');
    await versioning.add('/repo', ['a.txt']);
    const { sha: fromRef } = await versioning.commit('/repo', 'base');

    await expect(
      versioning.changedFilesBetweenRefs({
        dir: '/repo',
        fromRef,
        toRef: '1111111111111111111111111111111111111111',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        'kind' in err &&
        err.kind === 'git_read_failed',
    );
  });

  // -------------------------------------------------------------------------
  // 7. push with disableRemote:true throws remote_not_supported
  // -------------------------------------------------------------------------
  it('7. push throws EngineError with kind remote_not_supported when disableRemote:true', async () => {
    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, disableRemote: true });
    await versioning.init('/repo');
    await expect(
      versioning.push({ repoDir: '/repo', remote: 'https://example.com/repo.git', ref: 'main' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EngineError && err.kind === 'remote_not_supported',
    );
  });

  // -------------------------------------------------------------------------
  // 8. fetch with disableRemote:true throws remote_not_supported
  // -------------------------------------------------------------------------
  it('8. fetch throws EngineError with kind remote_not_supported when disableRemote:true', async () => {
    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, disableRemote: true });
    await versioning.init('/repo');
    await expect(
      versioning.fetch({ repoDir: '/repo', remote: 'https://example.com/repo.git', ref: 'main' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EngineError && err.kind === 'remote_not_supported',
    );
  });

  // -------------------------------------------------------------------------
  // 9. Committer identity is hard-coded
  // -------------------------------------------------------------------------
  it('9. commit author and committer are hard-coded to hoplon-engine regardless of env', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/id-test.txt', 'identity');
    await versioning.add('/repo', ['id-test.txt']);
    const { sha } = await versioning.commit('/repo', 'identity test');

    const fsShim = createFsShim(fsAdapter);
    const commitObj = await git.readCommit({ fs: fsShim, dir: '/repo', oid: sha });
    expect(commitObj.commit.author.name).toBe('hoplon-engine');
    expect(commitObj.commit.author.email).toBe('noreply@hoplon.local');
    expect(commitObj.commit.committer.name).toBe('hoplon-engine');
    expect(commitObj.commit.committer.email).toBe('noreply@hoplon.local');
  });

  // -------------------------------------------------------------------------
  // 10. process.env.GIT_AUTHOR_NAME doesn't leak
  // -------------------------------------------------------------------------
  it('10. process.env.GIT_AUTHOR_NAME spy does not affect commit author', async () => {
    const originalAuthorName = process.env['GIT_AUTHOR_NAME'];
    const originalAuthorEmail = process.env['GIT_AUTHOR_EMAIL'];
    const originalCommitterName = process.env['GIT_COMMITTER_NAME'];

    process.env['GIT_AUTHOR_NAME'] = 'spy-author';
    process.env['GIT_AUTHOR_EMAIL'] = 'spy@example.com';
    process.env['GIT_COMMITTER_NAME'] = 'spy-committer';

    try {
      const { fsAdapter, versioning } = await initRepo();
      await writeFile(fsAdapter, '/repo/spy-test.txt', 'spy check');
      await versioning.add('/repo', ['spy-test.txt']);
      const { sha } = await versioning.commit('/repo', 'spy env test');

      const fsShim = createFsShim(fsAdapter);
      const commitObj = await git.readCommit({ fs: fsShim, dir: '/repo', oid: sha });
      expect(commitObj.commit.author.name).toBe('hoplon-engine');
      expect(commitObj.commit.author.email).toBe('noreply@hoplon.local');
      expect(commitObj.commit.committer.name).toBe('hoplon-engine');
    } finally {
      // Always restore env
      if (originalAuthorName === undefined) {
        delete process.env['GIT_AUTHOR_NAME'];
      } else {
        process.env['GIT_AUTHOR_NAME'] = originalAuthorName;
      }
      if (originalAuthorEmail === undefined) {
        delete process.env['GIT_AUTHOR_EMAIL'];
      } else {
        process.env['GIT_AUTHOR_EMAIL'] = originalAuthorEmail;
      }
      if (originalCommitterName === undefined) {
        delete process.env['GIT_COMMITTER_NAME'];
      } else {
        process.env['GIT_COMMITTER_NAME'] = originalCommitterName;
      }
    }
  });

  // -------------------------------------------------------------------------
  // 11. fs shim stat shape — isFile() must be a function, not a boolean
  // -------------------------------------------------------------------------
  it('11. fs shim stat returns object with isFile() as a method returning true for files', async () => {
    const fsAdapter = createMemFsAdapter();
    await fsAdapter.write('/some/file.txt', new TextEncoder().encode('content'));

    const shim = createFsShim(fsAdapter);
    const statResult = await shim.stat('/some/file.txt');

    // isFile must be a function (not a boolean property)
    expect(typeof statResult.isFile).toBe('function');
    expect(typeof statResult.isDirectory).toBe('function');
    expect(typeof statResult.isSymbolicLink).toBe('function');

    // calling them returns correct values
    expect(statResult.isFile()).toBe(true);
    expect(statResult.isDirectory()).toBe(false);
    expect(statResult.isSymbolicLink()).toBe(false);

    // size is a number
    expect(typeof statResult.size).toBe('number');
    expect(statResult.size).toBeGreaterThan(0);

    // mode is file mode
    expect(statResult.mode).toBe(0o100644);

    // timestamps are numbers (fabricated but valid)
    expect(typeof statResult.mtimeMs).toBe('number');
    expect(typeof statResult.ctimeMs).toBe('number');
  });

  it('11b. fs shim stat returns isDirectory() === true for directories', async () => {
    const fsAdapter = createMemFsAdapter();
    await fsAdapter.mkdir('/some/dir', { recursive: true });

    const shim = createFsShim(fsAdapter);
    const statResult = await shim.stat('/some/dir');

    expect(statResult.isDirectory()).toBe(true);
    expect(statResult.isFile()).toBe(false);
    expect(statResult.mode).toBe(0o40000);
  });

  it('11c. fs shim stat throws ENOENT-shaped error for missing paths', async () => {
    const fsAdapter = createMemFsAdapter();
    const shim = createFsShim(fsAdapter);

    const err = await shim.stat('/does/not/exist').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  // -------------------------------------------------------------------------
  // 12. Symlink rejection
  // -------------------------------------------------------------------------
  it('12. shim.symlink() throws AdapterError', async () => {
    const fsAdapter = createMemFsAdapter();
    const shim = createFsShim(fsAdapter);

    const err = await shim.symlink('/target', '/link').catch(e => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('fs_write_failed');
  });

  it('12b. shim.readlink() throws AdapterError', async () => {
    const fsAdapter = createMemFsAdapter();
    const shim = createFsShim(fsAdapter);

    const err = await shim.readlink('/any/path').catch(e => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('fs_read_failed');
  });

  // -------------------------------------------------------------------------
  // CF2-1. commit with pinned timestamp=0 stores epoch in commit object
  // -------------------------------------------------------------------------
  it('CF2-1. commit({ committer: { timestamp: 0 } }) stores timestamp=0 in git commit object', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/pinned.txt', 'pinned epoch content');
    await versioning.add('/repo', ['pinned.txt']);
    const { sha } = await versioning.commit('/repo', 'pinned epoch test', { committer: { timestamp: 0 } });

    const fsShim = createFsShim(fsAdapter);
    const commitObj = await git.readCommit({ fs: fsShim, dir: '/repo', oid: sha });
    expect(commitObj.commit.author.timestamp).toBe(0);
    expect(commitObj.commit.committer.timestamp).toBe(0);
  });

  // -------------------------------------------------------------------------
  // CF2-2. identical content + pinned timestamp → identical SHA across repos
  // -------------------------------------------------------------------------
  it('CF2-2. identical content + pinned timestamp produces identical commit SHA across independent repos', async () => {
    async function buildShaWithPinnedTs(): Promise<string> {
      const fsAdapter = createMemFsAdapter();
      const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
      await versioning.init('/repo');
      await writeFile(fsAdapter, '/repo/file.txt', 'deterministic content');
      await versioning.add('/repo', ['file.txt']);
      const { sha } = await versioning.commit('/repo', 'pinned commit', { committer: { timestamp: 0 } });
      return sha;
    }

    const sha1 = await buildShaWithPinnedTs();
    const sha2 = await buildShaWithPinnedTs();
    expect(sha1).toBe(sha2);
    expect(sha1).toHaveLength(40);
  });

  // -------------------------------------------------------------------------
  // CF2-3. without pinned timestamp (default), two commits at different real
  //        times produce different SHAs — confirming CF2 is necessary
  // -------------------------------------------------------------------------
  it('CF2-3. without pinned timestamp, commits at different real times MAY differ (confirms CF2 need)', async () => {
    // isomorphic-git's default timestamp is Math.floor(Date.now() / 1000).
    // Two commits made in the same second are identical; across seconds they differ.
    // We cannot reliably force a second boundary in a unit test, so we instead
    // confirm that passing explicit different timestamps produces different SHAs.
    // This is the exact scenario CF2 prevents.
    async function buildShaWithTs(timestamp: number): Promise<string> {
      const fsAdapter = createMemFsAdapter();
      const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
      await versioning.init('/repo');
      await writeFile(fsAdapter, '/repo/file.txt', 'same content');
      await versioning.add('/repo', ['file.txt']);
      const { sha } = await versioning.commit('/repo', 'same message', { committer: { timestamp } });
      return sha;
    }

    const shaEpoch = await buildShaWithTs(0);
    const shaLater = await buildShaWithTs(1000000);
    // Different timestamps → different commit SHAs
    expect(shaEpoch).not.toBe(shaLater);
  });

  // -------------------------------------------------------------------------
  // CF2-4. commit without options still works (backward compat — H19)
  // -------------------------------------------------------------------------
  it('CF2-4. commit without options argument still returns a valid SHA (backward compat)', async () => {
    const { fsAdapter, versioning } = await initRepo();
    await writeFile(fsAdapter, '/repo/compat.txt', 'backward compat');
    await versioning.add('/repo', ['compat.txt']);
    const { sha } = await versioning.commit('/repo', 'no options');

    expect(typeof sha).toBe('string');
    expect(sha).toHaveLength(40);
    // Timestamp should be close to now (not epoch 0)
    const fsShim = createFsShim(fsAdapter);
    const commitObj = await git.readCommit({ fs: fsShim, dir: '/repo', oid: sha });
    // Real timestamp should be a positive number (seconds since epoch, so ~1.7bn)
    expect(commitObj.commit.committer.timestamp).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 13. Errors wrap underlying fs errors
  // -------------------------------------------------------------------------
  it('13. underlying fs adapter errors surface as AdapterError from git operations', async () => {
    // Strategy: build a versioning adapter where the fs adapter always throws
    // an AdapterError on read. Calling add() will fail because isomorphic-git
    // tries to read the index file, which triggers our injected error.
    // The error should surface as an AdapterError (either the original or
    // a wrapped one).
    const fsAdapter = createMemFsAdapter();

    // First, init a repo on the base adapter so the directory structure exists.
    const baseVersioning = createIsomorphicGitVersioning({ fs: fsAdapter });
    await baseVersioning.init('/repo');
    await fsAdapter.write('/repo/file.txt', new TextEncoder().encode('content'));

    // Now create an adapter that fails on reads.
    const injectedError = new AdapterError(
      {
        kind: 'fs_read_failed',
        engineId: 'adapter',
        correlationId: 'adapter',
        cause: new Error('injected read failure'),
      },
      'injected read failure',
    );

    // stat/list/mkdir/write pass through; read always throws
    const failingReadAdapter: HoplonFsAdapter = {
      ...fsAdapter,
      read: async (_path: string) => {
        throw injectedError;
      },
    };

    const failingVersioning = createIsomorphicGitVersioning({ fs: failingReadAdapter });

    // git.add reads the index file; this should trigger our injected error
    const err = await failingVersioning.add('/repo', ['file.txt']).catch(e => e);

    // Should be an AdapterError (either the original propagated through,
    // or a wrapped one from the try/catch in add())
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toMatch(/^(fs_read_failed|git_commit_failed)$/);
  });
});
