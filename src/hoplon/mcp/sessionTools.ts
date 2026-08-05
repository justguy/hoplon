/** Packaged MCP session-tool registry composition. */

import type { SessionRegistry } from '../session/registry.js';
import { createSessionTransportDispatcher } from '../session/transport.js';
import type { HttpSessionOp } from '../transport/agentToolProfile.js';
import type { StrictEngagementGateDeps } from '../transport/strictEngagementGate.js';
import { enforceStrictSessionEngagement } from '../transport/strictSessionEngagement.js';
import type { SessionToolDefinition } from './sessionToolHelpers.js';
import type { SessionToolGuardFor } from './sessionToolRegistryTypes.js';
import { buildSessionCoreTools } from './sessionToolsCore.js';
import { buildSessionEvidenceTools } from './sessionToolsEvidence.js';

export interface SessionToolsOptions {
  registry: SessionRegistry;
  strictEngagementGate?: StrictEngagementGateDeps;
}

export function buildSessionToolRegistry(
  opts: SessionToolsOptions,
): SessionToolDefinition[] {
  const dispatcher = createSessionTransportDispatcher({ registry: opts.registry });
  const strictEngagementGate = opts.strictEngagementGate;
  const guardFor: SessionToolGuardFor = (op: HttpSessionOp) => {
    if (strictEngagementGate === undefined) return undefined;
    return (args: Record<string, unknown>) =>
      enforceStrictSessionEngagement({
        registry: opts.registry,
        gate: strictEngagementGate,
        op,
        rawBody: args,
      });
  };

  const context = { dispatcher, guardFor };
  return [
    ...buildSessionCoreTools(context),
    ...buildSessionEvidenceTools({
      ...context,
      registry: opts.registry,
      ...(strictEngagementGate !== undefined ? { strictEngagementGate } : {}),
    }),
  ];
}
