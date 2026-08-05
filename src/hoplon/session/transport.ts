/**
 * Public transport-agnostic dispatcher facade for packaged session operations.
 */
import {
  createSessionConvenienceHandlers,
} from './transportConvenienceHandlers.js';
import { createSessionCoreHandlers } from './transportCoreHandlers.js';
import { createSessionEvidenceHandlers } from './transportEvidenceHandlers.js';
import type {
  SessionTransportDispatcher,
  SessionTransportDispatcherOptions,
} from './transportDispatcherTypes.js';

export {
  SessionTransportError,
  type SessionTransportErrorKind,
} from './transportSupport.js';
export type {
  SessionTransportDispatcher,
  SessionTransportDispatcherOptions,
} from './transportDispatcherTypes.js';
export {
  encodeQuickEditResultForTransport,
} from './transportQuickEditResult.js';

export function createSessionTransportDispatcher(
  opts: SessionTransportDispatcherOptions,
): SessionTransportDispatcher {
  return {
    ...createSessionCoreHandlers(opts.registry),
    ...createSessionEvidenceHandlers(opts.registry),
    ...createSessionConvenienceHandlers(opts.registry),
  };
}
