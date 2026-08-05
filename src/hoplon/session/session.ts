/** Thin host-owned state machine over the ordered Hoplon self-edit loop. */

import { buildSessionFacade } from './sessionFacade.js';
import { createSessionRuntime } from './sessionRuntime.js';
import type {
  CreateHoplonEditSessionOptions,
  HoplonEditSession,
} from './types.js';

export function createHoplonEditSession(
  opts: CreateHoplonEditSessionOptions,
): HoplonEditSession {
  return buildSessionFacade(createSessionRuntime(opts));
}
