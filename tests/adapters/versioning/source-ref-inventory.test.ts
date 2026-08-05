import { describe, expect, it } from 'vitest';
import * as git from 'isomorphic-git';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createFsShim } from '../../../src/hoplon/adapters/versioning/fsShim.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../../src/hoplon/adapters/fs.js';
import { AdapterError, ValidationError } from '../../../src/hoplon/contracts/errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function writeFile(
  fs: HoplonFsAdapter,
  path: string,
  content: string,
): Promise<void> {
  await fs.write(path, encoder.encode(content));
}

async function commitFile(
  fs: HoplonFsAdapter,
  dir: string,
  filepath: string,
  content: string,
  message: string,
): Promise<string> {
  const versioning = createIsomorphicGitVersioning({ fs });
  await writeFile(fs, `${dir}/${filepath}`, content);
  await versioning.add(dir, [filepath]);
  const { sha } = await versioning.commit(dir, message, {
    committer: { timestamp: 0 },
  });
  return sha;
}

describe('versioning source ref inventory primitives', () => {
  it('lists local branch aliases without collapsing refs that share a commit', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const sha = await commitFile(fs, '/repo', 'file.txt', 'same commit', 'initial');

    const shim = createFsShim(fs);
    await git.branch({
      fs: shim,
      dir: '/repo',
      ref: 'feature/alias',
      object: sha,
      checkout: false,
    });

    const refs = await versioning.listLocalBranches('/repo');
    expect(refs).toEqual([
      {
        kind: 'local_branch',
        name: 'feature/alias',
        fullRef: 'refs/heads/feature/alias',
        oid: sha,
      },
      {
        kind: 'local_branch',
        name: 'main',
        fullRef: 'refs/heads/main',
        oid: sha,
      },
    ]);
  });

  it('lists locally known remote-tracking branches without fetching', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const sha = await commitFile(fs, '/repo', 'remote.txt', 'remote known', 'initial');

    const shim = createFsShim(fs);
    await git.addRemote({
      fs: shim,
      dir: '/repo',
      remote: 'hoplon-origin',
      url: 'http://local.test/repo.git',
    });
    await git.writeRef({
      fs: shim,
      dir: '/repo',
      ref: 'refs/remotes/hoplon-origin/main',
      value: sha,
      force: true,
    });

    await expect(versioning.listRemoteTrackingBranches('/repo')).resolves.toEqual([
      {
        kind: 'remote_tracking_branch',
        name: 'hoplon-origin/main',
        fullRef: 'refs/remotes/hoplon-origin/main',
        remote: 'hoplon-origin',
        oid: sha,
      },
    ]);
  });

  it('resolves current and default branch through HEAD when available', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const sha = await commitFile(fs, '/repo', 'file.txt', 'content', 'initial');

    await expect(versioning.resolveCurrentBranch('/repo')).resolves.toEqual({
      name: 'main',
      fullRef: 'refs/heads/main',
      oid: sha,
    });
    await expect(versioning.resolveDefaultBranch('/repo')).resolves.toEqual({
      name: 'main',
      fullRef: 'refs/heads/main',
      oid: sha,
    });
  });

  it('does not confuse a feature checkout with the default branch', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const mainSha = await commitFile(fs, '/repo', 'file.txt', 'main', 'initial');

    const shim = createFsShim(fs);
    await git.branch({
      fs: shim,
      dir: '/repo',
      ref: 'feature/search',
      object: mainSha,
      checkout: false,
    });
    await versioning.checkout('/repo', 'feature/search');

    await expect(versioning.resolveCurrentBranch('/repo')).resolves.toEqual({
      name: 'feature/search',
      fullRef: 'refs/heads/feature/search',
      oid: mainSha,
    });
    await expect(versioning.resolveDefaultBranch('/repo')).resolves.toEqual({
      name: 'main',
      fullRef: 'refs/heads/main',
      oid: mainSha,
    });
  });

  it('lists files and returns blob identity at a commit or branch ref', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const firstSha = await commitFile(fs, '/repo', 'a.txt', 'first', 'first');
    await commitFile(fs, '/repo', 'nested/b.txt', 'second', 'second');

    await expect(versioning.listFilesAtRef('/repo', firstSha)).resolves.toEqual([
      { filepath: 'a.txt', oid: expect.any(String) },
    ]);

    const branchFiles = await versioning.listFilesAtRef('/repo', 'main');
    expect(branchFiles).toEqual([
      { filepath: 'a.txt', oid: expect.any(String) },
      { filepath: 'nested/b.txt', oid: expect.any(String) },
    ]);
    const nested = branchFiles.find(row => row.filepath === 'nested/b.txt');
    expect(nested).toBeDefined();

    const blob = await versioning.readBlobAtRef('/repo', 'main', 'nested/b.txt');
    expect(decoder.decode(blob.bytes)).toBe('second');
    expect(blob.oid).toBe(nested?.oid);
  });

  it('maps missing refs and invalid filepaths to typed errors', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');

    const missingRef = await versioning.listFilesAtRef('/repo', 'missing').catch(e => e);
    expect(missingRef).toBeInstanceOf(AdapterError);
    expect((missingRef as AdapterError).kind).toBe('git_read_failed');

    const invalidPath = await versioning
      .readBlobAtRef('/repo', 'HEAD', '/absolute.txt')
      .catch(e => e);
    expect(invalidPath).toBeInstanceOf(ValidationError);
    expect((invalidPath as ValidationError).kind).toBe('invalid_scope');
  });

  it('does not mutate checkout state or workdir while reading refs and blobs', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const sha = await commitFile(fs, '/repo', 'tracked.txt', 'committed', 'initial');
    await writeFile(fs, '/repo/tracked.txt', 'dirty workdir');

    const currentBefore = await versioning.resolveCurrentBranch('/repo');
    const statusBefore = await versioning.statusMatrix('/repo');

    await versioning.listLocalBranches('/repo');
    await versioning.listFilesAtRef('/repo', sha);
    await versioning.readBlobAtRef('/repo', sha, 'tracked.txt');
    await versioning.resolveDefaultBranch('/repo');

    const currentAfter = await versioning.resolveCurrentBranch('/repo');
    const statusAfter = await versioning.statusMatrix('/repo');
    const workdirBytes = await fs.read('/repo/tracked.txt');

    expect(currentAfter).toEqual(currentBefore);
    expect(statusAfter).toEqual(statusBefore);
    expect(decoder.decode(workdirBytes)).toBe('dirty workdir');
  });
});
