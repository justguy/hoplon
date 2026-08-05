import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { AdapterError, ValidationError } from '../../../src/hoplon/contracts/errors.js';

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function writeCommit(
  fs: ReturnType<typeof createMemFsAdapter>,
  dir: string,
  path: string,
  text: string,
  message: string,
  timestamp: number,
): Promise<string> {
  const versioning = createIsomorphicGitVersioning({ fs });
  const dirRel = dir.startsWith('/') ? dir.slice(1) : dir;
  await fs.write(`${dirRel}/${path}`, enc(text));
  await versioning.add(dir, [path]);
  const { sha } = await versioning.commit(dir, message, {
    committer: { timestamp },
  });
  return sha;
}

describe('t-125 versioning adapter line provenance', () => {
  it('returns the commit that last changed the requested line range', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    await writeCommit(fs, '/repo', 'src/foo.ts', 'one\ntwo\n', 'first', 1000);
    const changed = await writeCommit(
      fs,
      '/repo',
      'src/foo.ts',
      'one\nTWO\n',
      'change target line\nbody ignored',
      2000,
    );
    const unrelated = await writeCommit(
      fs,
      '/repo',
      'src/foo.ts',
      'one\nTWO\nthree\n',
      'change other line',
      3000,
    );

    const result = await versioning.readLineProvenance({
      dir: '/repo',
      ref: unrelated,
      filepath: 'src/foo.ts',
      lineRange: { startLine: 2, endLine: 2 },
    });

    expect(result.commitId).toBe(changed);
    expect(result.provenanceKind).toBe('line_changed');
    expect(result.authorName).toBe('hoplon-engine');
    expect(result.authorTimestamp).toBe(2000);
    expect(result.messageFirstLine).toBe('change target line');
  });

  it('does not misattribute provenance to later line-number drift above the target', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    await writeCommit(fs, '/repo', 'src/foo.ts', 'one\ntwo\n', 'first', 1000);
    const changed = await writeCommit(
      fs,
      '/repo',
      'src/foo.ts',
      'one\nTWO\n',
      'change target line',
      2000,
    );
    const shifted = await writeCommit(
      fs,
      '/repo',
      'src/foo.ts',
      'zero\none\nTWO\n',
      'insert above target',
      3000,
    );

    const result = await versioning.readLineProvenance({
      dir: '/repo',
      ref: shifted,
      filepath: 'src/foo.ts',
      lineRange: { startLine: 3, endLine: 3 },
    });

    expect(result.commitId).toBe(changed);
    expect(result.messageFirstLine).toBe('change target line');
  });

  it('treats current-path rename history as a bounded file-added provenance', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    await writeCommit(fs, '/repo', 'src/old.ts', 'same\n', 'old path', 1000);
    const renamed = await writeCommit(fs, '/repo', 'src/new.ts', 'same\n', 'new path', 2000);

    const result = await versioning.readLineProvenance({
      dir: '/repo',
      ref: renamed,
      filepath: 'src/new.ts',
      lineRange: { startLine: 1, endLine: 1 },
    });

    expect(result.commitId).toBe(renamed);
    expect(result.provenanceKind).toBe('file_added_at_path');
  });

  it('fails closed for deleted or out-of-scope history inputs', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    await versioning.init('/repo');
    const first = await writeCommit(fs, '/repo', 'src/foo.ts', 'one\n', 'first', 1000);

    await expect(
      versioning.readLineProvenance({
        dir: '/repo',
        ref: first,
        filepath: 'src/missing.ts',
        lineRange: { startLine: 1, endLine: 1 },
      }),
    ).rejects.toBeInstanceOf(AdapterError);

    await expect(
      versioning.readLineProvenance({
        dir: '/repo',
        ref: 'HEAD',
        filepath: 'src/foo.ts',
        lineRange: { startLine: 1, endLine: 1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
