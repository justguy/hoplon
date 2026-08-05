import type { HoplonEngine } from '../engine/types.js';
import type { StrictEngagementGateDeps } from '../transport/strictEngagementGate.js';
import { buildAuditEngineTools } from './engineToolsAudit.js';
import { buildCoreEngineTools } from './engineToolsCore.js';
import { buildDiscoveryEngineTools } from './engineToolsDiscovery.js';
import { buildSemanticEngineTools } from './engineToolsSemantic.js';
import type { EngineToolDefinition } from './engineToolSupport.js';
import { buildUtilityEngineTools } from './engineToolsUtility.js';

/** Build the engine-backed registry in its established public tool order. */
export function buildEngineToolRegistry(
  engine: HoplonEngine,
  strictEngagementGate?: StrictEngagementGateDeps,
): EngineToolDefinition[] {
  return [
    ...buildCoreEngineTools(engine),
    ...buildAuditEngineTools(engine),
    ...buildUtilityEngineTools(engine, strictEngagementGate),
    ...buildDiscoveryEngineTools(engine, strictEngagementGate),
    ...buildSemanticEngineTools(engine, strictEngagementGate),
  ];
}
