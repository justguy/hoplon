/** HTTP-backed HoplonEngine facade. */

import type { HoplonEngine } from '../../engine/types.js';
import { createRemoteAdvisoryMethods } from './clientAdvisoryMethods.js';
import {
  createRemoteClientContext,
} from './clientDispatch.js';
import type { FetchFn, RemoteClientResolvedOptions } from './clientDispatch.js';
import { createRemoteCoreMethods } from './clientCoreMethods.js';

export interface RemoteHoplonEngineOptions {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: FetchFn;
  engineId?: string;
}

export function createRemoteHoplonEngine(
  opts: RemoteHoplonEngineOptions,
): HoplonEngine {
  const resolved: RemoteClientResolvedOptions = {
    baseUrl: opts.baseUrl.replace(/\/$/, ''),
    engineId: opts.engineId ?? 'remote-client',
    authToken: opts.authToken,
    fetchImpl: opts.fetchImpl,
  };
  const client = createRemoteClientContext(resolved);
  return {
    ...createRemoteCoreMethods(client),
    ...createRemoteAdvisoryMethods(client),
  };
}
