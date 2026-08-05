import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsNative from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createNodeFsAdapter } from '../../../src/hoplon/adapters/fs/node.js';
import { AdapterError, ValidationError } from '../../../src/hoplon/contracts/errors.js';

describe('NodeFsAdapter symlink escape defense (t-114)', () => {
  let tmpRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsNative.mkdtemp(path.join(os.tmpdir(), 'hoplon-symlink-'));
    outsideRoot = await fsNative.mkdtemp(path.join(os.tmpdir(), 'hoplon-outside-'));
  });

  afterEach(async () => {
    await fsNative.rm(tmpRoot, { recursive: true, force: true });
    await fsNative.rm(outsideRoot, { recursive: true, force: true });
  });

  it('read through a symlink that resolves outside root throws path_traversal', async () => {
    await fsNative.writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await fsNative.symlink(
      path.join(outsideRoot, 'secret.txt'),
      path.join(tmpRoot, 'linked-secret.txt'),
    );
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    await expect(adapter.read('linked-secret.txt')).rejects.toSatisfy(
      isReadPathTraversal,
    );
  });

  it('list and stat through an escaping symlink directory throw path_traversal', async () => {
    await fsNative.writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await fsNative.symlink(outsideRoot, path.join(tmpRoot, 'linked-dir'));
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    await expect(adapter.list('linked-dir')).rejects.toSatisfy(
      isReadPathTraversal,
    );
    await expect(adapter.stat('linked-dir')).rejects.toSatisfy(
      isReadPathTraversal,
    );
  });

  it('write through an escaping symlink parent throws path_traversal', async () => {
    await fsNative.symlink(outsideRoot, path.join(tmpRoot, 'linked-dir'));
    const adapter = createNodeFsAdapter({ root: tmpRoot });
    await expect(
      adapter.write('linked-dir/created.txt', new TextEncoder().encode('nope\n')),
    ).rejects.toSatisfy(isWritePathTraversal);
    await expect(fsNative.stat(path.join(outsideRoot, 'created.txt'))).rejects
      .toMatchObject({ code: 'ENOENT' });
  });
});

function isReadPathTraversal(err: unknown): boolean {
  return isPathTraversal(err, 'fs_read_failed');
}

function isWritePathTraversal(err: unknown): boolean {
  return isPathTraversal(err, 'fs_write_failed');
}

function isPathTraversal(
  err: unknown,
  kind: 'fs_read_failed' | 'fs_write_failed',
): boolean {
  return (
    err instanceof AdapterError &&
    err.kind === kind &&
    err.cause instanceof ValidationError &&
    err.cause.kind === 'path_traversal'
  );
}
