import * as git from 'isomorphic-git';
import type { HttpClient } from 'isomorphic-git';
import { AdapterError, EngineError } from '../../contracts/errors.js';
import type { GitRemoteCredentials, VersioningAdapter } from '../versioning.js';
import type { IsomorphicGitFsShim } from './fsShim.js';

type RemoteOperations = Pick<VersioningAdapter, 'push' | 'fetch'>;
const ERROR_CONTEXT = { engineId: 'adapter', correlationId: 'adapter' } as const;
let defaultHttp: HttpClient | undefined;

function buildOnAuth(credentials?: GitRemoteCredentials) {
  if (credentials === undefined) return undefined;
  const username = credentials.username ?? '';
  const password = credentials.password ?? '';
  return () => ({ username, password });
}

async function getDefaultHttp(): Promise<HttpClient> {
  if (defaultHttp !== undefined) return defaultHttp;
  const imported = await import('isomorphic-git/http/node');
  const candidate = imported as unknown as {
    request?: HttpClient['request'];
    default?: { request?: HttpClient['request'] };
  };
  const request = candidate.request ?? candidate.default?.request;
  if (typeof request !== 'function') {
    throw new AdapterError({
      kind: 'remote_push_failed',
      ...ERROR_CONTEXT,
      cause: 'could_not_load_default_http_client',
    }, 'Failed to load isomorphic-git/http/node');
  }
  defaultHttp = { request };
  return defaultHttp;
}

export function createRemoteGitOperations(
  fs: IsomorphicGitFsShim,
  opts: { http?: HttpClient; disableRemote?: boolean },
): RemoteOperations {
  function assertRemoteEnabled(method: 'push' | 'fetch', remote: string, ref: string): void {
    if (opts.disableRemote !== true) return;
    throw new EngineError({
      kind: 'remote_not_supported',
      ...ERROR_CONTEXT,
      cause: { method, remote, ref },
    }, `Remote ${method} is disabled (disableRemote: true)`);
  }

  return {
    async push(pushOpts): Promise<void> {
      assertRemoteEnabled('push', pushOpts.remote, pushOpts.ref);
      const http = opts.http ?? (await getDefaultHttp());
      try {
        await git.push({
          fs,
          http,
          dir: pushOpts.repoDir,
          url: pushOpts.remote,
          ref: pushOpts.ref,
          onAuth: buildOnAuth(pushOpts.credentials),
          onAuthFailure: () => ({ cancel: true }),
        });
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw new AdapterError({
          kind: 'remote_push_failed',
          ...ERROR_CONTEXT,
          cause: error,
        }, `git.push failed: remote='${pushOpts.remote}' ref='${pushOpts.ref}'`);
      }
    },

    async fetch(fetchOpts): Promise<void> {
      assertRemoteEnabled('fetch', fetchOpts.remote, fetchOpts.ref);
      const http = opts.http ?? (await getDefaultHttp());
      const syntheticRemoteName = 'hoplon-origin';
      try {
        await git.addRemote({
          fs,
          dir: fetchOpts.repoDir,
          remote: syntheticRemoteName,
          url: fetchOpts.remote,
          force: true,
        });
        await git.fetch({
          fs,
          http,
          dir: fetchOpts.repoDir,
          remote: syntheticRemoteName,
          ref: fetchOpts.ref,
          singleBranch: true,
          onAuth: buildOnAuth(fetchOpts.credentials),
          onAuthFailure: () => ({ cancel: true }),
        });
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw new AdapterError({
          kind: 'remote_fetch_failed',
          ...ERROR_CONTEXT,
          cause: error,
        }, `git.fetch failed: remote='${fetchOpts.remote}' ref='${fetchOpts.ref}'`);
      }
    },
  };
}
