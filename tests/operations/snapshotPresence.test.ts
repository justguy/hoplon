/**
 * tests/operations/snapshotPresence.test.ts — mcr-008 presence-evidence seam.
 *
 * Unit coverage for the exported helpers consumed by revertUncontracted and
 * by the session-audit workstream (post-snapshot uncontracted-file discovery):
 * getSnapshotPresence / wasPresentAtSnapshot / listPostSnapshotPaths /
 * listWorkspacePaths.
 */

import { describe, it, expect } from 'vitest';

import {
  getSnapshotPresence,
  listPostSnapshotPaths,
  listWorkspacePaths,
  normalizeWorkspacePath,
  wasPresentAtSnapshot,
} from '../../src/hoplon/operations/snapshotPresence.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('getSnapshotPresence', () => {
  it('maps a recorded listing to present-kind evidence with normalized paths', () => {
    const presence = getSnapshotPresence({ presencePaths: ['./src/a.ts', '/README.md'] });
    expect(presence.kind).toBe('present');
    expect(wasPresentAtSnapshot(presence, 'src/a.ts')).toBe('present');
    expect(wasPresentAtSnapshot(presence, 'README.md')).toBe('present');
    expect(wasPresentAtSnapshot(presence, 'src/new.ts')).toBe('absent');
  });

  it('maps null and absent presencePaths to missing-kind evidence', () => {
    expect(getSnapshotPresence({ presencePaths: null }).kind).toBe('missing');
    expect(getSnapshotPresence({}).kind).toBe('missing');
  });
});

describe('wasPresentAtSnapshot', () => {
  it('returns unknown (never absent) when evidence is missing — fail-safe', () => {
    const presence = getSnapshotPresence({ presencePaths: null });
    expect(wasPresentAtSnapshot(presence, 'README.md')).toBe('unknown');
  });

  it('normalizes probe paths before membership checks', () => {
    const presence = getSnapshotPresence({ presencePaths: ['src/a.ts'] });
    expect(wasPresentAtSnapshot(presence, './src/a.ts')).toBe('present');
    expect(wasPresentAtSnapshot(presence, '/src/a.ts')).toBe('present');
  });
});

describe('listPostSnapshotPaths', () => {
  it('reports exactly the paths created after the snapshot', () => {
    const presence = getSnapshotPresence({ presencePaths: ['src/a.ts', 'README.md'] });
    const result = listPostSnapshotPaths(presence, [
      'src/a.ts',
      'README.md',
      'src/smuggled.ts',
    ]);
    expect(result).toEqual({ status: 'known', postSnapshotPaths: ['src/smuggled.ts'] });
  });

  it('returns unknown when evidence is missing so callers cannot infer deletions', () => {
    const presence = getSnapshotPresence({ presencePaths: null });
    expect(listPostSnapshotPaths(presence, ['anything.ts'])).toEqual({ status: 'unknown' });
  });
});

describe('listWorkspacePaths', () => {
  it('lists all files recursively as sorted relative paths', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/b.ts', enc('b'));
    await fs.write('src/a.ts', enc('a'));
    await fs.write('README.md', enc('r'));
    await fs.write('.git/HEAD', enc('ref: refs/heads/main'));

    const paths = await listWorkspacePaths(fs);
    expect(paths).toEqual(['.git/HEAD', 'README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('prunes excluded subtrees (prefix match on whole segments)', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/a.ts', enc('a'));
    await fs.write('.hoplon/repo/src/a.ts', enc('copy'));
    await fs.write('.hoplon/repo.txt', enc('not the repo dir'));

    const paths = await listWorkspacePaths(fs, { excludePrefixes: ['.hoplon/repo'] });
    expect(paths).toEqual(['.hoplon/repo.txt', 'src/a.ts']);
  });
});

describe('normalizeWorkspacePath', () => {
  it('strips a single leading ./ or / prefix only', () => {
    expect(normalizeWorkspacePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeWorkspacePath('/src/a.ts')).toBe('src/a.ts');
    expect(normalizeWorkspacePath('src/a.ts')).toBe('src/a.ts');
  });
});
