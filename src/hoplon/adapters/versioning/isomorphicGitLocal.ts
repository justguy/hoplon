import * as git from 'isomorphic-git';
import { AdapterError } from '../../contracts/errors.js';
import type { HoplonFsAdapter } from '../fs.js';
import type { VersioningAdapter } from '../versioning.js';
import type { IsomorphicGitFsShim } from './fsShim.js';

type LocalOperations = Pick<
  VersioningAdapter,
  'init' | 'add' | 'remove' | 'clearIndex' | 'commit' | 'checkout' |
  'statusMatrix' | 'resolveRef' | 'readBlob'
>;

const ERROR_CONTEXT = { engineId: 'adapter', correlationId: 'adapter' } as const;
const COMMITTER = { name: 'hoplon-engine', email: 'noreply@hoplon.local' };

function wrap(kind: 'git_commit_failed' | 'git_checkout_failed' | 'git_read_failed', cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({ kind, ...ERROR_CONTEXT, cause }, message);
}

export function createLocalGitOperations(
  fs: IsomorphicGitFsShim,
  adapterFs: HoplonFsAdapter,
): LocalOperations {
  return {
    async init(dir: string): Promise<void> {
      try {
        await git.init({ fs, dir, defaultBranch: 'main' });
      } catch (error) {
        wrap('git_commit_failed', error, `git.init failed at '${dir}'`);
      }
    },

    async add(dir: string, paths: string[]): Promise<void> {
      try {
        for (const filepath of paths) await git.add({ fs, dir, filepath });
      } catch (error) {
        wrap('git_commit_failed', error, `git.add failed at '${dir}'`);
      }
    },

    async remove(dir: string, paths: string[]): Promise<void> {
      try {
        const relativeDir = dir.startsWith('/') ? dir.slice(1) : dir;
        for (const filepath of paths) {
          const adapterPath = relativeDir.length > 0 ? `${relativeDir}/${filepath}` : filepath;
          const stat = await adapterFs.stat(adapterPath);
          if (!stat.exists) continue;
          await git.remove({ fs, dir, filepath });
          await adapterFs.remove(adapterPath);
        }
      } catch (error) {
        wrap('git_commit_failed', error, `git.remove failed at '${dir}'`);
      }
    },

    async clearIndex(dir: string): Promise<void> {
      try {
        const staged = await git.listFiles({ fs, dir });
        for (const filepath of staged) await git.remove({ fs, dir, filepath });
      } catch (error) {
        wrap('git_commit_failed', error, `git.clearIndex failed at '${dir}'`);
      }
    },

    async commit(
      dir: string,
      message: string,
      options?: { committer?: { timestamp?: number } },
    ): Promise<{ sha: string }> {
      try {
        const pinnedTimestamp = options?.committer?.timestamp;
        const identity = pinnedTimestamp === undefined
          ? COMMITTER
          : { ...COMMITTER, timestamp: pinnedTimestamp, timezoneOffset: 0 };
        const sha = await git.commit({
          fs,
          dir,
          message,
          author: identity,
          committer: identity,
        });
        return { sha };
      } catch (error) {
        wrap('git_commit_failed', error, `git.commit failed at '${dir}'`);
      }
    },

    async checkout(dir: string, ref: string, paths?: string[]): Promise<void> {
      try {
        if (paths !== undefined) await git.checkout({ fs, dir, ref, filepaths: paths, force: true });
        else await git.checkout({ fs, dir, ref, force: true });
      } catch (error) {
        wrap('git_checkout_failed', error, `git.checkout failed at '${dir}' ref='${ref}'`);
      }
    },

    async statusMatrix(dir: string) {
      try {
        const matrix = await git.statusMatrix({ fs, dir });
        return matrix as Array<[string, number, number, number]>;
      } catch (error) {
        wrap('git_commit_failed', error, `git.statusMatrix failed at '${dir}'`);
      }
    },

    async resolveRef(dir: string, ref: string): Promise<string> {
      try {
        return await git.resolveRef({ fs, dir, ref });
      } catch (error) {
        wrap('git_commit_failed', error, `git.resolveRef failed at '${dir}' ref='${ref}'`);
      }
    },

    async readBlob(dir: string, ref: string, filepath: string): Promise<Uint8Array> {
      try {
        const result = await git.readBlob({ fs, dir, oid: ref, filepath });
        return new Uint8Array(result.blob);
      } catch (error) {
        wrap('git_read_failed', error, `git.readBlob failed at '${dir}' ref='${ref}' filepath='${filepath}'`);
      }
    },
  };
}
