import type { SessionTransportDispatcher } from '../session/transport.js';
import type { HttpSessionOp } from '../transport/agentToolProfile.js';

export type SessionToolGuard = (
  args: Record<string, unknown>,
) => Promise<void>;

export type SessionToolGuardFor = (
  op: HttpSessionOp,
) => SessionToolGuard | undefined;

export interface SessionToolRegistryContext {
  dispatcher: SessionTransportDispatcher;
  guardFor: SessionToolGuardFor;
}
