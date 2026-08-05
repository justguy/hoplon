import { describe, expect, it } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { captureOriginalFileState } from '../../src/hoplon/session/applyEditsFileState.js';
import { gitBlobSha1 } from '../../src/hoplon/session/gitBlobHash.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

interface DriftHook {
  (file: string, statCallIndex: number): Promise<void> | void;
}

function wrapAdapterWithDrift(
  inner: HoplonFsAdapter,
  hook: DriftHook,
): HoplonFsAdapter {
  const statCallsByPath = new Map<string, number>();
  return {
    read: (path) => inner.read(path),
    list: (path) => inner.list(path),
    async stat(path) {
      const idx = statCallsByPath.get(path) ?? 0;
      statCallsByPath.set(path, idx + 1);
      if (idx === 1) {
        await hook(path, idx);
      }
      return inner.stat(path);
    },
    mkdir: (path, opts) => inner.mkdir(path, opts),
    remove: (path) => inner.remove(path),
    write: (path, content) => inner.write(path, content),
  };
}

async function advanceToSnapshotted(
  session: ReturnType<typeof createHoplonEditSession>,
): Promise<void> {
  await session.preflight();
  await session.createSnapshot();
}

describe('t-124 Git-compatible live-base hashing', () => {
  it('computes Git blob hashes for captured live-base bytes', async () => {
    const fs = createMemFsAdapter();
    const bytes = new TextEncoder().encode('hello\n');
    await fs.write('src/foo.ts', bytes);

    expect(gitBlobSha1(new Uint8Array())).toBe(
      'git-blob:sha1:e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    );
    expect(gitBlobSha1(bytes)).toBe(
      'git-blob:sha1:ce013625030ba8dba906f756967f9e9ca394464a',
    );

    const original = await captureOriginalFileState(fs, 'src/foo.ts');
    expect(original.liveBaseHash).toBe(gitBlobSha1(bytes));
  });

  it('detects same-length byte drift through the live-base blob hash', async () => {
    const inner = createMemFsAdapter();
    const baseline = 'export const x = 1;\n';
    await inner.write('src/foo.ts', new TextEncoder().encode(baseline));

    const fs = wrapAdapterWithDrift(inner, async (file) => {
      if (file === 'src/foo.ts') {
        await inner.write(
          'src/foo.ts',
          new TextEncoder().encode('export const x = 9;\n'),
        );
      }
    });

    const engine = makeMockEngine();
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([{ file: 'src/foo.ts', content: 'export const x = 2;\n' }])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('stale_write');
    expect((err as SessionError).details?.driftKind).toBe('bytes_diverged');
    expect((err as SessionError).details?.byteLengthBefore).toBe(
      Buffer.byteLength(baseline, 'utf8'),
    );
    expect((err as SessionError).details?.byteLengthLive).toBe(
      Buffer.byteLength(baseline, 'utf8'),
    );
    expect(new TextDecoder().decode(await inner.read('src/foo.ts'))).toBe(
      'export const x = 9;\n',
    );
  });
});
